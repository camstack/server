---
id: D300
title: "A drain is a first-class operation, and a mover reports N of M where the operator reads it"
status: accepted
date: 2026-08-30
supersedes:
applies-to:
  - packages/system/src/builtins/storage-orchestrator/storage-migration-coordinator.ts
  - packages/types/src/interfaces/relocate.ts
  - packages/addon-post-analysis/src/pipeline-analytics/media-relocate-engine.ts
---

## Context

D292 split a storage migration into a seconds-long cutover and an hours-long
drain, and D295 gave the footage mover an honest denominator. Both were right,
and together they left the operator with an operation that could not be managed.

**The status surface stops at the phase.** `StorageMigrationSection` showed
`phase: draining` and the move's `state`. The mover's `filesMoved` /
`filesTotal` / `bytesMoved` existed — in the engine — and reached exactly one
place:

```
relocate progress {"jobId":"cefb41c2-…","filesMoved":3588,"filesTotal":136885,"bytesMoved":2505552556}
```

a Loki line. On the live hub that is 136 885 files at ~4.1 MB/s: five hours in
which the Admin UI said one word and never changed it. Worse, `ACTIVE_PHASES`
did not contain `draining` at all, so for the whole long half there was no
spinner, no Cancel button, and the destination selects were re-enabled
underneath a running job.

**And the drain had no door.** After a migration reaches `done` the destination
IS the default, so `storageMigration.start` refuses it —
`Storage location "recordingsLow:ssd" is already the "recordingsLow" default` —
which is correct: there is nothing left to repoint. But a drain can fail, be
cancelled, be interrupted by a restart, or (2026-08-29) complete against a work
list that was a tenth of the archive. On 2026-08-30 the only way to finish one
was to call `recording.relocateFootage` by hand over admin tRPC: no plan, no
UI, no status, and no record that it had happened.

**What was considered first and rejected: making `start` idempotent** — let an
already-repointed class fall through to `draining`. It reads as the smaller
change and it is the worse one. It deletes the refusal that stops an operator
re-repointing a migrated class, and it makes one verb mean two things depending
on state, so the confirmation an operator reads ("pauses the writers, copies,
verifies, then repoints the defaults") would be a lie half the time.

## Decision

**Progress belongs on the polled job record, and a drain is its own verb.**

1. **The coordinator folds the mover's counters onto its durable move**
   (`StorageMigrationMove.progress`). It costs nothing: `waitForMoves` already
   fetches the whole `RelocateJob` on every tick to read `state`. There is **no
   progress event** — events are telemetry and may be dropped (D8/D11), and a
   dropped progress event is indistinguishable from a stalled mover, which is
   the exact failure this ends. The record therefore also says, afterwards, how
   far a move actually got.
2. **`storageMigration.movers` reads the engines directly**, for the case a
   fold cannot cover: a mover armed by hand has no job to fold into. It carries
   a hub-stamped `observedAt` so a rate is `bytesMoved` over
   (`observedAt` − `job.startedAt`) with **both ends on the hub's clock**.
3. **`storageMigration.drain` runs the second half alone and CANNOT repoint.**
   Its job starts at `phase: 'draining'` with `repointed: true`, so the
   `repointing` / `refreshing` / `resuming` blocks of the state machine are
   behind it and unreachable, and it mints no lease and pauses no participant
   (`runsUnleased`). `start` keeps its refusal, unchanged and still meaningful:
   the two verbs are disjoint and neither can be mistaken for the other.
4. **The work list comes from the ARCHIVE, and so does the offer.**
   `storageMigration.residue` is a `SegmentHourLedger.census` per non-default
   location (`recording.getRelocateResidue`), through the same
   `relocateScope` derivation the mover's own work list and `filesTotal` use.
   A class with an empty source produces no entry, `drain` refuses it, and the
   UI has nothing to render — the button cannot be offered for a source that is
   already empty. An **unmeasurable** residue is still offered, marked unknown:
   `null` is not zero (D295), and dropping it would hide the one case an
   operator most needs to act on.
5. **The media lane gets the denominator it never had.**
   `MediaRelocateEngine.filesTotal` was hard-coded `null`. It is now a
   pre-count over the same `selectsRow` predicate and the same `collectionsFor`
   list the pass walks — one derivation, two consumers, so M and N can never
   count different populations. That count is also the media lane's residue.

## Consequences

What it costs. One extra ROW walk (no blobs) before a media pass, paged at 200
— the same walk `countUnstamped` already does at plan time. One ledger
aggregate per non-default location per `residue` read. Nothing touches the
array.

What it forbids. No progress event, ever, on this path. No second verb that
repoints. No residue derived from `RecordingIndex` — a drain sized off the
resident index is the D295 defect, and a *button* sized off it is that defect
with a click target.

What must now be true elsewhere. `filesTotal` stays `null` wherever there is no
honest M — a windowed (`sinceMs`) footage job, a node with no ledger, a failed
pre-count — and every consumer renders that as "unknown", never as 0 % or
100 %. `StorageMigrationMove.progress` is last-observed, not live: a mover the
addon forgot across a restart is re-armed and its counters restart from zero,
which is the truth about the new mover.

## Enforcement

- `packages/system/src/builtins/storage-orchestrator/__tests__/storage-migration-coordinator.spec.ts`
  — the progress fixture ADVANCES its counters across polls and the assertion is
  that the reading changed more than once and landed on the denominator. A
  fixture stuck at one value would be satisfied by a folded constant. Plus: a
  drain leaves the default where it was and calls no `pause`/`resume`/`refresh`;
  a completed migration whose source still holds rows offers the resume and one
  whose source is empty refuses it; an unmeasurable residue is still offered.
- `packages/addon-pipeline/src/recorder/addon/__tests__/archive-is-the-authority.spec.ts`
  — the residue over the same asymmetric fixture D295 uses: 18 in the ledger, 3
  resident. Pointing it at the index answers 3.
- `packages/addon-post-analysis/src/pipeline-analytics/__tests__/media-relocate-engine.spec.ts`
  — the media pre-count equals what the pass moves, per mode, and agrees with
  `countUnstamped` for `seal`.
- `packages/addon-admin-ui/src/components/recordings/migration/__tests__/` —
  two consecutive polls render two different numbers; `draining` offers Cancel;
  an absent residue renders no drain affordance at all.

Every implementing line was reverted and the matching assertions confirmed red:
the fold (3), the drain's starting phase (3), the empty-residue refusal (1), the
unknown-residue entry (1), the mover ownership map (2), the recorder residue's
archive read (2) and its class scope (1) and its unknown answer (1), the media
denominator (1) and its predicate (2), `ACTIVE_PHASES` (1), the rendered summary
(3), the drain affordance gate (1), the unknown wording (1), and four rules in
`mover-progress` (2/2/1/1).
