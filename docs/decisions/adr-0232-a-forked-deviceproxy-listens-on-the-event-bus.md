---
id: D232
title: A forked DeviceProxy listens on the event bus, not live.onEvent
status: accepted
date: 2026-08-24
supersedes:
applies-to:
  - packages/types/src/device/device-state-handle.ts
  - packages/system/src/kernel/moleculer/addon-context-factory.ts
  - packages/system/src/kernel/moleculer/device-cap-proxy.ts
  - packages/addon-post-analysis/src/pipeline-analytics/index.ts
---

## Context

A zone edit on camera 102 (2026-07-16) did not reach occupancy in the
analytics runner for up to 30 s. The first diagnosis was "UDS does not
fan `device.state-changed` to forked children." That was wrong.

`createDeviceProxy` defaulted to `createLazyTrpcSource`, which subscribes
through `api.live.onEvent` — a hub-main tRPC subscription. That subscribe
never populates `RegisterMessage.eventPatterns`, so the parent correctly
filters the child out of `broadcastEventToChildren`. The child was not
missing the event; it had never declared interest. Analytics compensated
with `ZONE_SLICE_RECONCILE_MS = 30_000`, which made the miss look like
"events are lossy" rather than "the watch is on the wrong pipe."

Rejected: widen the parent to fan every category to every child. That
undoes the interest filter and puts the firehose on every runner.

Rejected: invent new hub categories for occupancy / tracks / parked
objects. `zone-analytics.occupancy-changed`,
`pipeline-analytics.track-lifecycle` and
`pipeline-analytics.stationary-changed` already exist. The remaining
short polls were clients not listening, not missing emits.

## Decision

A DeviceProxy minted inside an addon process uses
`createEventBusSliceSource({ eventBus: ctx.eventBus, api })`. That
`subscribe({ category: 'device.state-changed' })` is what reports UDS
interest. Browser / SDK clients keep `createLazyTrpcSource` (`live.onEvent`
is the right pipe there).

Pixel payloads travel HTTP (signed snapshot links, event-media by key).
They do not ride tRPC. A short poll that remains is either the D108
capture trigger (`getSnapshotLinks` at 5 s) or the D8 reconcile (five
minutes). A poll faster than that, for a change the hub already announces,
is a bug.

## Consequences

`ZONE_SLICE_RECONCILE_MS` is 300_000, matching the viewer's `RECONCILE_MS`.
The viewer invalidates occupancy off `occupancy-changed` and
`stationary-changed`, Events tiles off `track-lifecycle`, and the theater
heatmap off the same. `getPlateByTrack` returns a `cropUrl`, not JPEG.

A future "the fork does not see events" report must first check whether
the child declared the category on `ctx.eventBus`. Widening the parent is
the last move, not the first.

## Enforcement

`packages/system/src/kernel/__tests__/moleculer/device-slice-source-wiring.spec.ts`
pins the factory wiring. `device-state-handle.spec.ts` pins that the
event-bus source subscribes to `device.state-changed`.
`camstack/src/data/__tests__/viewer-hub-churn.spec.ts` catalogues every
standing poll faster than five minutes.
