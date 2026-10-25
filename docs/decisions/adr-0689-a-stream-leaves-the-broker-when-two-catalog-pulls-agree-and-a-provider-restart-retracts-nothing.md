---
id: D689
title: A stream leaves the broker when two catalog pulls agree, and an rtsp provider restart retracts nothing
status: accepted
date: 2026-09-30
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/catalog-absence.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker-manager.ts
  - packages/addon-provider-rtsp/src/rtsp-camera.ts
covers:
  - packages/system/src/kernel/moleculer/device-cap-proxy.ts
  - packages/types/src/device/base-device-provider.ts
---

## Context

D685 stopped Hikvision from retracting its streams in `removeDevice()`, because
that hook runs on every runner stop (`BaseDeviceProvider.onShutdown`
decommissions every device) and on every rebuild (`reloadDevice`,
`applyDerivedSpec`), not only on a delete. Its review left two pieces open.

1. **`addon-provider-rtsp` had the same shape.** `RtspCamera.removeDevice()`
   retracted every configured stream, so an rtsp runner restart tore down every
   broker, restreamer, recording writer and viewer of every rtsp camera for the
   length of the restart. The broker dials an rtsp camera's own url
   (`pull-rtsp`): the runner is not on the byte path.
2. **The catalog reconcile destroyed on one read (review L4).**
   `reconcileDeviceCatalog` retracted a provider stream after ONE pull that
   omitted it. A pull is a fallible read of another process: a provider
   mid-restart, a camera answering half of its channels. The retract destroys
   work. After D685 this was the only restart-driven teardown left for
   Hikvision.

Simply deleting the rtsp retract was not enough. Without it, every change to an
rtsp camera's streams reaches the broker only through the catalog reconcile.
Review asked whether an EMPTY catalog, which that reconcile ignores, could leave
a camera whose every stream was removed published and warm. For rtsp it cannot:
`streams` is `min(1)`, and a cleared settings form keeps the current streams.
The old code also folded a `null` answer into `[]`, which made "no provider
answered" indistinguishable from "the provider says none".

A first draft of this record counted an answered `[]` as an omission of every
stream, under the two-pull rule. That was withdrawn before merge. Providers
answer `[]` both for "not mine" (a misrouted deviceId) and for "don't know yet"
(a sleeping Reolink battery camera with no cache and no ledger, a Hikvision
reboot). Under D49, a read that ambiguous may not destroy work.

## Decision

**The catalog reconcile retracts a provider stream only when two successful
pulls, at least one reconcile interval (30 s) apart, both omit it.** This
mirrors D685's departed-device sweep and follows D49.

- One omission only MARKS the stream (`catalog-absence.ts`, pure). Pulls closer
  than 30 s to the mark count as one observation.
- A pull that lists the stream again unmarks it.
- Three kinds of pull decide nothing: a FAILED pull (throw or timeout), a
  pull that answered nothing (`null` / `undefined`), and an ANSWERED EMPTY
  catalog (`[]`).
  - None of them marks a stream, and none clears a mark. A mark survives all
    three, so the next pull that lists the device's streams can still confirm
    it.
  - The empty case is logged at DEBUG with `tags: { deviceId }`.
  - Removing a whole camera is the `DeviceUnregistered` path and D685's
    departed-device sweep, never an empty catalog.
- A mark is dropped when:
  - the stream is retracted by any path, so a stream re-published under the
    same id starts unmarked;
  - the camera is disabled, because no pulls run while it is disabled.
- Every step is logged with `tags: { deviceId }` and the `camStreamId`:
  - marked, at INFO;
  - unmarked, at INFO;
  - retracted, at WARN (`stream absent from two catalog pulls — retracted`).
- Broker-owned synthetics are never candidates, as before.

**`RtspCamera.removeDevice()` releases only its own resources** (the
reachability poll). Changes reach the broker this way:

- A delete: `DeviceUnregistered` → `handleDeviceRemoved`, backed by D685's
  departed-device sweep.
- A changed url: upserted by the next pull.
- A dropped stream: retracted by the rule above.
- A rebuild: re-registers the same catalog, so nothing is marked.

## Consequences

- An rtsp runner restart, deploy or crash no longer touches the brokers. Writers
  and viewers ride through it.
- A stream an operator removes from a camera leaves the broker 30–60 s after the
  edit, instead of on the next pull. The removed rtsp slot keeps dialling the
  camera for that window.
- Answered-`[]` providers behave as before: `[]` never retracts, marks or
  clears. The cost is that a camera whose provider truly reports zero streams
  keeps them published and warm until the camera is deleted or disabled, or
  until the broker restarts. Reolink does this for "camera reports no streams".
  This is accepted. No rtsp camera can reach that state, and no other provider
  can tell it apart from "don't know yet".
- `migrateDevice` leaves a window a few seconds long.
  - The migration SWAPS the two numbers, so both stay in the fleet listing.
  - Before the reload it calls `streamBroker.forgetDeviceHardware` for both
    ids, which retracts and purges them. The broker holds nothing for either
    number when the reload runs.
  - Between that forget and the reload, a poll can pull a number whose catalog
    provider is still the pre-reload instance. It republishes that camera's
    streams under the swapped number.
  - Before D689, the reload's `removeDevice` retracted them again. Now the
    reload's own `DeviceRegistered`-driven catalog pull corrects them: the same
    `stream-N` ids are upserted to the right urls, and an id that disappeared
    is retracted by the two-pull rule.
- Hikvision's D685 note, "a single transient pull still retracts", is closed.

## Enforcement

- `addon-pipeline/src/stream-broker/__tests__/catalog-absence-two-reads.spec.ts`
  runs through the real `StreamBrokerManager`. It checks that:
  - one omission keeps the stream, and a second omission 30 s later retracts it
    and logs it;
  - a reappearance unmarks the stream;
  - failed pulls and `null` answers never retract;
  - two pulls closer than 30 s count as one;
  - answered `[]` pulls never retract, and between two omitting pulls an
    empty, a failed or a null pull neither marks nor clears;
  - a disabled interval forgets the marks;
  - a stream retracted another way and re-published starts unmarked.

  Each gate was disarmed and went red.
- `addon-provider-rtsp/src/__tests__/rtsp-e2e.spec.ts` §9 runs through the real
  addon, `createBrokerDeviceManagerApi` and `CapabilityRegistry`. It checks that
  a runner `shutdown()` and a `reloadDevice()` never call
  `retractCameraStream`, and that an edit shrinks the catalog. The package now
  has a `test` script, so CI runs this suite. Twelve of its tests had been red
  on main, unseen, since D677, because the fake did not answer
  `loadRuntimeState`.
- Nothing stops another pull-rtsp provider from retracting in `removeDevice()`
  again. This is review only (D685 review L3).
