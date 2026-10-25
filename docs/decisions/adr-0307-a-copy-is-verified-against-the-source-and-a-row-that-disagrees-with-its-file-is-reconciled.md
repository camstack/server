---
id: D307
title: "A copy is verified against the SOURCE, and a row that disagrees with its file is reconciled — not carried, and never fatal"
status: accepted
date: 2026-08-30
supersedes:
applies-to:
  - packages/addon-pipeline/src/recorder/relocate-engine.ts
  - packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts
---

## Context

The production drain of `recordingsLow:default → recordingsLow:ssd` did not
stall. It **died**, on its 12 440th file of 110 749:

```
lane=footage  state=failed  files=12439/110749  bytes=5575814329
err=relocate verify failed:
    /media-fast/recordingsLow/618/low/2026/08/28/14/1787926410000-9966-274432.m4s
    is 783801B, expected 274432B
```

A targeted `stat` on the hub measured **783 801 B at the source and 783 801 B at
the destination**. The copy was byte-perfect. `copyVerified` compared the
destination it had just written against `srcBytes` — which came from the ledger
ROW, not from the source file — and `fs.copyFile` truncates and replaces, so the
destination *always* equals the source. **That comparison could only ever fail
when the LEDGER was wrong**, and it then reported a correct copy as corruption.

Three defects, not one:

1. **The reference was wrong.** The invariant is "the destination is a faithful
   copy of the source". The recorded number is evidence about the row.
2. **One row killed a 110 749-file job, permanently.** The copy was skipped only
   when the destination equalled the *recorded* size, so every restart
   re-copied the same file and re-failed on it. Not a transient stall — a fixed
   point.
3. **The ledger's SUMS are name-derived.** A segment's byte count is part of its
   filename (`segmentRelPath`); `hourAggregate` re-derives `bytes` from those
   names, and `StorageEvictableProvider` reads those sums to answer "how much is
   on this disk" under quota and disk-pressure eviction. A file that does not
   match its name therefore makes the ledger understate the disk — **and no walk
   can correct it**, because a walk re-parses the same name and agrees with
   itself. Only a rename can.

An `ls` of that one hour showed all nineteen neighbours matching their own names
exactly, and the odd one out holding a full 10 s segment (783 801 B) under a
name stamped at 274 432 B — a size a third of the way through the same segment.

## Decision

**A relocation verifies its copy against the SOURCE's own size, read from the
filesystem. A row whose recorded size disagrees with its file is RECONCILED —
the file is the fact — and the disagreement is reported per camera, counted on
the job record, and never fatal.**

Concretely, in `RelocateEngine`:

- `copyVerified` stats the source and verifies the destination against *that*.
  The recorded size survives in exactly one place: as the reference for a
  destination whose source is already gone, where there is nothing else left to
  compare against. That branch is what keeps copy-if-absent resumable.
- Reconciling means RENAMING, because the byte count is in the name. The
  destination file is renamed to its canonical name **before the ledger is
  touched**, so a crash mid-reconcile leaves the source wholly authoritative and
  the next run re-copies and re-renames. A path `segmentRelPath` cannot
  reproduce from the row's own fields is never renamed — it is moved as-is and
  the still-wrong number is logged.
- `SegmentHourLedger.repointSegments` takes two path sets per hour: what is
  LEAVING the source row and what is ARRIVING at the target row. They differ
  only for a reconciled row, and conflating them would leave the source row
  naming a file the caller is about to delete.
- `RelocateJob.rowsReconciled` carries the count to `storageMigration.movers`
  and, folded, onto `StorageMigrationMove.progress`. A migration that silently
  rewrote durable rows would be the same failure as one that silently skipped
  them (D295).

## Consequences

**What it costs.** One extra `stat` per file — the source's — on a path already
doing a `stat`, a `copyFile` and a `stat`. Negligible beside the copy itself
(the live drain runs at ~4 MB/s).

**What it forbids.** No mover may verify a copy against a remembered number. No
size discrepancy may fail a job, and none may pass in silence.

**What it does not do.** The **same-physical-root** branch is a pure row
re-stamp that opens no file, so it cannot measure one and deliberately does not
try: a `stat` per file would turn the one relocation that costs no I/O into a
full archive walk. Such a row is reconciled by the first move that actually
copies it.

**What must now be true elsewhere.** The ledger's per-location `bytes` is only
as true as the filenames under it, and this is the sole place that corrects one.
The correction propagates by construction — `hourAggregate` recomputes the hour
from the paths it is handed, so the target hour row, `census`, `getStorageUsage`
and the evictable provider all pick up the corrected number the moment the row
is written. Nothing needs to be recomputed afterwards.

**And the corollary for playback:** a segment whose name understates its file is
also read short by anything that sizes a range from `row.bytes`. Reconciling the
name fixes that too.

## Enforcement

`packages/addon-pipeline/src/recorder/__tests__/relocate-size-truth.spec.ts`,
whose fixture is the production shape: one file in an hour written larger than
its name while every neighbour matches. It pins that the job completes, that the
ledger's SUM (through a store fixture that honours `aggregate`) equals what the
disk holds, that only the wrong row is re-stamped, that the source is left
holding neither the file nor a resident index row, that a non-canonical path is
moved but never renamed, and that a re-run moves nothing.

Every implementing line was reverted and the matching assertions confirmed red:
the source-size reference (9), the reconcile itself (5), the canonical
round-trip refusal (1), the ledger's leaving/arriving split (4), the source
delete and de-index by `fromPath` (1), the counter (3) and the log line (1).

The old `relocate-engine.spec.ts` case "a failing job does not strand the queue"
used a 50 B file behind a 100 B row to MAKE a job fail. It now fails the job
with an unwritable destination instead — a fixture that depended on this defect
would have gone green for the wrong reason.
