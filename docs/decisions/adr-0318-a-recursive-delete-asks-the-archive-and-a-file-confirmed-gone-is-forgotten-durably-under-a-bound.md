---
id: D318
title: "A recursive delete asks the ARCHIVE; a file confirmed gone is forgotten DURABLY, under a bound"
status: accepted
date: 2026-08-31
supersedes:
applies-to:
  - packages/addon-pipeline/src/recorder/segment-store.ts
  - packages/addon-pipeline/src/recorder/relocate-engine.ts
---

## Context

The 2026-08-30 drain of `recordingsLow:default → recordingsLow:ssd` finished and
D295's coverage guard fired exactly as designed:

```
jobId=43fb2e58…  archiveSegments=63346  seen=63346  moved=52272
rowsReconciled=523  remainingSegments=11074  remainingBytes=5650495197
```

`relocate skipped missing source` was logged **11 074 times** — the shortfall to
the file, every line carrying `tags: { deviceId }`. So the mover was blameless
and the finding was underneath it: **the durable ledger claimed 11 074 segments
and 5.65 GB that are not on disk.**

Two facts about those rows, both measured rather than assumed:

- **They are whole HOURS.** Aggregating the 11 074 warnings by
  `(device, hour)` gives 55 groups, 32 of them at 347–360 segments — an entire
  hour of `low` at 10 s segments — spanning 2026-08-29 **08:59 → 12:44:30 UTC**
  across 13 cameras.
- **The hole is root-wide, not profile-scoped or drain-scoped.** On the hub,
  `/recordings/<dev>/high/2026/08/29/` holds hours `00–08` and `13–23` and is
  missing `09,10,11,12` — the same four hours, for a location
  (`recordings:default`) that this drain never touched, on a root whose
  2026-08-27 and 2026-08-28 footage is complete. The files are absent from
  `/media-fast` too, so they were not mis-stamped onto the other root.

**No oldest-first deleter can carve a middle slice like that**, which rules out
retention, disk-pressure eviction as a whole-round explanation, the redundancy
sweep and the relocation itself. The `/recordings` hole between 08:59 and 13:00
on 2026-08-29 is therefore **not attributed** to a code path here — see
(planning repo: sessions/sessions.md) for the full elimination and the remaining <!-- drift-ok: moved to the private planning repo -->
volume-level hypothesis.

What the enumeration DID find is the one deleter in this repo that can remove
more files than it names, and it is capable of exactly this shape:

**`SegmentStore.evict`'s bucket fast path.** When a round's victims cover every
segment an hour bucket holds, one `fs.rm(recursive)` replaces hundreds of
per-file deletes (R4). "Every segment it holds" was decided from
`RecordingIndex.bucketCounts` — RAM. Since D287 that index holds the live tail
plus whatever a reader hydrated, so for a closed hour the resident count is a
FRACTION of the disk. The comparison then shrinks on BOTH sides at once — the
count and the resident victims — so it reads EQUAL, the branch fires, and the
`rm -rf` takes every file the round never enumerated. Those files leave disk;
their durable rows do not, because `onDeindexed` is fed the rows the CALLER
listed, never what the filesystem actually lost.

**What was tried first and was a paragraph.** The residency guard's allowlist
already licensed this call site, with a justification that is simply false:

> *"Under-residency makes the count 0 or short, and `bucketFullyEvicted` then
> returns false — it declines to remove the directory. The failure direction is
> a leftover empty directory, never a deleted one that still held files."*

True only if one side shrinks. Nobody tested it. A licence with a reason nobody
checked is the paragraph D295 exists to replace with a guard.

And the mover's own ENOENT branch called `index.removeSegments` — RAM — and told
the ledger nothing, so `storageMigration.residue` kept reporting the ghosts,
they survived every restart, and the next drain would walk to each of them, fail
again, and log 11 074 more warnings, forever.

## Decision

**"Does this round cover the whole bucket?" is an ARCHIVE question, and only
`SegmentHourLedger`'s own hour row may answer it.** A bucket is fully evicted
iff every path the durable `(deviceId, profile, locationId, hour)` row lists is
a victim of this round. An archive that cannot be asked — no ledger, a failed
point read, or a row that lists nothing — REFUSES the fast path and the round
falls back to per-file deletes; it never falls back to the resident index, whose
failure direction here is a recursive delete computed from a fraction of the
truth (D295). `RecordingIndex.bucketCounts` is DELETED rather than left beside
its replacement.

