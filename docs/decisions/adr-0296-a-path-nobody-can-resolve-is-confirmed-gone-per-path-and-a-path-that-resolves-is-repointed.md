---
id: D296
title: "A durable row on a location that no longer exists is confirmed PER PATH — and one file that still exists makes it a repoint, not a delete"
status: accepted
date: 2026-08-30
supersedes:
applies-to:
  - packages/addon-pipeline/src/recorder/addon/ghost-location-sweep.ts
  - packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts
---

## Context

This hub carries **32 hour rows / 2 131 segments / 15.1 GB** stamped
`locationId: "recordings:high"` — an id `storage.listLocations` does not have.
It knows `recordings:default`, `recordingsLow:default`, `recordingsLow:ssd`,
`eventMedia:default`, `galleryMedia:default`, `backups:default`, and nothing
else. The rows cover 2026-08-15 06:27 → 2026-08-17 12:48 across profiles `high`
and `mid` on devices 104, 107, 101, 102, 108, 1441 and 3836.

Each of the three consequences was verified against the code:

- **The bytes are never reclaimed.** The eviction domain is built from CURRENT
  location ids (`eviction-domain.ts`), so these rows are not victim candidates
  in any pass.
- **Playback cannot reach them.** `collectRangeSegments` drops rows whose
  location does not resolve (`recording-provider.ts:404`), and playback
  deliberately does not `stat` — so the operator gets a silent black window, not
  an error (D291, D293).
- **They lie about the retention floor.** The census `MIN(minStartMs)` includes
  them, so devices report an `oldestMs` two weeks before the evictable stream
  actually starts, and every arithmetic reading that floor is wrong (D295).

Eight paths were sampled by hand across five devices, both profiles and both
date edges, resolved against `recordings:default` — which shares the
`/recordings` root — and **all eight answered `storage.exists → false`**. The
files are gone. These are orphan rows.

**The likely origin, stated as unproven.** Until D293 shipped on 2026-08-29,
`deleteLocation` had no reference check of any kind: nothing stopped removing a
location record that still held the archive. That would produce exactly this
shape. It cannot be confirmed — Loki retains ~2 days and these rows are 13 days
old — so this record does not assert it. If that was the route, D293 closed it
and this pass is a cleanup plus a net under a `force` delete.

**The contradiction this had to resolve first.** D148 is explicit that the
ledger forgets an hour only when a **trusted walk** or an **eviction** confirmed
it gone. An unresolvable location has no root to walk: `storage.resolve` has
nothing to answer with, `hydrateDeviceFromStorage` skips it, and no eviction
will ever select it. Under D148 as written, a ghost row can never be forgotten
by any mechanism that exists — which is precisely why these have stood for
thirteen days while three separate sweeps ran hourly over them.

**What does not work as the confirmation.** Sampling. Eight paths out of 2 131
is what a human does to form a hypothesis; it is not what licenses a delete. Nor
is "the location does not resolve, therefore the footage is gone" — that
inference is exactly backwards for the case this has to survive, a location that
was renamed or re-created, where the bytes are still on disk and the row is the
only index of them.

## Decision

**A durable hour row whose `locationId` no longer resolves is confirmed by
resolving EVERY ONE of its paths against EVERY currently-resolvable physical
root. That per-path `storage.exists` sweep IS the trusted confirmation D148
requires — the same evidence a walk gives, gathered one syscall at a time
instead of one `readdir` at a time — and nothing weaker licenses the forget.**

The asymmetry between the two outcomes is the rule, not an optimisation:

- **One path found on a current root ⇒ the row is MIS-POINTED, not orphaned.**
  It is repointed to that root's location and the hour is finished with no
  further probing. A renamed or re-created location produces exactly this shape,
  and deleting here destroys the index of footage that exists — the failure D291
  was written to prevent.
- **Every path absent from every root ⇒ orphaned**, and only then is the hour
  forgotten.

So proving presence costs one probe and proving absence costs all of them. The
expensive proof is the destructive one, which is the right way round.

Riding with it:

1. **An error is not an absence** (D49). A probe that THROWS ends the hour with
   nothing decided. So does an unreadable hour detail, an unparseable path, a
   file found on two distinct physical roots, a durable write the ledger
   refused, and an hour still inside the live tail. Every refusal is named and
   counted.
