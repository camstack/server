---
id: D883
title: A sleeping battery camera is not a stream outage, and an outage is one event per device
status: accepted
date: 2026-10-18
supersedes:
applies-to:
  - packages/addon-pipeline/src/stream-broker/stream-broker/stream-health-policy.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/device-stream-outages.ts
  - packages/addon-pipeline/src/stream-broker/stream-broker/stream-broker-manager.ts
  - packages/addon-post-analysis/src/notification-center/event-intake.ts
  - packages/system/src/builtins/alerts/alerts.addon.ts
---

## Context

Live on the hub, 2026-10-18, device 106 (a Reolink battery camera): every time the
camera slept and woke, stream-broker emitted `stream.offline` / `stream.online` once
PER PROFILE (`640/native:main`, `640/native:sub`) and the operator's "system events -
devices" rule pushed each one. The broker already knew the camera was asleep (the
sentry composed `source=cached-snapshot reason=sleeping`); the health sweep did not ask.
A quiet stream on a battery camera is the designed steady state, yet the sweep judged it
like a mains camera that lost its stream (`stale-timeout` after 120 s). The operator:
these should signal an ERROR, not the usual behaviour.

Filtering in the notification rule was rejected: every other consumer of the events (the
alert bell, the state ledger, any tap) would still see a lie.

## Decision

The verdict is made at the emitter, by `judgeStaleStream`, from the battery sleep mirror
(`BatteryOnStatusChanged`, the signal the placeholders already follow):

- a battery camera asleep and not demanded: NO event, an info log naming the sleep
  (`tags: { deviceId }`); the wake that ends it is logged as a plain wake;
- asleep and a stream is demanded (live viewer, recording, force) but none arrived:
  `stream.offline` with reason `wake-timeout`. A failed wake-on-play (no broker at all)
  announces the same through `announceBatteryWakeFailure`;
- reported awake and the stream is gone: `connection-error`, but only once the camera has
  been awake longer than `WAKE_DEMAND_BOUND_MS` (`awakeSince`, stamped when `sleeping` flips to
  false). Inside that window the quiet stream is the normal wake (first keyframe not yet here):
  suppressed, logged, and re-judged by the level sweep. An unknown `awakeSince` (restart, slice
  read) judges immediately, as before;
- silent past `BATTERY_UNREACHABLE_AFTER_MS` (the D847 refresh window): `battery-unreachable`;
- mains cameras: `stale-timeout`, as before.

`stream.online` follows only such an outage (`recovered`), never a plain wake.

An outage is a DEVICE fact: `DeviceStreamOutages` folds the per-broker sweep into one
`stream.offline` per device (all profiles that dropped in the sweep named in
`camStreamIds`) and one `stream.online` when no stream of it is still down. Later
profiles joining an announced outage log at debug and emit nothing. Lazy-dial telemetry
(`suspended`, `resumed`, `first-packet`, `broker-destroyed`) stays per broker; every gate
discards it already.

## Consequences

- The verdict is LEVEL state, not an edge: a stream suppressed as asleep is re-judged on
  every sweep, so a camera that sleeps and then dies surfaces as `battery-unreachable`
  once its contact is silent past the D847 window, and a demand that waited longer than
  `WAKE_DEMAND_BOUND_MS` (45 s: the 8 s wake plus the 20 s broker settle, with margin)
  becomes `wake-timeout`. Demand is `StreamBroker.hasLiveDemand()` (viewer, recording,
  detection decode, camera wake hold; never a sentry or prestream session).
- A sleep verdict needs a sleep state that was READ. The mirror fed by the droppable
  `BatteryOnStatusChanged` is empty after a restart, so the sweep asks the registry
  (`isBatteryOperated`, the read wake-on-play uses) and the `battery` slice itself, and
  waits a sweep for the answer. A class that cannot be answered, or a slice never read,
  is judged as a mains camera (`stale-timeout`) - never suppressed (D49).
- An outage never outlives what held it open: a released stream closes an announced
  outage with an online (`broker-destroyed`), an outage stream whose broker went idle
  closes with `suspended`, and a wake-only outage (a failed play with no broker) closes on
  the device's next healthy stream or 5 minutes after the last failed wake. The
  notification gate discards those onlines; the ledger and the alert center clear on ANY
  online reason.
- The Notification Center subject and the alert-center card id are per device
  (`stream:<deviceId>`, `stream-offline:<deviceId>`), no longer per cam-stream. **One-time
  migration of state keys:** the ledger closes every open `stream:` row whose subject is
  not `stream:<digits>` when it is built (and a device's legacy rows when its stream comes
  back), and the alert center dismisses active `stream-offline:<id>:<stream>` cards at boot
  and on the device's online. Nothing else is purged.
- NC and the alert center accept the three new reasons; any new consumer must read
  `reason` before treating a flip as an outage (unchanged rule).

## Enforcement

`battery-stream-health.spec.ts` (sleep emits nothing; demanded wake timeout, awake
connection error, unreachable; main+sub is ONE event; mains unchanged),
`stream-health-policy.spec.ts`, `stream-health-gate.spec.ts`, `alerts.addon.spec.ts`.
