---
id: D301
title: A stored placement assignment does not outlive a REPOINT of its class, and any disagreement with the class authority is reported per camera
status: superseded
date: 2026-08-30
supersedes:
applies-to:
---

> **Superseded by [D383](adr-0383-the-enabled-locations-of-a-class-are-its-write-set-and-there-is-no-default.md)
> on 2026-09-07.** This record was correct for the model it lived in: a class
> had a DEFAULT distinct from its pool, the two could disagree, and a stored
> assignment could outlive the operator's instruction. D383 deletes the default,
> so the disagreement this record detects cannot be expressed — an assignment
> naming a location outside the pool is invalidated by pool membership alone.
> The stamp (`defaultLocations`), `detectRepoints` and the divergence report are
> deleted; the reporting duty they carried survives as the placement census.
> `applies-to` is cleared because this record no longer vouches for any code.

## Context

On 2026-08-29 `recordingsLow` was repointed to `recordingsLow:ssd` as the
cutover half of a non-blocking storage migration (D292). Eleven of thirteen
cameras moved. **Two did not**: 1439 and 3839. 3839 is the sharp one — it wrote
1 909 segments to the SSD over seven hours and then went **back** to the old
location and kept writing there.

**Where it comes from in the code.** `PlacementService.place` prefers the stored
per-camera assignment, and `assignedLocation` invalidated it in exactly two
cases: the location is absent from the pool, or it is `readOnly`. Both mean
"this location is not a write target any more". Neither is true of a location a
class is being migrated *off*: it has to stay enabled and writable, because it
holds the history — and D292's own design says explicitly not to use
`config.readOnly` as the cutover lever, because `StorageEvictableProvider`
subtracts read-only members from the eviction domain.

So `isDefault` was never consulted anywhere on the honour path. A repoint
changes what `resolvePlacement` returns, and `resolvePlacement` is the
**fallback** for a camera with no assignment — not the authority over one that
has. The stored assignment therefore survived every attach, indefinitely.

**And it was silent.** `recordDecision` writes an audit row only when the
assignment CHANGES, and its per-attach log line reported `reason: 'resolved'`
for a camera pinned to the old disk — byte-identical to a camera correctly on
the current default. An operator read "migration done" while two cameras kept
filling the disk being migrated off. Nothing in the system could answer "did
3839 move?" except a disk graph.

**What was already there and was not enough.** `resetPlacementPlan` drops every
assignment, and the migration coordinator calls it at the cutover. Two holes:
it is reachable only through a coordinator *lease*, so a repoint by any other
route (an operator making another disk the default, a hand-edited store, a
default deleted) never reaches it; and clearing to empty hands every key back to
the planner as a *free* choice, which with two locations of comparable headroom
the deterministic tie-break can award straight back to the location the class
was repointed away from — the instruction undone by the tick meant to carry it
out.

**The option that was rejected: "delete them all on repoint".** An assignment
exists for a reason — an operator rebalance (D116), a failover away from a
broken volume, the planner spreading a class across two disks by headroom. A
blanket delete throws all of that away, and worse, it is *still* silent about
the residual disagreement the planner itself creates on the next tick.

## Decision

**The class authority is `resolvePlacement(pool, profile)` — the same function
the unassigned path uses — recorded in the placement blob as
`defaultLocations[type]` whenever a plan is written. A change of it is a
REPOINT, and a repoint REWRITES every assignment of that class onto the new
authority: per camera, in the log with `tags: { deviceId }`, and in one audit
row per class. Afterwards the plan is the authority again — and every
assignment that disagrees with the class authority is REPORTED, per camera with
its denominator, for as long as it stands.**

Four clauses ride with it:

1. **A repoint is a TRANSITION, not a policy.** It fires only while the stamped
   authority disagrees with the live one, and the pass that acts on it stamps
   the new one in the same write. After that, an assignment on a non-authority
   location is something the *planner* decided, and stickiness protects it —
   because a plan that moves a camera every tick costs a writer restart and a
   recording gap each time.
2. **A repoint REWRITES; it never deletes.** Unassigning is a free choice the
   tie-break can undo. Writing the new authority makes the operator's
   instruction the planner's *starting point*, which Phase A stickiness then
   defends.
3. **An ABSENT stamp is never a repoint.** A blob written before this field
   existed records no authority, and inferring "repointed from nothing" would
   throw away every deliberate assignment on the first tick after a deploy. The
   first pass stamps and invalidates nothing; every later change is a repoint.
   The consequence is deliberate and stated: this fix does not retroactively
   move 1439 and 3839 — the **divergence report** is what makes them visible,
   and the next repoint is what moves them.
4. **The attach boundary applies the same comparison as the tick**, so a repoint
   does not wait up to 30 s (or for ever, on a node whose placement pass is
   starved). It only reads; the tick is what persists.

## Consequences

What it costs. One extra record in the placement blob and one extra write, once,
on the first pass after this ships (a pass that moved nothing still writes when
the authority is not yet stamped — that write is what makes every later repoint
detectable). A repoint costs one burst of fleet-size log lines and one audit row
per class; a standing divergence costs one line per divergent camera per
episode, re-announced hourly (`PLACEMENT_DIVERGENCE_REPORT_MS`) rather than per
attach — 26 assignments re-announced on a 30 s tick is 52 lines a minute saying
nothing new (D277).

What it forbids. Honouring a stored assignment without comparing it to the class
authority. Deriving the authority from a second reading of `isDefault` instead
of from `resolvePlacement` — two readings drift, and the read-only and
missing-default cases are exactly where they would.

What must now be true elsewhere. `resetPlacementPlan` stays: it is the
coordinator's blunt instrument and it is still correct, and it is now the ONE
caller that legitimately replaces the fleet-wide record (D299). And a class
whose pool holds two writable locations still balances — the report says so
rather than the report existing to forbid it.

**What this does NOT fix.** The planner may still place a camera on a
non-authority location when that location has the most headroom. That is what
the planner is for; the change is that it is now a logged decision with a
per-camera line, instead of indistinguishable from a leftover. If an operator
wants a class on one disk only, the lever is the pool (`enabled`), not the
default.

## Enforcement

This record's spec was `placement-repoint.spec.ts`, deleted with the mechanic on
2026-09-07; what it pinned that still exists lives in
`packages/addon-pipeline/src/recorder/__tests__/placement-census.spec.ts`.

Every fixture seeds a REAL assignment for every camera it asserts on, so
"the camera moved" is distinguishable from "the camera was never assigned" —
the assertions are on where each named key lands, never on a count an empty
store would also satisfy.

Disarmed line by line against a 58/58 baseline, restoring 58/58 after each:

| Line reverted | Red |
| --- | --- |
| the attach-boundary comparison — i.e. the defect exactly as it shipped | 2 |
| the "honour it when it already names the authority" clause | 3 |
| the repoint REWRITE in the pass | 3 |
| the divergence report | 2 |
| the authority stamp in the write | 4 |
| the announce-once latch | 1 |