2. **A pass that can resolve NO location does nothing and says so.** When
   `listLocations` is unreachable every id in the ledger looks like a ghost, and
   a pass that proceeded would propose forgetting the entire archive.
3. **The forget is verified by reading the ledger back**, not assumed from the
   call returning. `dropSegments` declines silently when it cannot read an
   hour's detail, and a caller that counted that as done would tell the resident
   index a row is gone that the archive still holds.
4. **Durable first, resident index second** (D291's ordering). A refused durable
   write leaves `RecordingIndex` untouched.
5. **Daily, and bounded per pass.** 16 hour rows and 4 000 probes, with a brake
   between probe batches.

## Consequences

**Why daily, against the sweeps that already exist.** The export janitor is
5 min because an expiry an operator can see must not linger. Retention and
redundancy are hourly because each cleans something that ACCRUES hourly —
footage ages continuously, a writer restart duplicates ~10 s of media every time
— so a missed pass compounds, and redundancy's lookback is sized at twice its
own interval for that reason. A ghost row accrues from nothing periodic: it
needs a location record to disappear out from under the ledger, which since D293
requires an operator to `force` past a refusal. Meanwhile the pass spends
`storage.exists` syscalls on the saturated recordings array — the resource every
live read competes for, where one `find` hung an SSH session on 2026-08-29. An
hourly cadence would spend that budget ~8 700 times a year to answer "nothing to
do". Daily clears the live 32-row backlog in two passes and is invisible the
rest of the time. It does not run at boot either: `startPeriodicPass` fires on
the interval only, and boot is when the staging reconcile, the ledger load and
the first retention sweep are already contending for the same disk.

**What it costs.** Proving one full hour absent is up to ~360 paths × the number
of distinct physical roots ≈ 1 000 probes. That is why the per-pass probe
ceiling exists and why an hour that would cross it is left UNDECIDED rather than
half-probed. Aliases of one physical root (`recordings:default` +
`recordingsLow:default`, both `/recordings`) collapse to one probe target via
`physicalRootKey`, so the common hub pays one probe per path, not two.

**Failure directions, both deliberate.** Over-caution leaves a ghost row
standing for another day: it is already invisible to playback and eviction, so
one more day costs nothing. Under-caution deletes the index of footage that
exists, and nothing recovers that except a full recursive walk of a 30 TB array
— if anyone ever thinks to run one. Every refusal in this pass is chosen in the
first direction.

**What it does NOT do.** It does not delete files. It never writes to a location
it did not read from. It does not repoint to a root when the file is on two of
them — that is a guess, and a wrong guess sends playback to the wrong disk. And
it takes no position on whether a ghost row's absence means the location was
deleted; it only reports what it probed.

**Running it against the live 32 rows is the operator's call.** The mechanism
ships; nothing in this change deletes production rows on its own schedule before
an operator has seen a pass summary.

## Enforcement

`packages/addon-pipeline/src/recorder/addon/__tests__/ghost-location-sweep.spec.ts`
— 28 tests, plus 3 in `segment-hour-ledger.spec.ts` for the one-hour detail read
this pass acts on.

The fixture is a real map of hour rows keyed exactly as `SegmentHourLedger` keys
them, **so a forget and a repoint leave visibly different state** — a forget
removes the source key and adds nothing, a repoint removes it and writes a key
at the target holding the same paths. A fixture that could not tell those apart
is how a "we never delete footage that exists" disarm passes while the code
deletes it, which happened three times in this repo the same week.

All 22 implementing decisions were disarmed and each turned the matching
assertions red, with the suite restored green afterwards. The one that matters
most — removing the presence short-circuit, so a file that still exists is
treated as absent — fails 7 tests, and the first of them asserts nothing about
repointing at all: it asserts that nothing was dropped and that every path is
still indexed. That test exists specifically so a disarm reports the DELETION
rather than "expected 0 to be 1", which cannot distinguish "did nothing" from
"destroyed the index".

No guard script. What a guard cannot check here is the judgement this record
exists for — that a per-path existence sweep is admissible evidence where a walk
is impossible — so that half is review-only, anchored to this record.
