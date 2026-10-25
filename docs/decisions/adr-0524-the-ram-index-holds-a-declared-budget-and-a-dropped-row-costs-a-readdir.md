---
id: D524
title: The RAM index holds a DECLARED budget, and a dropped row costs a readdir
status: accepted
date: 2026-09-17
applies-to:
  - packages/addon-pipeline/src/recorder/recording-index.ts
  - packages/addon-pipeline/src/recorder/__tests__/recording-index-residency.spec.ts
  - scripts/check-recorder-index-residency.ts
covers:
  - packages/addon-pipeline/src/recorder/addon/index.ts
  - packages/addon-pipeline/src/recorder/addon/roots.ts
  - packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts
last-verified: 2026-10-02
---

## Context

On 2026-09-17 camera 101 lost two hours from the timeline. The chain ended at a
seal ([D521](adr-0521-a-seal-is-a-claim-of-completeness-and-only-a-party-that-can-know-may-write-one.md)),
but the CAUSE was upstream of it: the recorder runner was respawned five times
that day, three of them under memory pressure. A writer torn down mid-hour is
what produced the damage; everything downstream only makes it repairable.

The hub's recorder, sampled the same day:

```
[mem] hub/recorder rss=2946MB heapUsed=2283MB heapTotal=2672MB heapLimit=3264MB
      used=70% external=65MB arrayBuffers=62MB rssBudget=3584MB
      oldSpace=1296MB largeObjectSpace=942MB newSpace=43MB
      gc=maj0/min0/inc0@2s loopP50=0ms loopP99=1ms procCpu=1.1%
```

`arrayBuffers=62MB` rules out media buffers. The loop is idle. Whatever this is,
it is a data structure.

### The measurement

Nothing in the repo said how much heap `RecordingIndex` was ALLOWED. So it was
measured, locally, by rebuilding exactly the structures the class holds at the
production archive size — 26 cameras × 2 profiles × 1 599 416 `.m4s` files, the
figure in `segment-hour-ledger.ts`'s header — under `node --expose-gc`, settling
with six full collections before and after:

| structure | heap held | per row |
| --- | --- | --- |
| `byDevice` maps of `SegmentRow` (whole archive resident) | **1039 MB** | 681 B |
| + the all-profiles sorted views | 1054 MB | 689 B |
| + per-profile sorted views | 1068 MB | 698 B |
| the `SegmentHourLedger` mirror as it was WHEN THAT SAMPLE WAS TAKEN — every hour's `paths` resident | 867 MB | 569 B |

Two numbers matter more than their sum. **A fully resident index is 1039 MB
against a 3072 MB old space** — a third of the budget in one structure. And
**index + fully materialised ledger mirror is 1906 MB, 83 % of the 2283 MB the
hub reports.** The arithmetic lands: those two structures are the shape of that
heap, and neither of them had a bound.

[D523](adr-0523-the-directory-says-which-segments-exist-and-the-table-says-how-much.md)
shipped hours after that sample and removed the second one outright — the
`paths` column, and the mirror rows that carried it, are gone. Re-measured on
the row shape D523 left behind (ten scalars, no `paths`): **171 B/row, ~3.2 MB
at the fleet's ~19 000 hour rows, ~38 MB at `SEGMENT_HOUR_SUMMARY_LIMIT`'s
250 000-row ceiling.** That structure is now both small and CAPPED, and it needs
no record of its own. What is left of the 2283 MB, and unbounded, is the index.

### How the whole archive becomes resident

[D287](adr-0287-hydrated-means-resident-and-boot-loads-the-summary-not-the-archive.md) stopped boot
from replaying the archive, and
[D295](adr-0295-the-ledger-is-the-archive-the-ram-index-answers-only-about-what-is-resident.md)
wrote down that the index is therefore NOT the archive. Both are statements
about what the index HAPPENS to hold. Neither is a bound:

- `hydrateWindowFromStorage` adds every hour a read touches and marks it walked;
- `markHydrated`'s hour markers were a `Set` that only ever grew;
- nothing ever removed a row except an eviction of the footage itself.

So a timeline dragged across a retention window, an export, a `getAvailability`
over a month — any of them walks the archive into RAM one hour at a time, and it
stays for the life of the process. The index was a cache with no eviction, which
is not a cache.

### What was NOT the cause

`ALL_HOURS` looked like the culprit — a sentinel that marks a whole device
hydrated forever. It is not: `markHydratedAll` had no production caller (the
2026-08-30 census said so and it is still true), and the sentinel is deleted
here rather than fixed. The unbounded growth is the ordinary per-hour path.

Interning the path strings is also not the answer, and that was already
measured: +597 MB, the intern table costing more than the duplicate it removes.
Not HOLDING is the only cheap answer.

## Decision

`RecordingIndex` holds a **declared budget**, not whatever it happened to walk.
`armResidency` gives it a `RecordingIndexBudget` — resident rows, walked hours,
a hysteresis fraction, and the hours at the live edge that are pinned — and
every path that can grow the index calls the eviction pass. When it is over, the
index drops whole **(device, hour) buckets, least-recently-ASKED-ABOUT first**,
and it drops the rows and the walked marker in the SAME operation.

That last clause is the whole safety property. The directory is the authority
for which segments exist — every row is derived from a path a walk read — so a
bucket can be rebuilt by one shallow `readdir` of an hour directory or one
ledger point read. **A dropped row costs a `readdir`, never a segment.** What
would turn it into a lost segment is a walked marker outliving its rows:
`hydrationOf` would then answer `hydrated` over an hour holding nothing, and
every reader gates on exactly that answer. Marker and rows go together, or the
bound is a silent gap generator.

