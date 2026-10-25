---
id: D295
title: "The LEDGER is the archive; `RecordingIndex` answers only about what is RESIDENT"
status: accepted
date: 2026-08-30
supersedes:
applies-to:
  - packages/addon-pipeline/src/recorder/recording-index.ts
  - packages/addon-pipeline/src/recorder/relocate-engine.ts
  - packages/addon-pipeline/src/recorder/evict-select.ts
  - packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts
---

## Context

D287 stopped the recorder's boot from loading the archive. `RecordingIndex` now
holds the live tail, the hours a reader hydrated on demand, and whatever an
operator rescanned — nothing else. That was correct and necessary (boot 256 ms →
44 ms, and it is the prerequisite for the 30 TB array), and it changed what
every existing read of that index MEANS. None of them changed with it, and
nothing announced the difference: a partial answer and a complete one are the
same array.

**Confirmed in production, 2026-08-29.** A storage migration drained
`recordingsLow:default → recordingsLow:ssd`. Its work list came from
`this.deps.index.segmentsOnLocation(from.id)`.

| | |
| --- | --- |
| RAM index, **all** locations and profiles | **29 218 row slots** |
| ledger, `recordingsLow:default` **alone** | **145 664 segments / 846 hours / 80.3 GB** |

The mover ran 723 s, processed its short list, and correctly reported `done` —
it finished the work it was given. 80.3 GB stayed on the source and not one
line said so. The bytes were never at risk (D291 orders copy → verify → durable
repoint → delete, and the source stayed live and readable); what failed is that
the operation did a fraction of its job and claimed success.

**What was tried first and was not enough: a paragraph.** §P4 of
`docs/design/plans/2026-08-29-memory-cpu-execution-plan.md` had named this
exact defect days earlier — for a *different* caller (`pruneFootage` reads the
same partial index, so retention would silently under-prune the day an age
policy is set). It named one caller. Nobody looked for the others, and the one
that fired was not the one named.

## Decision

**The durable hour ledger (`recorder:segment-hours`) is the authority for what
EXISTS. `RecordingIndex` is the authority for what is RESIDENT, and for nothing
else.** An operation that reasons about the archive — a drain, a retention
prune, a footprint delete, a total, an "oldest" — reads
`SegmentHourLedger.census` for the count and `.streamSegments` for a bounded
oldest-first walk. It never derives that answer from the index.

Three rules ride with it:

1. **The archive read is PAGED, never a whole collection.** `streamSegments`
   walks a keyset cursor on `hourStartMs`, `ARCHIVE_HOUR_PAGE` hour rows at a
   time, and refuses an unscoped scope outright. `offset` paging is
   specifically forbidden here: both consumers mutate the set as they walk it,
   so page two at `offset: N` starts N rows past a set that just lost its first
   N — the same silent skip, rebuilt one layer down. The unbounded form is the
   ~460 MB boot query D287 deleted.
2. **"I saw N of M", every time.** M comes from the ledger. The relocate job's
   `filesTotal` is now the census, not the resident count; the retention pass
   logs `archiveSegments` / `seen` / `selected` per camera; and a drain
   RE-CENSUSES its scope at the end, because footage still standing on the
   source after a drain is the one fact that cannot be explained away. A
   mismatch is a `warn`.
3. **A missing archive REFUSES; it does not fall back to the index.** A node
   with no ledger cannot prune. The failure mode of falling back is a DELETE
   computed from a tenth of the truth, and it looks exactly like a correct one.
   The relocate mover keeps its RAM fallback — a mover that will not move is
   worse than one that moves what it can see — but the branch announces itself
   and its coverage is reported UNKNOWN, never complete.

## Consequences

What it costs. A retention prune is now bounded per pass
(`PRUNE_MAX_SEGMENTS_PER_PASS`) and continues on the next sweep; the drain pays
one aggregate at the start and one at the end, plus one small probe query per
page. The array is not touched by any of it — these are SQLite reads.

What it forbids. No caller may treat an `archive-shaped` index read as the
archive. `selectEvictions` (the array-shaped retention selector) is DELETED
rather than left beside its replacement: a leftover that describes the right
design reads as verification.

What must now be true elsewhere. The four remaining archive-shaped callers are
licensed, not blessed — `getStorageUsage`'s per-camera row and `statusFor`'s
`storageBytes` UNDER-REPORT today, and the placement pass derives its work set
from `accountingByProfile`, which since D287 drops a (camera, profile) with no
resident rows from the durable placement blob entirely. Each is named with its
verdict in `docs/design/2026-08-29-recorder-index-at-scale.md` §3.

## Enforcement

`scripts/check-recorder-index-residency.ts`, wired into
`.github/workflows/ci.yml`. It asserts the DECLARATION, not the outcome:

1. every public method of `RecordingIndex` carries a `@residency` verdict
   (`archive-shaped` / `resident-scoped` / `mutation`) — a new method cannot be
   added without classifying it;
2. every call site of an `archive-shaped` read is in the guard's allowlist with
   a reason;
3. an allowlist entry whose call site is gone fails too, so a licence cannot
   outlive its caller.

Verified by disarming all three: adding an unlicensed `piles()` call, removing a
verdict, and letting an entry go stale each fail the guard.

`packages/addon-pipeline/src/recorder/addon/__tests__/archive-is-the-authority.spec.ts`
pins the behaviour with the fixture shape that matters — **a partial index and a
fuller ledger**, never one where the two agree, which is what let this ship. It
asserts the mover moves the LEDGER's 18 and not the index's 3, that every query
it issues is keyed or bounded by `ARCHIVE_HOUR_PAGE`, that a short drain shouts,
that `pruneFootage` deletes the ledger's expired set, and that a node with no
archive prunes nothing. Reverting each implementing line turns exactly the
matching assertions red.
