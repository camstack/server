---
id: D255
title: An aggregate question is answered by the database, never by materialising the archive
status: accepted
date: 2026-08-27
supersedes:
applies-to:
  - packages/addon-pipeline/src/recorder/recording-index.ts
  - packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts
  - packages/addon-pipeline/src/recorder/storage-evictable-provider.ts
  - packages/types/src/capabilities/settings-store.cap.ts
---

## Context

The `hub/recorder` runner held **1606 MB of heapUsed** against 8 MB `external`,
with an `smaps` census putting 1510 MB in V8's 256 KB page ranges against 54 MB
of native heap: live JavaScript retainers, ~7.1 M `RecordingIndex` rows (13
cameras × 2 profiles × 8 640 segments/day × ~30 days), and CPU burning in
bursts.

`RecordingIndex` already had an on-demand hydration state machine — per device,
per hour — and the boot log says `full-archive index walk skipped
{reason:'on-demand-windows'}`. Three consumers nonetheless required the whole
archive to be resident, all for the same reason: **they asked a question keyed
by storage LOCATION of a map keyed by DEVICE**, which can only be answered by
visiting every row.

- `accountingForLocations(locationIds)` — bytes/count/oldest/newest for an
  eviction domain. Called by `storage-evictable.getEvictableUsage` on every
  `PRESSURE_SWEEP_INTERVAL_MS` (60 s) tick, and twice per tick when two
  locations alias one physical root.
- `accountingForLocation(locationId)` — the same, for the placement planner.
- `segmentsOnLocations(locationIds)` — copied every matching row into a new
  array and `toSorted()` it, to pick the oldest few.

Measured on a 1/10-scale replica of the live shape (673 920 rows): **673 920 row
visits and 8.1 ms of main thread per accounting call**, and **71 ms plus a
673 920-element copy-and-sort per eviction round** — ~6.7 M visits / 81 ms and a
6.7 M-element sort at live scale.

What made the defect survive four years of tests is that **a scan and a sum
return the same number**. Every existing test compared totals, and every one of
them passed.

The first thing tried was not this. `process-service.ts` had a comment
attributing the same ~2 GB to "walk garbage" from the deferred archive walk —
and that walk had no caller and never ran. A wrong explanation written down in
the code cost a session.

## Decision

**A question whose answer is a scalar goes to the database as a scalar.** The
recorder's location-keyed totals are a `SUM`/`COUNT`/`MIN`/`MAX` over the
durable hour ledger (`recorder:segment-hours`), through the new
`settings-store.aggregate` method; the oldest-first eviction pick is a bounded
`ORDER BY hourStartMs ASC LIMIT n` over the same collection. `RecordingIndex`
no longer exposes any location-keyed aggregate, because it cannot answer one
without a walk.

The eviction domain's **correctness constraint is a property of the statement,
not of the caller**: every location id aliasing one physical root rides in a
single `locationId IN (…)` clause. A query per location plus a merge is the
age-partition data-loss bug rebuilt in a second place.

`settings-store.aggregate` **refuses** a field the collection cannot express,
the way `query.columns` does and unlike a predicate, which is skipped when
unresolvable: a dropped predicate over-matches and the caller sees extra rows,
while a dropped aggregate hands back a number that looks exactly like a real
one. An empty match answers `null` per field, never `0` — "nothing is here" and
"the sum is zero" are different facts about a disk.

## Consequences

- The hour ledger carries four DERIVED columns (`bytes`, `segments`,
  `minStartMs`, `maxStartMs`). They are computed by `hourAggregate` from `paths`
  and by nothing else, so they can never become a second authority;
  `repairAggregates()` backfills rows written before the columns existed, using
  `segments = 0` as the predicate (an hour row with no segments cannot exist
  otherwise).
- An archive that cannot be measured is not evicted. When the ledger is
  unavailable, `getEvictableUsage` reports 0 and `evict` deletes nothing — and
  says so out loud, because a branch that drops work silently reads as "never
  happened".
- `exhausted` on an eviction round now comes from the READ, not from comparing
  two array lengths. A bounded stream cannot count what it deliberately did not
  fetch.
- `settings-store` and `data-store-provider` grew a method, so this is not live
  until a `@camstack/server` containing it is published.
- **This does NOT by itself shrink the recorder's heap.** Removing the scans
  removes their CPU and their per-round allocation; what keeps ~7.1 M rows
  resident is `SegmentHourLedger.hydrateIndex` reseeding every archived hour at
  boot, the `DurableLedger` mirror holding every path string, and the hourly
  retention sweep reading `index.segments(deviceId)` per camera. Those are a
  separate decision.

## Enforcement

- `packages/addon-pipeline/src/recorder/addon/__tests__/segment-hour-archive.spec.ts`
  and `.../recorder/__tests__/storage-evictable-provider.spec.ts` assert on the
  OPS ISSUED — one `aggregate`, one `orderBy … limit` — not on the totals,
  because the totals never disagreed.
- `EvictableArchive` is the type-level half: the eviction provider can only ask
  for a total or for a bounded oldest-first read. There is no method on it that
  returns an archive.
- `packages/system/src/builtins/sqlite-storage/__tests__/aggregate.spec.ts` pins
  the refusal and the `null`-not-zero contract.
- Nothing guards a NEW location-keyed scan being added to `RecordingIndex`; the
  block comment where the three removed methods were says why one cannot exist.
  Review only.