The production budget is **250 000 rows / 20 000 walked hours**, evicting to
80 % of it. At the measured 698 B/row that is ~166 MB, 5.4 % of old space. In
footage it is ~13 fleet-hours at 10 s segments (26 cameras × 2 profiles × 360 an
hour = 18 720 rows an hour), or days of one camera when one camera is being
scrubbed. The live tail (2 hours) is never a candidate: those hours are
write-through from the writer, not walked, and a `readdir` of an hour a writer
is still filling cannot give back what it had — [D445](adr-0445-a-ledger-row-describes-its-hour-or-the-array-decides.md)
from the other direction.

`markHydratedAll` and its `ALL_HOURS` sentinel are deleted. A bounded index can
never truthfully claim a whole device, and nothing in production ever asked it to.

### The one consumer for which "costs a readdir" is not true

A reader that finds an hour missing walks it again. A consumer that DELETES on
the index's silence does not: `SegmentHourLedger.reconcileFromIndex` prunes
every ledger hour the index does not report, and an hour the index gave back is
indistinguishable from an hour disk no longer has. Left alone, eviction would
have turned a rescan into a durable delete of rows describing footage still on
the array — the D148 failure, arriving through a new door.

So a whole-device walk ANNOUNCES itself (`RecordingIndex.beginWalk`), and the
reconcile asks `droppedDuringWalk(deviceId)`. `true` puts that camera in the
same bucket as a walk over an unmounted root: **what the walk FOUND is still
unioned in, what it did not find decides nothing**, and the refusal is a WARN
line carrying the camera's tag. The existing magnitude guard does not cover
this — it refuses a shrink beyond 50 %, and an eviction of 30 % of a device's
hours sails straight under it.

## Consequences

- **A read may now pay for an hour it already paid for.** Scrubbing far into the
  past, coming back, and scrubbing there again costs a second `readdir` (or a
  second ledger point read, which is the cheap path D287 exists for). That is
  the price, and it is stated in the eviction log line
  (`costOfRecovery: 'readdir-per-hour'`).
- **`archive-shaped` reads get smaller, on purpose.** They were already partial
  (D295) and already licensed one by one. A caller that reasons about the
  ARCHIVE from one of them was broken before this and is broken by a smaller
  fraction now; the licence list and its "say what happens when the index holds
  a tenth of the archive" requirement are unchanged.
- **Eviction is announced per camera.** One `info` line per device per pass,
  with `tags: { deviceId }`, the hours and rows dropped, the oldest and newest
  hour, and the budget. A structure that silently forgets is how this class of
  bug hides — and "why is 102 worse than 101" is the only form the question is
  ever asked in.
- **The pre-init window is honest rather than silently unbounded.** An index
  nobody armed never evicts and reports `budget: null`. The recorder arms it in
  `onInitialize`, before the recording-node gate, and the guard fails a build in
  which nothing arms it.
- **A rescan of a camera whose archive exceeds the budget no longer prunes its
  ledger.** That is the price of the clause above and it is the safe direction:
  ghost rows survive until a walk the ledger trusts, rather than real rows dying
  on a walk it should not have trusted.
- **The other half of the heap is already gone, and this record does not leave a
  warning standing about it.** An earlier draft of D524 said the ledger mirror
  was still unbounded at 867 MB and named it as the next record. D523 had
  already deleted that machinery — `pathsResident`, `materialize*`, the column
  itself. The re-measurement above (171 B/row, capped at 250 000 rows) is the
  current fact; there is no follow-up owed here.
- **No ceiling was raised.** `maxOldSpaceMb` (3072) and `rssBudgetMb` (3584) in
  `packages/addon-pipeline/package.json` are untouched, which is the point: a
  ceiling is a patch, and the allocation cause is what had to go.

## Enforcement

- `packages/addon-pipeline/src/recorder/__tests__/recording-index-residency.spec.ts`
  drives a synthetic archive far larger than the bound through the real index
  and pins the residency property itself: the bound holds; a dropped hour reads
  back `unknown` and not "empty"; a re-hydrate returns the identical rows; the
  live tail survives being the coldest thing in the index; an hour somebody
  asked about outlives one nobody asked about; the walked map is bounded even
  when its hours held nothing; and every drop carries its camera's tag. Six
  sabotages were run against it — marker survives the drop, live tail
  unpinned, `hydrateHour` stops enforcing, a read stops counting as an ask, the
  log line loses its tag, an empty walked hour stops being a candidate — and
  each turned exactly the intended tests red.
- `segment-hour-ledger.spec.ts` pins the reconcile refusal on a shrink small
  enough that the magnitude guard stays silent, and `roots.spec.ts` pins that
  the real `hydrateDeviceFromStorage` announces its walk. That second test
  exists because the sabotage of `beginWalk` stayed GREEN on the first attempt:
  nothing covered the wiring, only the mechanism. Three further sabotages —
  the trimmed device prunes anyway, the index stops counting its drops per
  camera, the walk never announces itself — now each go red.
- The growth check earned itself on the D523 rebase, unprompted: `resetHour`
  (new in D523, and a `mapFor` caller) failed the guard by name on the first run
  against the rebased tree. It now hands control to the bound explicitly.
- `scripts/check-recorder-index-residency.ts` (already in CI) gained two checks:
  every method that can grow the index (syntactically: every `mapFor` caller)
  must call `enforceResidency`, and something in `packages/addon-pipeline/src`
  must call `armResidency`. Both were sabotage-tested and both fail the build.
