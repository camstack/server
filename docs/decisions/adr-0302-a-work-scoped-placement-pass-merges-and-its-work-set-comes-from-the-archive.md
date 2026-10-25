---
id: D302
title: A work-scoped placement pass MERGES into the fleet-wide record, and its work set comes from the archive
status: accepted
date: 2026-08-30
supersedes:
applies-to:
  - packages/addon-pipeline/src/recorder/addon/index.ts
  - packages/addon-pipeline/src/recorder/addon/placement-store.ts
  - packages/addon-pipeline/src/recorder/addon/placement-service.ts
  - packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts
---

## Context

D295 named this one and left it open: §3a #9 of
`docs/design/2026-08-29-recorder-index-at-scale.md`, *"BROKEN — open, and it
writes"*.

Two halves, and the second is the dangerous one:

- **The work set was residency.** `recomputePlacement` built its demand list
  from `index.accountingByProfile(deviceId).keys()`. Since D287 the RAM index
  holds the live tail plus whatever a reader hydrated, so a camera nobody has
  viewed since boot contributes **no profiles at all** — and is never re-planned.
- **The write REPLACED the whole record.** `writeAssignments(state, blob,
  plan.assignments)` overwrites `assignments` wholesale, while the record is
  fleet-wide and the plan is work-scoped. So a (camera, profile) with no
  resident rows was **deleted from the durable placement blob** on the next tick
  that changed anything.

And the work set is narrower still than "the devices with footage".
`RecordingController.trackedDeviceIds` degrades to the ACTIVE cameras when
`enabledDeviceIds()` times out — it says so in a warn line — so one slow
settings door would have replaced the fleet-wide record with a plan covering
only the cameras that happened to be attached.

The doc comment on `recomputePlacement` still read *"over every profile each of
them actually has footage for"*. True before D287; a leftover after it, and
`CLAUDE.md` is explicit that a leftover describing the right design reads as
verification.

**Why not `census` per (camera, profile).** It is the right authority and the
wrong shape for a 30 s tick: one SQL round trip per pair, made SERIALLY over the
UDS door to `hub/sqlite-settings`. A 16-camera fleet is 48 trips per tick, and
it grows with the fleet — the same arithmetic that produced the measured
`durationMs: 240003` pass (see `PLACEMENT_STORE_TIMEOUT_MS`). And a
whole-collection read is the ~460 MB query D287 deleted.

## Decision

**A placement pass plans a SUBSET and the record it writes is fleet-wide, so it
MERGES: `writePlacementPass` applies the repoint, then the plan, over the stored
record, and removes nothing. Its work set is the ARCHIVE's answer —
`SegmentHourLedger.profilesWithFootage`, a fold over the always-resident T1 hour
summary — never the resident index. A node with no ledger REFUSES to plan rather
than falling back to residency, and says so.**

Three clauses:

1. **`writeAssignments` is renamed `replaceAssignments`** and documents that
   only a caller holding the WHOLE record may use it. Two callers qualify:
   `recordDecision` (which read the record one line earlier and changed one key)
   and `resetPlacementPlan` (which is clearing all of it on purpose). A replace
   now has to be typed out.
2. **The work set is answered from T1, not by a query and not from the index.**
   D287 made the hour summary permanently resident precisely so that
   O(writers × days) questions cost no I/O — ~10–15 MB and ~47 k rows even at
   30 TB. "Does this camera have footage for this profile" is exactly such a
   question, and a hydrated *segment* row is not needed to answer it.
3. **A pass that plans nothing SAYS SO** — latched on the reason, so it is one
   line per episode rather than one per 30 s tick on an idle node. An empty work
   set is also what a ledger whose load failed reports, and the two must not be
   the same silence.

## Consequences

What it costs. One fold over the T1 mirror per placement tick (~47 k rows at
30 TB, no I/O), in place of a map lookup. A stale assignment now survives
indefinitely rather than being cleaned up by the old replace — the trade is
deliberate: the "cleanup" was a silent delete of live cameras' plans, and a
stale key costs a string in a blob. The one visible side effect is that
`sweepUnassignedStaging` will not remove `.rec-tmp` under a root that a stale
assignment still names; a leftover staging tree, never a deleted one.

What it forbids. Deriving a durable placement record from `RecordingIndex`, and
replacing a fleet-wide record from a work-scoped plan. The only deletion a pass
may make is a repoint's rewrite (D298), which announces itself per camera.

What must now be true elsewhere. The residency guard's allowlist entry for
`addon/index.ts::accountingByProfile` is narrowed to the demand RATE only
(`dailyBytesFor`), which is self-normalising over whatever window is resident —
an unknown rate is a legitimate 0 the planner reads as "balance by count". The
entry stays, because the rate call stays; its `why` no longer licenses a work
set.

## Enforcement

`packages/addon-pipeline/src/recorder/addon/__tests__/archive-is-the-authority.spec.ts`
— the D295 pin file, extended with a fixture that is **a partial index against a
fuller ledger and never one where the two agree**: one camera, `high` resident,
`low` in the ledger only. The first case STATES the asymmetry (`['high']` vs
`['high','low']`) so a later change that makes the two agree fails there rather
than turning every case below it into a tautology. The others assert what must
NOT be lost — a named key, `102:low`, not a count.

`packages/addon-pipeline/src/recorder/__tests__/placement-census.spec.ts` pins
the merge from the service side, over a single-location class so no balancing
decision can be mistaken for a merge. (It carried the name
`placement-repoint.spec.ts` until D383 deleted the repoint mechanic; the merge
cases moved across intact.)

Disarmed against a 58/58 baseline: turning the merge back into a replace turns
**8** red — including `keeps the assignment of a camera the pass did not plan`
and `the pass does not delete the assignment of a profile it did not plan`, the
two that assert what must NOT be lost by name. Emptying `profilesWithFootage`
turns **2** red, one of them the fixture's own statement of its asymmetry.
Restoring each returns 58/58.
