---
id: D316
title: "A question about a whole table is a STATEMENT, and a bulk stamp is one too"
status: accepted
date: 2026-08-30
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/event-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/analytics-query-facade.ts
  - packages/addon-post-analysis/src/pipeline-analytics/media-relocate-engine.ts
  - packages/types/src/capabilities/pipeline-analytics.cap.ts
---

## Context

Two methods over `pipeline-analytics:media` were unusable on the live hub, and
both blocked the same operation: deleting the surplus event media (the periodic
`snapshot` filmstrip, the per-edge motion stills now gated by
`debugMediaEnabled`) out of a 1 254 576-row store.

**`getEventStoreFootprint` timed out at 60 s, every call.** It is the only thing
that can size that deletion, so the deletion could not responsibly be started.
`MediaStore.footprintByDevice` paged the WHOLE collection —
`ORDER BY id LIMIT 1000 OFFSET n`, no predicate — and summed `sizeBytes` in JS.
SQLite honours an OFFSET by stepping over `n` entries, so the walk is quadratic
in the table: ~1 250 round trips, ~780 M index steps, and every row serialised
across an RPC boundary and rebuilt in V8 to be added to a number. On top of it
the facade called `eventStore.countForDevice(deviceId)` inside a loop over the
device set — three `COUNT(*)` round trips per camera.

**`relocateMedia({ mode: 'seal' })` ran at 2.3 rows/s.** Measured on the hub:
1 170 rows in 8 min 29 s, falling to 0.7 rows/s once the `recordingsLow` drain
resumed and competed for the disk. The 464 902 unstamped rows would have taken
over two and a half days, for a metadata stamp that reads no file and moves no
byte. It paged the whole collection and then issued one `store.set.mutate` —
a full-row UPSERT rewriting every column — per selected row, after a second
full walk to produce the denominator.

This is the same finding four more times over. `getAllBindings` at 1 + 1019
sequential door round trips; `projectChildren` at one store read per child;
the OSD source catalog at 1 + 1019 `getBindings`; `countUnstamped` at ~6 300
pages (D312). Every one was cured identically: push the work into the
statement instead of looping over the door.

**What was NOT the cause, and had to be checked.** It is not a per-device loop
over the wrong set — the footprint's device set is cameras with media or tracks
(~30), never the 1 019-device fleet. It is not `sizeBytes` being derived from
the blob — it is a declared `INTEGER` column. And it is not a missing index:
measured at production scale, the grouped rewrite answers in **1.2 s using only
the indexes that already existed**, against 13.9 s for the offset walk on the
same warm local disk. The indexes below are an optimisation on top of the fix,
not the fix.

## Decision

Four rules.

1. **A question ABOUT a table is answered BY the table.** "How many", "how much",
   "which distinct values" go to `count` / `aggregate` / `histogram`. A paged
   walk is for work that must VISIT each row to act on it, and for nothing else.
   `histogram(field, bucketSize: 1, origin: 0)` is `GROUP BY <integer column>`
   and is how a device set is obtained (D56).

2. **A per-camera figure is one grouped read, not one read per camera.**
   `EventStore.countByDevice` answers the whole fleet in three statements, one
   per event collection. `countForDevice` survives for the single-camera case
   and must never again be called in a loop.

3. **A bulk stamp is a bulk statement.** The seal probes the indexed
   `locationId IS NULL` range for a batch of ids and issues ONE `updateWhere`
   over them — two round trips per 500 rows instead of one write per row. The
   predicate CONSUMES itself, which is what makes the seal resumable,
   idempotent, and incapable of repointing a row that already names a different
   location. It is batched rather than a single unbounded
   `UPDATE … WHERE locationId IS NULL` because half a million row rewrites,
   each maintaining five indexes, is an unbounded statement holding the write
   lock on the database the whole cluster reads configuration through, under an
   RPC deadline that must not be raised.

4. **A total is MEASURED, never summed from the parts that were enumerated.**
   `getEventMediaFootprintByKind` enumerates `MediaFileKindEnum.options`, but
   the table is not closed: a row whose stored `kind` predates or postdates that
   enum matches no per-kind query. `totalRows` / `totalBytes` come from a
   separate unfiltered aggregate, and the difference is reported as
   `unaccountedRows` / `unaccountedBytes`. An operator sizing a deletion must
   never be handed a denominator smaller than the disk.

Two further facts this pass corrected. The footprint's device set was
`media ∪ tracks`, so a camera holding events but no media row and no persisted
track was invisible and its events missing from `totalRows` — not exotic, since
media retention, media deletion and `pruneTracksBefore` all run on their own
clocks. Events now contribute their own device set. And a store that cannot
answer THROWS: "this camera holds nothing" is exactly the claim a failed
measurement must not make to something about to delete (D295, D312).

## Consequences

