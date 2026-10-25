---
id: D387
title: A new disk is NOTICED, PLANNED onto, and what is still not moving is said out loud
status: accepted
date: 2026-09-07
supersedes:
applies-to:
  - packages/types/src/enums/event-category.ts
  - packages/types/src/interfaces/event-bus.ts
  - packages/system/src/builtins/storage-orchestrator/storage-orchestrator.addon.ts
  - packages/addon-pipeline/src/recorder/addon/placement-planner.ts
  - packages/addon-pipeline/src/recorder/addon/location-refresh.ts
  - packages/addon-pipeline/src/recorder/addon/pending-writer-moves.ts
---

## Context

On 2026-09-07 the operator added a second `recordings` location on the hub —
`recordings:recordings-high-4tb`, root `/recordings-2`, an empty 4 TB disk —
next to `recordings:default` (1.9 TB, 89% full). Nothing happened, in three
separate ways.

**1. The recorder did not notice the disk existed.** `refreshLocations()` was
reachable from `onHubReachable`, the storage-migration path and the
`rescanStorage` cap method, and from nowhere else. The storage orchestrator
emitted no event on `upsertLocation` / `deleteLocation` — there was no such
event category at all — so an operator working in the admin UI got no signal of
any kind. The new disk entered the placement pool only after `rescanStorage` was
called by hand.

**2. Once it was in the pool, the planner would not put anything on it.** The
census printed the disk with `assignments: 0` and the "this location is ENABLED
but holds no assignment" warning, and then said nothing for twenty minutes:
no `plan moves a profile to another location` line, ever. The environment was
ruled out first — `storage.resolve` answered `/recordings-2`, `statfs` inside
the container reported 3.65 TB free of 3.7 TB, the directory was writable, the
location carried neither `readOnly` nor `maxUsedGb`, and the two roots were
distinct so the same-root alias demotion did not apply. The headroom arithmetic
said the full disk's target share was under 1% while it held 100% — 99
percentage points past the 15 pp hysteresis band.

The cause was in `planPlacement`, and it is a two-part trap:

- `PlacementDemand.dailyBytes` is a MEASURED rate, produced by
  `dailyBytesFor` from the recorder's RAM index. Since D287 that index holds
  the live tail plus whatever a reader hydrated, so it is **0** for every
  camera nobody has viewed since boot — most of a fleet, most of the time.
- `bytesOf` read `const anyRate = demands.some(d => d.dailyBytes > 0)` and
  then returned `d.dailyBytes` verbatim. So ONE measured camera in the pool
  flipped the whole pool to byte weighting and made every unmeasured camera
  weigh **zero**.

Phase C moves the SMALLEST demand on the overloaded location — which is one of
those zero-byte ones. Moving 0 bytes moves neither side towards its target, the
strict-improvement check (`if (after >= before) break`) therefore failed, and
the rebalance broke on its FIRST iteration. Every 30 s tick, forever, in
silence: 19 of 19 assignments pinned to an 89%-full disk with an empty 4 TB one
beside it. The strict-improvement check is not the bug — it is what stops a lone
demand ping-ponging between two equal locations — the weightless demand is.

**3. And even with a corrected plan, nothing would have moved on disk.**
Placement applies at writer-attach boundaries only, because `.rec-tmp` staging
lives under the chosen root so the finalize relocate is a same-filesystem
rename. A camera on a schedule re-attaches within minutes. A continuously
recording camera never re-attaches at all: its plan can name a new disk forever
without one byte following it, and nothing anywhere said so.

## Decision

Three rules, one per failure.

**A demand nobody has measured is never weightless.** An unmeasured demand
weighs the MEDIAN of the demands that were measured in its pool, and one unit
when nothing in the pool was measured at all (unchanged count balancing). No
code path may reduce a demand to zero bytes while others carry weight — a
zero-weight unit is invisible to every balance calculation and silently wedges
any greedy loop that reaches for the smallest one.

**A consumer that resolves storage locations converges on its OWN timer, and
the change event only makes it fast.** `EventCategory.StorageLocationsChanged`
is emitted by the storage orchestrator on every `upsertLocation` and
`deleteLocation`; it is telemetry (D8/D11), carries no row, and every consumer
re-reads `listLocations` for itself. The recorder coalesces doorbells over
`LOCATION_DEBOUNCE_MS` and re-resolves anyway every `LOCATION_BACKSTOP_MS` on
the placement pass it already runs. A design in which the event is the only path
is forbidden: a dropped event must cost latency, never blindness.

**A plan that cannot reach the disk is REPORTED, per camera, for as long as it
stands.** A live writer is never repointed and the fleet's writers are never
restarted to apply a plan; instead every (camera, profile) whose live writer is
under a different root than its plan is logged with `tags: { deviceId }`,
latched on the pending set, plus one aggregated `storage` alert.

## Consequences

**On the weighting.** The plan now moves work onto a fresh disk on a fleet where
almost nothing is measured — which is the normal state. The cost is that an
unmeasured camera is ASSUMED to cost a typical camera's bytes; if it turns out
to be a 24/7 4K camera the next pass corrects it, hysteresis permitting. The
median (rather than the mean) keeps one outlier from defining "typical". The
strict-improvement check and the 15 pp band are untouched, so stickiness is
unchanged.

**On the doorbell.** Two paths now call `refreshLocations`, so it must stay
idempotent — it already is, and it clears the volume-probe verdicts, which is
correct: a location set that changed is exactly when a remount should be
re-probed. A backstop refresh is one `listLocations` plus one `resolve` per
location every five minutes; a bulk edit in the wizard rings once per row and
spends one refresh. Any future consumer of the event inherits the same
obligation: coalesce, and converge without it.

**On the report, and why not a repoint.** This is the deliberate half-measure.
Repointing a live writer is not available: the whole placement model exists
because moving a running writer's target turns every finalize into the EXDEV
copy+unlink fallback — 2× disk writes on the hot path, the F1 regression.
Detaching and re-attaching writers to apply a plan IS available, and is
rejected: every restart is a recording gap, and applying a fleet-wide rebalance
that way means a gap on every affected camera at once, on the very day the
operator added a disk to relieve pressure. So a pending move is made visible
and left to the operator, and the log line names the remedy (toggle that
camera's recording switch, or restart the recorder — one gap, on the camera the
operator chose). The honest cost of this decision is that a continuously
recording camera's planned move can stand indefinitely; what is no longer true
is that it stands invisibly.

## Enforcement

Tests, all of which fail on the code as it was:

- `packages/addon-pipeline/src/recorder/__tests__/placement-planner.spec.ts`
  — the 19-demand two-disk shape with one measured camera, and the minimal
  two-demand case that pins "an unmeasured demand weighs a measured peer".
- `packages/addon-pipeline/src/recorder/__tests__/placement-second-disk.spec.ts`
  — the same fleet through the real `PlacementService`, with the capacities
  the live disks reported to `statfs`.
- `packages/system/src/builtins/storage-orchestrator/__tests__/storage-locations-changed-event.spec.ts`
  — asserted through the cap surface the admin UI calls, not the helper.
- `packages/addon-pipeline/src/recorder/__tests__/location-refresh.spec.ts`
  — coalescing, and convergence with NO event ever delivered.
- `packages/addon-pipeline/src/recorder/__tests__/pending-writer-moves.spec.ts`
  — including that `/recordings-2` is never attributed to `/recordings`.

No guard script. The weightless-demand rule is a property of one function and
is pinned by the planner tests; the "converge without the event" rule is
review-only for future consumers of `StorageLocationsChanged`, and its record
is this one.
