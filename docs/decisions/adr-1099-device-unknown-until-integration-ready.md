---
id: D1099
title: A device is unknown until its integration is ready; offline is concluded only after
status: proposed
date: 2026-11-24
supersedes:
applies-to:
  - packages/system/src/builtins/device-manager/state-refresh-scheduler.ts
  - packages/system/src/builtins/device-manager/state-refresh-wiring.ts
  - packages/system/src/builtins/device-manager/device-state-mirror.ts
  - packages/types/src/capabilities/device-status.cap.ts
  - packages/addon-post-analysis/src/notification-center/event-intake.ts
---

## Context

When an integration (a device provider addon) restarts, its devices were
reported offline in a storm — status flips, `device-offline` notifications —
although they never went offline: the provider had not re-read them yet.

The traced path:

- A driver decides a device's liveness: `BaseDevice.markOnline(false)`
  (`packages/types/src/device/base-device.ts`) writes the `device-status` slice
  (`online`, `lastChangedAt`). A device is seeded `online: true` at construction
  and a provider flips a whole integration's devices offline when its link is
  not up (for example `setIntegrationDevicesOnline` in the UniFi provider).
- The slice reaches the hub through `setCapSlice` into
  `DeviceStateMirror.applySingleCapUpdate`, which emits `device.state-changed`.
- The notification centre turns that slice into `device-offline` / `device-online`
  (`incomingFromSystemEvent` -> `deviceLiveness`, `event-intake.ts`), the ledger
  records the flip and `DeviceLivenessHoldoff` (15 s, `liveness-holdoff.ts`)
  swallows a bounce shorter than the window.
- WHEN a migrated provider re-reads a device is the core's (D1062): the
  `StateRefreshScheduler` in the hub's device-manager, per integration group.

The 15 s hold-off swallows a flap only when the provider comes back inside it.
A restart where the first read takes longer than 15 s still announces offline.
Nothing in the pipeline could say "not yet known".

## Decision

1. `DeviceStatus` carries an explicit `unknown: true` marker: the provider has
   not answered since the (re)start and `online` is a placeholder, not a fact.
   Absent means answered.
2. Offline is concluded only once the integration is READY. The scheduler owns
   readiness: an integration group is ready once its first read after
   registration SETTLED (succeeded, or failed — a failed first read is an
   answer: the integration is unreachable). No timer waits for it (D3).
3. The mirror gates `device-status` writes of a device whose integration is not
   ready: an `online: false` write is held back (the slice keeps its last
   `online`, marked `unknown`), remembered, and LOGGED with its reason and
   `tags: { deviceId }` (D391). When the group becomes ready the held offline is
   applied through the normal path, so the notification centre's 15 s hold-off
   still applies on top. An `online: true` write before ready is an answer and
   clears the hold.
4. Readiness is in-memory hub state read by the mirror on every write
   (`isAwaitingFirstRead`) and pushed by the scheduler in-process; it is never
   an event, so a lost event cannot strand a device (D8, D11, D49). A
   `reconcileReadiness()` pass releases anything the push missed.
5. The notification centre ignores a `device-status` slice marked `unknown`: it
   is not a liveness claim.

## Consequences

- The gate is per INTEGRATION as well as per device. Homematic, Home Assistant
  and UniFi register their policy once, on the gateway/broker cap
  (`integrationId` = the integration id); their child devices carry none. The
  device-manager reads each device's `integrationId` from its row (or its
  parent's) when its first `device-status` write arrives, and the mirror treats
  the device as awaiting while the scheduler group `addonId::integrationId` has
  a device that has not had its first read settle. No new registry or lookup.
- A device of an integration with no `device-state-refresh` policy at all has no
  scheduler group and is not gated (unchanged behaviour).
- A device whose integration is down for real stays `unknown` until the first
  read settles — at most one declared refresh interval after registration —
  and is then offline plus the 15 s hold-off.
- A later adoption under a running integration re-holds its siblings: the new
  device awaits its first read, and so does its group until that read settles.
- The `unknown` slice is persisted like any `device-status` slice (restored at
  boot as the last known `online` plus the marker); the next answer replaces it.
- A legacy row with no `meta.integrationId` on itself or its parent stays
  ungated (it has no integration to wait for).
- With no prior reading, a held offline writes NO slice (no invented
  `online: true`); the device reads as unreported until the first read settles.
- `unknown` is a new optional field of a capability schema: a framework change
  (server closure), and consumers that render reachability (UI, exports) must
  learn to show it; the admin UI is not changed by this record.

## Enforcement

Specs in `packages/system/src/builtins/device-manager/__tests__/device-unknown-until-ready.spec.ts`
(restart -> unknown -> ready -> offline/online, a missed readiness push is
reconciled) and in the notification-center intake spec (an `unknown` slice is
not a liveness claim). Review only for the rest.
