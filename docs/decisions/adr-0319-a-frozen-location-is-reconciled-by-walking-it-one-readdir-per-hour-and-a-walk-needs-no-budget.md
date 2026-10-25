---
id: D319
title: "A FROZEN location is reconciled by WALKING it — one `readdir` per hour, both directions, no budget"
status: accepted
date: 2026-08-31
supersedes:
applies-to:
  - packages/addon-pipeline/src/recorder/addon/ledger-walk-reconcile.ts
---

## Context

D318 stopped the mover from re-walking the same 11 074 ghost rows forever: a
source file it confirmed absent is now forgotten durably, `max(64, 25 %)` of the
job's own census at a time. That bound is not arbitrary. A mover's ENOENT is
**per-path** evidence — strong about one file (D296), weak about a **mount**: a
root that has gone away answers ENOENT for everything and is indistinguishable
from a location that is genuinely empty. Without the bound, one bad mount would
let the system erase its own index.

The operator's reply was the right one:

> *"Invece di questo `ghostsKept`, non basta fare un passaggio delle cartelle? È
> un'operazione una tantum, il disco è bloccato in scrittura quindi non cambia,
> non serve fare alcuna magia."*
>
> [Instead of this `ghostsKept`, isn't one pass over the folders enough? It is a one-off operation, the disk is write-locked so it does not change, no magic is needed.]

**D148 already names a directory walk as trusted evidence** — it is one of the
two things (a walk, or an eviction) that may make the ledger forget. So under a
walk the bound is unnecessary machinery, not a safety net. And the walk is
cheaper by an order of magnitude, because it pays per HOUR rather than per FILE:

| | to answer "what is missing on `recordingsLow:default`" |
| --- | --- |
| the mover (D318) | **11 074** `stat`s — one per absence, discovered one at a time |
| a walk | **≈181** `readdir`s — one per claimed hour row, ≈55 of which answer ENOENT immediately |

The 55 comes from the drain's own forensics: aggregating the 11 074
`relocate skipped missing source` warnings by `(device, hour)` gives **55
groups**, 32 of them at 347–360 segments — whole hours of `low` at 10 s
segments, 13 cameras, one contiguous window 2026-08-29 08:59 → 12:44:30 UTC. The
cause is established since: the USB disk was **physically unplugged and
re-plugged onto another port at exactly 12:44** (`usb 1-9.4: USB disconnect` →
`usb 1-7: new high-speed USB device`), so the container wrote against a
filesystem that was no longer there. The footage is genuinely gone. This is not
recoverable data — it is a lying index.

And the walk answers a question no number of `stat`s can: it sees the **other
direction**, files on disk that no durable row names. The 11 074 were found only
as a side effect of a drain. There was no tool for *"does my ledger tell the
truth?"*, which is the operator's actual missing instrument.

**What a walk is not licensed to do, and why the licence has preconditions.** A
listing is strong evidence about an hour precisely because it is *complete* —
the hour's whole truth in one syscall, so "did I ask about every path" is
answered by construction rather than by a probe ceiling (D296). That strength
evaporates in exactly two situations, and both are situations this pass must be
able to detect rather than survive:

- On a **live** location a listing is a LOWER BOUND. `readdir` cannot tell "this
  hour is short" from "this hour is being written".
- On a **vanished mount** every hour directory answers ENOENT, which is the
  strongest ghost evidence there is and also the exact signature of the failure
  that produced these rows in the first place. The container's own experience on
  2026-08-29 is the case: the mountpoint directory stayed readable and answered
  ENOENT for everything under it.

## Decision

**A location the recorder may still WRITE to is not reconciled by a walk — it is
refused. A frozen one is walked, one `readdir` per claimed HOUR, diffed both
ways, and every row the directory does not hold is forgotten with NO budget,
under two preconditions that are checked rather than assumed.**

The whole rule, as `LedgerWalkReconciler.run`:

1. **Refuse a writable source** (`enabled !== false` and not `readOnly`), before
   a single listing. The remedy is one flag — the same `readOnly` a drain
   already sets — and refusing is what makes "no budget" honest. A live location
   already has a mechanism with a bound: D318's mover. A second, weaker copy of
   it here would be the redundancy this pass exists to remove.
2. **Anchor on the volume marker, and read it twice.** `PlacementService` writes
   `.camstack-location` at the root and it is the only thing in the recorder
   that can tell "the disk is mounted" from "the mountpoint directory exists".
   It is read once before the pass and **again before every hour that would
   forget anything** — the second read that must agree in the destroying
   direction (D49). Absent, unreadable, or naming a DIFFERENT volume stops the
   pass with nothing further forgotten. This is what separates a missing hour
   from a missing mount, and it is a mechanism rather than a heuristic.
3. **The claim set comes from the ARCHIVE, paged** (`streamSegments`, D295) —
   never the resident index, never a blind tree walk of the root. The ledger
   already knows which hours to visit, and the pass holds one page of hours at a
   time, so a location with hundreds of thousands of hours is never materialised
   into one array.
4. **Report, do not act, unless armed.** `apply` defaults to `false` and the
   report is the product. The dry run performs every check the armed run does —
   including both anchor reads — so it cannot report a vanished mount as ghosts,
   and it is how an operator sanity-checks the destructive run before
   authorising it.
5. **Orphans are reported and never deleted.** A bounded sample plus the full
   count, per camera. Deleting unclaimed footage on the strength of a first
   implementation is not a risk worth taking; an operator told "there are N
   files here the index does not know about" can decide.
6. **Every refusal is named and counted.** `live-tail`, `listing-error`,
   `path-mismatch`, `durable-refused` — a pass that skipped everything and a
   pass with nothing to do must never read the same. A `readdir` that THREW is
   not a `readdir` that came back empty.

**Sizes are NOT fixed here, deliberately.** The recorded byte count IS the
filename (`segmentRelPath`), so both sides of this diff read the same number and
the walk is structurally blind to a file that disagrees with its own name — the
523 rows D307 reconciled at 2.86× and 2.90×. Learning the real size means one
`stat` per file: 11 074 syscalls to re-answer what 181 `readdir`s already
answered, which is precisely the cost this pass was chosen to avoid, and
strictly worse than D307's mover, which holds the source `stat` for free because
it must read the file to copy it. So sizes stay D307's, and a rename stays the
only thing that fixes one.

## Consequences

**What it costs.** One `readdir` per claimed hour; one small marker read per
hour that would forget; one durable point read per hour it forgot (the
read-back). On `recordingsLow:default` that is ≈181 + ≈55 + ≈55 ≈ **290
syscalls** against the mover's 11 074, and the answer is complete instead of
incremental. It is paced (`WALK_HOUR_BATCH` listings between brakes, 100 ms) and
hour-scoped — never `readdir(recursive)`, which is the call that takes minutes
over `/recordings` and the reason a shell `find` hung an SSH session on
2026-08-29.

**What it forbids.** No walk of a location anything may still write to. No
forget on a listing whose volume anchor did not agree twice. No delete of a file
by this pass, in either direction.

**What it does NOT make redundant in D318, and this matters.** The mover's bound
still protects a drain of a **live** location — the one case this pass refuses
outright — and it is the only ghost forget that runs without an operator arming
it. A change that quietly removed that bound would be a regression dressed as a
simplification. What D319 does replace is the *follow-up*: `ghostsKept` on the
terminal coverage line told an operator to run a second drain, moving bytes for
a second time to clear rows that move no bytes at all. That is now one armed
walk, offline, with a dry run in front of it.

**What must now be true elsewhere.** The pass depends on `.camstack-location`
existing at every root it is pointed at. A location that has never been adopted
by `PlacementService` has no marker, and this pass will refuse it with
`anchor-absent` rather than walk it — which is the correct failure direction
(refusing to reconcile costs a day; forgetting an archive costs the archive) but
it does mean a brand-new disk is not reconcilable until placement has claimed
it.

**The correction propagates by construction.** `hourAggregate` recomputes the
hour from the paths it is handed, so `census`, `getStorageUsage`,
`StorageEvictableProvider` and `residue` all pick up the corrected figure the
moment the row is written — the same property D318 relies on. Nothing needs
recomputing afterwards, which is why this disk stops deleting real footage to
relieve pressure from 5 650 495 197 B of footage that was already gone.

## Enforcement

`packages/addon-pipeline/src/recorder/addon/__tests__/ledger-walk-reconcile.spec.ts`
— 35 tests. The fixture is a `Map<hourDir, Set<fileName>>` for the disk and a
separate `Map<hourKey, paths>` for the ledger, so **the two can disagree in both
directions at once**, which is the production shape. A fixture whose ledger is
derived from its disk cannot fail the way production failed.

Every assertion is on the **syscall shape**, never wall clock: how many
`listHour` calls, against which hour directories, in what order relative to the
anchor read and the durable drop. "It found the ghosts" is not the property —
"it found them with one call per hour, and only after the volume marker agreed
twice" is. The production shape is pinned directly: 55 whole `(device, hour)`
groups cost 55 listings, and the pass makes fewer filesystem calls than a tenth
of the rows it forgets.

Every implementing decision was reverted and the matching assertions confirmed
red: the writable-source refusal (1), the no-ledger refusal (1), the opening
anchor read (3 for the wrong refusal id, **19** for skipping it entirely), the
census refusal (1), the live-tail guard (1), the path-mismatch guard (1), the
listing-error refusal (1), the pace (1), the missing-directory tally (3), the
orphan collection (3), the orphan sample bound (1), the `.m4s` filter (1), the
whole-ghost-hour counter (3), the per-hour anchor re-read (1), the anchor-moved
comparison (1), the dry-run gate (2), the forget read-back (2) and its
`null`-is-not-confirmation half (1), `applyToIndex` (1), the hour bound (1), the
anchor stop ending the pass (1), the device scope narrowing (1), the per-camera
tallies (2), the camera summary line (1), the ghost warn line (2) and the
`tags.deviceId` on the orphan line (1).

**Two tests were ADDED because the first disarm pass showed `applyToIndex`
green** — the resident-index removal could be deleted entirely and 33 tests
still passed. The pair that now covers it pins the paths handed over AND the
ordering (durable write first, RAM second), which is the D291/D296 invariant a
"it forgot the row" assertion cannot see.

The first run of the suite also caught a real defect in the implementation
before it shipped: `readAnchor` returned `string | 'anchor-absent' |
'anchor-unreadable'` and the caller narrowed with `typeof anchor !== 'string'`,
which is never true — every refusal was being treated as a valid volume id. It
is a discriminated union now.

No guard script. What a guard cannot check here is the judgement this record
exists for — that a listing is admissible evidence only where the world is
frozen and the volume is the one the pass started on — so that half is
review-only, anchored to this record.
