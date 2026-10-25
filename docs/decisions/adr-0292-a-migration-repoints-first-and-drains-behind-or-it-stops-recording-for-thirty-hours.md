---
id: D292
title: "A migration repoints FIRST and drains behind — and every row that means 'wherever the default points' is sealed before it does"
status: accepted
date: 2026-08-29
supersedes:
applies-to:
  - packages/system/src/builtins/storage-orchestrator/storage-migration-coordinator.ts
  - packages/addon-post-analysis/src/pipeline-analytics/media-relocate-engine.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/retrain-frame-store.ts
---

## Context

`storageMigration` moved the bytes *inside* the global pause: pause → move →
verify → repoint → refresh → resume. The destination class of disk on this hub
does 7–14 MB/s at 95 % util and `recordings` is 1.09 TB, so that order means
**thirty hours of stopped recording** for one disk swap.

The design that avoids it is not a new mover — it is the existing phases in a
different order, and
[`docs/design/2026-08-29-non-blocking-storage-migration.md`](../design/2026-08-29-non-blocking-storage-migration.md)
traced every reader against "one storage class spans two locations" and found
them all already correct: `collectRangeSegments` builds `rootById` from *every*
location, not the default, and `eventMedia` resolves per row. The past is
immutable; it needs no pause. What needs a pause is the instant the writers
change root, and `RecordingController.pause()`/`resume()`
(`packages/addon-pipeline/src/recorder/addon/recording-controller.ts:2076`) is
already exactly that — seconds, in parallel, per camera.

**What was tried first and was wrong, twice.**

- **`config.readOnly` on the source** to force the cutover — the route the
  2026-08-26 note recommended. `StorageEvictableProvider.domainOf` SUBTRACTS
  read-only members from the physical-root eviction domain
  (`packages/addon-pipeline/src/recorder/storage-evictable-provider.ts:100`),
  and `recordings:default` and `recordingsLow:default` share `/recordings`.
  Marking low read-only therefore removes low footage from the eviction domain
  of a disk under continuous quota pressure, and the sweep takes the difference
  out of `high`. Repointing the default alone moves new writes and keeps the
  source fully first-class for reads, retention and eviction.
- **Reordering the phases without sealing `eventMedia` first.** A media row with
  `locationId: NULL` does not mean "the old disk" — it means *"wherever
  `eventMedia` points **now**"* (`media-store.ts:396`). Repoint-first is safe
  precisely because reads resolve per row, and a NULL row has no row to resolve
  by. The instant the cutover refreshes, every one of them reads from the new
  disk while its bytes are on the old one. Three populations are NULL, and one
  of them — **every retrain frame** — was still being created at write time
  (`retrain-frame-store.ts:315` wrote `locationId: null` unconditionally), so
  even a seal run to completion refilled behind itself.

D291 is the prerequisite for the drain half in **both** modes: without it a
drained hour comes back at its old root and renders as a silent black window.

## Decision

**A `nonBlocking` migration repoints the default before it moves a byte, and
drains the past behind every writer that is already back up:**

```
planning → sealing → pausing → repointing → refreshing → resuming → draining → verifying → done
          └──────────── the cutover: seconds ────────────┘   └── hours, everything running ──┘
```

Four rules hold it together.

1. **Same phases, same movers, different order.** `draining` drives
   `recording.relocateFootage` and `pipelineAnalytics.relocateMedia` — the same
   engines the blocking mode leases, armed through their UNLEASED entry points,
   because by then there is no lease left to present. No second mover, no
   parallel code path.
2. **`sealing` runs before anything is paused, and the gate is a RE-COUNT.** The
   seal stamps every NULL row with the **source** id — the location its bytes are
   already on, never the destination. What decides is
   `countUnstampedEventMedia()` afterwards, not the seal job reaching a terminal
   state: a seal that failed some rows still finishes. A non-zero count fails
   the job while nothing is paused and nothing is repointed.
3. **`plan()` refuses a non-blocking `eventMedia` cutover while any row is
   unstamped.** The operator seals first (`relocateMedia({ mode: 'seal' })`);
   the in-job `sealing` phase then exists for the rows that raced between the
   plan and the start. A migration that can silently orphan event media is not
   startable.
4. **A write that lands on `eventMedia` NAMES its location.** Retrain copies
   resolve through the same `resolveEventMediaLocation` media writes use, and
   the blob is written to the id the row names. A resolver that degrades to the
   bare type ref still writes NULL — honestly, and loudly — because claiming a
   concrete location that was never resolved is worse.

`blocking` stays the default and stays right for a small or cold class, and
`StorageMigrationJob.mode` is how `status` tells an operator which one is
running.

## Consequences

- **Thirty hours of stopped recording becomes seconds** — one detach + attach
  round per camera, in parallel, plus a millisecond `mediaWriteGate` drain.
- **A cancel during `draining` is a supported outcome, not a refusal.** The old
  rule ("refuse once repointed") would have made the long half of every
  non-blocking migration uncancellable. Cancellation is refused only in
  `refreshing`/`resuming`, the window where writers are paused on stale roots.
- **A `draining` failure is terminal, not a rewind.** The post-repoint retry
  branch is now gated on writers still being PAUSED. A drain fails with every
  writer up; the class degrades to "readable from both locations", which is a
  supported steady state.
- **Boot recovery must not re-pause a drain.** Re-acquiring a maintenance lease
  to recover `sealing` or `draining` would stop recording for the length of the
  drain — the cost this mode exists to avoid.
- **The source location must not be deleted at the end.** A half-drained or
  fully-drained source still has rows naming it; see D293.
- **`galleryMedia` can never use this mode.** It is `cardinality: 'single'`, so
  the two-locations transient the whole design rests on is not constructible for
  it. Stated in the planner as a refusal plus a `blockingOnly` finding, not left
  to be discovered.

## Enforcement

`packages/system/src/builtins/storage-orchestrator/__tests__/storage-migration-coordinator.spec.ts`
and
`packages/addon-post-analysis/src/pipeline-analytics/__tests__/media-relocate-engine.spec.ts`.

Every assertion was disarmed. Two are worth recording:

- The seal's row predicate (`rowIsUnstamped`) passed **disarmed** on the first
  attempt, because the fixture's already-stamped row carried the same id the
  seal was stamping with — "left alone" and "re-stamped with the same value"
  are indistinguishable. The fixture now names a DIFFERENT location, and the
  disarm fails.
- The destination-headroom tests initially depended on how full the developer's
  laptop was: the drain refuses a destination below its `minFreePercent` floor
  (default 10, matching placement), the fixtures live in `os.tmpdir()`, and the
  machine was at 8.7 %. Every engine construction in those specs now states its
  free-space assumption instead of measuring the host.