**And a source file the mover confirmed absent is forgotten DURABLY, under a
bound, and reported.** `RelocateEngine` collects the hour's ENOENT rows and
drops them through `SegmentHourLedger.dropSegments` — the same durable forget
eviction uses, which already refuses an hour whose detail it cannot read. What
makes that trustworthy under D148 is that the observation is **per path**: the
mover built the absolute path from the ROW's own fields and `stat`ed exactly
that path (D296), rather than reading a directory that came back short. What
keeps it survivable is the **bound**, because per-path evidence is strong about
a path and weak about a MOUNT: a root that has gone away answers ENOENT for
everything and is indistinguishable from a location that is genuinely empty. One
job may forget `max(64, 25 % of its own census)` rows; past that it keeps moving,
keeps skipping, and REPORTS. A job with no census forgets nothing.

## Consequences

**What it costs.** One durable point read per hour bucket an eviction round
would `rm -rf` — against SQLite, not the media array, and the round is already
holding those rows. A bucket whose row cannot be read costs the per-file delete
loop it used to skip.

**What it forbids.** No recursive delete may be authorised by a resident-scoped
read. No mover may erase durable rows without a bound and a count.

**What it fixes in the accounting.** The ledger was wrong in both directions at
once. **Over**, by 11 074 segments and 5 650 495 197 B that do not exist —
**17.5 % of the rows in the drain's scope** (11 074 of 63 346), and 0.53 % of
the 1 073 998 160 900 B the ledger reports for the whole `/recordings` eviction
domain. **Under**, by
523 rows whose name understates their file (D307): the two measured examples run
2.86× and 2.90×, so that error is small in row count and large per row. Both
sums feed `StorageEvictableProvider`, which is the quota and disk-pressure
authority — so this disk has been deleting real footage to relieve pressure from
5.65 GB of footage that was already gone, while under-counting the files it did
keep. Only the over-count self-corrects here, and it does so by construction:
`hourAggregate` recomputes the hour from the paths it is handed, so `census`,
`getStorageUsage`, the evictable provider and `residue` all pick up the
corrected figure the moment the row is written, with nothing to recompute
afterwards. The under-count is D307's, and only a rename fixes one.

**What must now be true elsewhere.** The bound clears at most a quarter of a
location per drain, so a location as wrong as this one needs two passes — and
`ghostsKept` on the terminal coverage line is what tells the operator to run the
second one. The ghost rows already on the hub are cleared by re-running the
drain, not by a migration.

## Enforcement

`packages/addon-pipeline/src/recorder/__tests__/evict-bucket-archive-truth.spec.ts`,
whose fixture is the shape that let this ship: **a partial index and a fuller
archive**, never one where the two agree — under the defect every assertion
passes when residency is complete. It pins that a round naming 1 of 5 does not
`rm -rf` the hour, that the fast path still fires when the archive agrees (R4 is
not deleted, only re-based), that an unanswerable archive and an absent one both
refuse, and that an hour row listing nothing is not a vacuous licence.

`packages/addon-pipeline/src/recorder/__tests__/relocate-ghost-forget.spec.ts`
pins the durable drop, the count on the job record, the budget refusal with its
`stillMissing`, the per-file `forgotten` flag, and that a node with no ledger
forgets nothing even when an operator sets a budget.

Every implementing line was reverted and the matching assertions confirmed red:
the archive cover test (3), the unanswerable-archive refusal (1), the no-archive
refusal (1), the empty-row refusal (1), the current-hour guard (1), the durable
`dropSegments` call (2), the job counter (2), the budget clamp (1), the
no-ledger budget arm (1), the budget-reached warn (1) and the per-file
`forgotten` flag (1). Two of those cases were ADDED because the first disarm
pass showed them green.

`scripts/check-recorder-index-residency.ts` catches the regression structurally:
the `bucketCounts` allowlist entry is gone and the method with it, so a future
resident read at this call site is unlicensed and fails CI.