**Measured at production scale** (1 254 576 rows / 259 MB, 30 cameras, 12 kinds,
464 202 unstamped — an uncontended local NVMe, so these are floors, not hub
numbers):

| | before | after |
| --- | --- | --- |
| `footprintByDevice` | 13 938 ms, 1 255 round trips, 1 254 576 rows materialised | **216 ms, 31 round trips, 0 rows** |
| `footprintByKind` | did not exist | **93 ms, 13 round trips, 0 rows** |
| seal of 464 202 rows | 2.3 rows/s on the hub (~56 h) | **1 967 ms, 1 859 round trips** |

Both aggregates agree exactly with a brute-force `GROUP BY` over the same
fixture, on both axes, 0 mismatches.

**Two new indexes on `pipeline-analytics:media`**, both covering:
`idx_media_device_size (deviceId, sizeBytes)` and
`idx_media_kind_device_size (kind, deviceId, sizeBytes)`. `sizeBytes` must be IN
the index, last, or the sum reads the table row behind every index entry — and
`SUM … WHERE kind = ?` degrades to a full `SCAN` per kind without the second.
Measured: 18.2 MB and 31.6 MB, built in 798 ms and 1 796 ms on an idle local
disk. **On the hub's saturated array expect that to be very much larger** — D312
budgeted "tens of seconds to a couple of minutes" for one such build, and these
are two. They must not be deployed beside a running drain or seal.

The build cost is deferrable. Reverting only the two `MEDIA_INDEXES` entries
leaves a working fix, measured at 1 196 ms / 1 017 ms instead of 216 ms / 93 ms,
because the offset walk — not the index — was the defect.

**What a new index must be.** A NEW NAME. `declareCollection` emits
`CREATE INDEX IF NOT EXISTS` keyed on the name, so widening an existing index in
place is a silent no-op on every hub that already has it: the declaration reads
as done and the query keeps hitting the table. Index removal is not handled at
all, so a rename strands the old b-tree forever.

**What this does NOT change.** The relocate PASS for `move` and `gallery` still
pages — it must visit every row to move bytes — and so does its pre-count. Their
predicate is genuinely not expressible: `mediaRowLocation` folds NULL into the
default location before comparing, so `whereNot: { locationId: target }` has the
wrong meaning when the target IS the default, and "not an enrolled gallery
owner" needs a `NOT IN` over three `ownerKind` values that the filter vocabulary
has no form for. Neither has a measured cost problem. Inventing a predicate that
ALMOST matches would.

**What is still missing from the store cap.** There is no `groupBy` on
`aggregate`, so a per-(camera × kind) breakdown would be ~360 statements and is
not offered. `histogram` is the only grouped primitive and it groups by a
numeric bucket. Adding a grouped aggregate is ~13 hand edits across two mirrored
cap schemas, one TS interface, one dispatch, two hand-spelled storage-manager
literals and six test doubles — worth doing when a second caller needs it, not
for this one.

## Enforcement

- `packages/addon-post-analysis/src/pipeline-analytics/__tests__/event-store-footprint.spec.ts`
  — a 14 400-row fixture (the retired walk needed 15 pages; the pre-existing
  `footprintByDevice` cases used THREE rows and were green on both
  implementations, which is why they could not see this). Asserts
  `calls.rowsRead === 0`, a round-trip budget bounded by the camera count,
  `calls.count === 0`, exact per-camera rows and bytes against an independently
  accumulated expectation, byte-descending order, the three-way device union
  including a camera with events but no media, and the per-kind breakdown
  including a row whose `kind` is outside the enum surfacing as `unaccounted`.
- `media-seal-bulk-stamp.spec.ts` — `calls.set === 0` over 1 200 rows, a bound
  on `updateWhere`, rows read bounded by rows stamped, idempotence, a row naming
  a foreign location left alone, resume after an interrupted run, the
  denominator, and the D312 failure reproduced: a backend whose bulk predicate
  matches nothing must FAIL the job, not spin forever and not report a completed
  seal having stamped nothing.
- `media-store.spec.ts` — both index declarations pinned by exact column tuple
  (a name lookup would pass a reordered or truncated declaration), plus a
  distinct-names assertion for the `IF NOT EXISTS` trap above.
- `test-helpers.ts` gained `aggregate` (which REFUSES an unresolvable field,
  as the engine does), `updateWhere`, and `calls.rowsRead` / `calls.set` /
  `calls.updateWhere` / `calls.aggregate` / `calls.histogram`. A round-trip
  count is the only thing that can see the difference between "summed
  correctly" and "summed cheaply"; no assertion about a returned number can.
- Every assertion above was disarmed — the implementing line reverted, RED
  observed, then restored. Eight of them: the offset walk, `countByDevice`, the
  event device set in the union, the independently-measured totals, both index
  declarations, the per-row stamp, the zero-progress termination guard, and the
  seal's indexed pre-count.
