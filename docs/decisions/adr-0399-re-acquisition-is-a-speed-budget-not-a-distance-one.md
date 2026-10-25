---
id: D399
title: Re-acquisition is a speed budget, not a distance one — and a spawn beside a coasting track is a logged event
status: accepted
date: 2026-09-08
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/tracker/**
  - packages/addon-post-analysis/src/pipeline-analytics/store/track-store.ts
---

> **Partially superseded by [D683](adr-0683-identity-is-decided-late-tracklets-split-when-in-doubt-a-deferred-linker-fuses-them-and-a-still-subject-belongs-to-the-registry.md)
> (2026-09-29).** The re-acquisition reach this record time-scaled (the
> rescue and resurrection proximity budgets) has no ONLINE equivalent in
> tracker v2 — a deferred linker judges reach (`LINK_REACH_*`,
> `linker.ts`) with the future in hand, not as a live budget on a coasting
> track. `pipeline/tracker/reacquire.ts` and `spawn-beside-coasting.ts` are
> deleted with the old tracker (D683 Task 21). The measurement that a frame
> count is not a clock — px-per-millisecond, not px-per-frame — still holds
> as the reason L1's own prediction (`MAX_PREDICTION_MS`) is time-bounded,
> not frame-bounded.

## Context

Eleven tracks the operator flagged `debug: true` on 2026-09-07, audited against
live rows in `docs/benchmarks/2026-09-08-operator-debug-track-audit.md`. <!-- drift-ok: the audit page is landed by the parallel agent working the best-shot/media half of the same audit; this worktree does not carry it. --> Four of
the eleven notes are one sentence: *"this one is the continuation of that one."*

Every distance the tracker was willing to tolerate was a flat multiple of the
subject's own box, with no time in it:

- `predicted()` extrapolated by `age + 1` **frames** with a **px-per-frame**
  velocity, and clamped drift to one box width;
- the rescue pass's proximity clause was `rescueCentroidFactor` (0.75) ×
  the box diagonal, at every gap.

`maxMissedMs` (4 s) is wall-clock and generous, and it was never the binding
constraint. The spatial gates were, and they meant two different things on the
same camera in the same minute. Camera 101 delivers at 7.9 fps against a nominal
10 (`framesDecoded 1053 / framesSkipped 737`) and its measured interval between
stored positions ranges from **56 ms to 2135 ms** — it is `armed:on-motion`, so
every cadence is a settle burst plus a poll, never a steady fps.

The consequence, stated as the audit found it: **a slow subject absent for two
seconds was re-acquired, and a brisk one absent for under a second was not.**

The proof is one pair. `7781d055` ends at 1788803546756 at
`[950.4, 0, 513.6×721.2]`; 880 ms later `267840a1` is born at
`[1760.4, 0, 709.2×654]` — the centroid moved **908.4 px** against a gate of
`0.75 × hypot(513.6, 721.2)` = **664.0 px**, at **IoU 0**. Meanwhile, *inside*
`267840a1`, the same tracker survived intra-track gaps of **1033 ms and
2135 ms** without complaint, because that subject was walking, not moving.

The corollary matters as much: the same loose flat gate that could not bridge a
fast subject across a poll gap **was** loose enough to hand one subject's id to
another one standing still nearby. Live track `27855a56` bound a second car
452 px away at IoU 0.058 in 159 ms, purely because `452 ≤ 0.75 × 738`. One
number was doing two opposite jobs.

**What was tried first and did not work.** The obvious reading — "the drift
clamp is one box width and the subject moved 810 px, so raise the clamp" — is
wrong, and the code says so. `7781d055`'s own history is 196 px over 1076 ms, so
its velocity extrapolated over 880 ms predicts ~160 px of drift; the clamp is
never reached, and no velocity model built from that history bridges 908 px. The
subject moved roughly five times faster than anything ever measured on it (the
audit's reading — a dropped frame, not acceleration — is the honest one). So a
richer velocity estimator would have changed nothing. What was actually needed
is an **uncertainty envelope**: not "where do I predict the track is" but "how
far away can something be and still plausibly be it, given how long it has been
gone".

A second finding blocked verification of any of this. `reportRefusal` logs a
detection the tracker DROPS and `reportBind` logs a salvage that BINDS. A new id
minted beside a live compatible coasting track produced **no line at all** —
nothing unusual happens there, a gate declines and then an ordinary spawn runs —
so on `46d4e09f` → `df1ca4b8` the audit reached two candidate mechanisms (a D378
`sameGroupAsMeasured` veto on an oscillating class, or the detection being
consumed by another track first) and could rule out neither.

Two more, cheap and in the same file: a `positions` array written by **two**
detector passes (full-frame and small-subject-recovery, D377/D378) that records
which wrote each entry nowhere — the audit identified five affected tracks by
the decimal expansion of the bounding boxes, because full-frame boxes are exact
multiples of 1.2 and recovery boxes are full-precision floats — and an array
appended in arrival order that seven of fourteen audited tracks had out of
temporal order.

## Decision

**A re-acquisition budget is a speed, not a distance.** Velocity is carried in
px per **millisecond**; a coasting box is extrapolated over the ELAPSED interval,
not over `age + 1` frames; and both the predictive-drift clamp and the rescue
pass's proximity clause are functions of that interval, bounded at both ends.
Every constant lives in `pipeline/tracker/reacquire.ts` next to the measured case
it answers, and every one of them reaches its ceiling at 1 s — a longer absence
buys nothing, because "the longer a subject was gone, the further away something
may be and still be it" is how one id ends up on two subjects.

**A reach bind may outrank the `isPlausibleBirth` veto only in a scene with one
candidate** — no other live track of the association group, and no other box of
that group on the frame. That veto exists because a stolen track corrupts the
plate, the travelled distance and the last frame of the track it was taken from;
with one track and one box there is nothing to steal from, and refusing buys a
fragment rather than safety.

**The resurrection pass keeps the flat budget.** It re-attaches a corpse, for a
flickering *stationary* object; elapsed time is not the variable there, and a
corpse is strictly weaker evidence than a live coasting track — the same
reasoning `resurrectionCrowdedIouThreshold` already encodes.

> **Amended by [D665](adr-0665-a-box-under-the-class-floor-may-continue-a-track-and-do-nothing-else.md)
> (2026-09-27).** The paragraph above no longer describes the code. The
> resurrection reach is now time-scaled on the graveyard's own scale (0.25
> diagonals/s, clamped to 0.75–2), and the plausible-birth veto is lifted for a
> sole subject. The trigger was camera 104, where 38% of re-splits were people
> returning after 4–12 s. The weaker-evidence argument still holds, and D665
> pays for it differently:
> - A veto-lifted bind emits `resurrectionScene: 'sole-subject-veto-lifted'`.
>   The face recognizer quarantines the held face (as for `multi-subject`).
>   Only for this scene it also stashes and resets the identity aggregate and
>   retracts its own identity label. A cosine-confirmed first face restores
>   both.
> - Sub-floor boxes count as peers.
> - `resurrectionTimeScaled` (per-camera tracking setting) restores this
>   paragraph's flat gate.

**A new id minted beside a live compatible coasting track is logged**, at `info`,
with `tags: { deviceId }`, both track ids, the IoU against last-known and against
the prediction, the centroid distance, the reach it was measured against, the
elapsed gap, and which gate declined — evaluated in the tracker's own order, the
first that says no.

**A stored position carries its provenance** (`source: 'frame' | 'recovery'`) and
its detection score, and `positions` is returned in **time order** at every read
boundary.

## Consequences

- **Track counts change on every camera.** Fewer person/vehicle fragments where
  a subject crossed a delivery gap; the reach clause is disarmed the moment a
  second same-group subject is on the frame, so busy scenes see little movement
  and quiet ones see the most.
- The predictive-drift clamp is now **tighter** at short intervals (a 0.25-side
  floor, against a flat 1.0 side before) and **looser** at long ones (a 2.0-side
  ceiling). A stale velocity can no longer fling a coasting box a full box width
  on a 56 ms frame.
- The rescue proximity gate is **tighter** below ~200 ms than the 0.75 flat
  factor it replaces. `27855a56`'s 452 px theft is now refused on geometry, not
  only by the birth veto — which is a second, independent line of defence where
  there was one.
- `reacquireTimeScaled: false` restores the pre-D399 behaviour exactly,
  including the per-frame extrapolation, for a bisect.
- The emitted `TrackedDetection.velocity` stays px **per update**
  (`velocity × emitIntervalMs`, arithmetically identical to the old
  `Δcentroid / frames`). `StateAnalyzer.velocityThreshold` is calibrated in those
  units and would read every subject on every camera as stationary against a
  px/ms number. Two representations of one quantity is the cost; the internal
  px/ms field is the source of truth and the conversion happens once, at emission.
- A third tracker log stream exists. It is sampled (first ten of each decline
  reason, then every tenth) and computes nothing when no observer is wired.
- `TrackPosition.source` and `.score` are optional: rows written before D399
  carry neither, and absent means unknown, never `frame`.
- The write path still appends in **arrival** order, and `totalDistance` is still
  accumulated on it. Sorting is a read-boundary rule only; changing what the
  write path measures is a separate decision.

## Enforcement

Tests, in
`packages/addon-post-analysis/src/pipeline-analytics/__tests__/sort-tracker-time-based-reacquisition.spec.ts` <!-- drift-ok: the old tracker's own enforcement, deleted with it (D683 Task 21) -->
and `track-position-provenance.spec.ts`. Every fixture is a live row from the
2026-09-08 audit replayed with its real boxes and its real millisecond gaps:
the `7781d055` → `267840a1` pair must bind; the same pair with a second subject
on the frame must NOT; `27855a56` must stay two vehicles; the 1033 ms and
2135 ms intra-track gaps must keep binding. The store's time-order rule is
verified by removing it and confirming the round-trip test fails.

Nothing else — the constants are review-only. There is no guard that would
notice a future edit re-introducing a flat spatial gate; the honest place to
catch that is this record.
