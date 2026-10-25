---
id: D891
title: A location held at its eviction floor is normal; its bands are relative to the floor
status: accepted
date: 2026-10-21
applies-to:
  - packages/system/src/builtins/storage-orchestrator/storage-location-band-monitor.ts
  - packages/system/src/builtins/storage-orchestrator/storage-orchestrator.addon.ts
---

## Context

`recordings-high-4tb` (`minFreeGb: 150` of 3.7 TB) is kept by the recorder's
evictor at its floor, about 4 % free, permanently. The band monitor judged every
location against a fixed 5 % critical bar, so that healthy volume flapped
low <-> critical every few minutes and emitted `storage-location-critical`
events that an operator rule turned into phone pushes: pure noise, and noise on
a channel that must mean "writes are about to fail".

## Decision

A location under the eviction guard is judged against ITS floor, not a fixed
percentage. `low` opens only when free stays below 80 % of the floor for a
10-minute grace window (the evictor is falling behind); `critical` opens
when free is below 50 % of the floor, without grace. Every edge has a separate
exit (90 % / 60 % of the floor; +2 points for unmanaged locations), so a value
hovering at a bound emits one edge. A location without a floor keeps the fixed
15 % / 5 % bands. A failed measurement (`null`) never changes a band (D393).

Rejected: an absolute byte minimum for `critical` ("enough to write a segment").
It needs a second knob, and a segment-sized figure fires only after writes have
already failed; half the operator's own floor scales with the setting and fires
well before.

## Consequences

An unreadable volume is now silent in Notification Center (it was `critical`
with reason `capacity-unreadable`); the sweep logs it at debug level. Every
edge is logged with locationId, band, freePercent, floorPercent, freeBytes,
floorBytes and reason.

## Enforcement

`storage-location-band-monitor.spec.ts` (managed oscillation, grace, hard bound,
hysteresis, null, unmanaged).
