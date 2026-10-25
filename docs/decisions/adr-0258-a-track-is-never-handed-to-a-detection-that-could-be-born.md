---
id: D258
title: A track is never handed to a detection that could be born on its own; and growth is a claim about a YOUNG track, not about box shapes
status: accepted
date: 2026-08-27
supersedes:
---

> **Superseded by [D683](adr-0683-identity-is-decided-late-tracklets-split-when-in-doubt-a-deferred-linker-fuses-them-and-a-still-subject-belongs-to-the-registry.md)
> (2026-09-29).** L1 no longer performs a proximity or growth rescue at all —
> an ambiguous pairing ends the tracklet and lets the detections spawn new
> pieces; whether two pieces are one subject is a deferred linker's decision,
> made with the future in hand, never an online reach budget.

## Context

The tracker swapped the identity of two cars. Track `59dfb972-91ff-42c1-90f2-861b5a3ddb91`
was a parked car A; on one frame A's own detection was absent and a *different*
car B appeared 573.8 px away, 106 ms later, at IoU 0.0077. Every gate refused
except the last:

| gate | value | verdict |
| --- | --- | --- |
| stage 1, `iouThreshold` 0.3 | IoU 0.0077 | refuses |
| rescue, `rescueIouThreshold` 0.1 | 0.0077 | refuses |
| rescue, `rescueCentroidFactor` 0.75 | 573.8 > 0.75 × 529.8 = 397 | refuses |
| `growthAdjacentMatch` | areas 2.07 ≥ 1.5 · inter/smaller 0.024 < 0.5 · 573.8 ≤ 1.35 × **845.3** = 1141 | **MATCH** |

The budget was `factor × max(trackDiag, detDiag)` — **the bigger the intruder,
the further it could reach**. A second live case, `27855a56-c388-4163-8654-96d9c2f06989`,
went through the *other* clause: 452 px in 159 ms at IoU 0.058, accepted because
452 ≤ 0.75 × diag(589, 445) = 553.6.

A stolen track is not a cosmetic defect. `59dfb972` kept car A's **plate** while
its motion, `lastFrame` and final position became car B's; `state-analyzer.ts`
added the 574 px teleport to `totalDistancePx` with no outlier rejection
(`totalDistance: 915` on a car that never moved) and reset the stationary clock;
car A was abandoned and re-born 684 ms later as `612ccfd0`. One defect, two
symptoms, and it poisons every emitted event and every training export
containing the track.

**What was tried first and does not work: bounding the jump geometrically.** The
gate exists for one live case, `4285605a` (cam 636, a bird crop 15.5×32.3
becoming a dog body 39.3×45.8, 74.7 px apart, IoU 0). Measured side by side:

| case | dist | trackDiag | dist/trackDiag | dist/maxDiag | dt | trackDiag/s | px/s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `4285605a` bird→dog — **keep** | 74.7 | 35.8 | 2.085 | 1.238 | 170 ms | 12.26 | 439 |
| `59dfb972` car A→B — **reject** | 573.8 | 529.8 | 1.083 | 0.679 | 106 ms | 10.22 | 5 413 |

The theft is a **milder** jump than the case the gate exists for, in every
scale-relative measure — and still milder after dividing by elapsed time (cam
636's median frame gap is 170 ms, measured 2026-08-21). Algebraically the car
configuration is a 14.8× scale-up of the bird configuration in track-diagonals
while its displacement is only 7.7× larger, so **any scale-invariant geometric
predicate that accepts the bird must accept the car**, and so must any speed cap
expressed in track-diagonals per second. Only raw px/s separates them (439 vs
5 413) and that is an artefact of the two cameras' rasters, not a bound anyone
can defend. The separator has to be something other than the two boxes.

## Decision

Three rules, in the order they were applied.

1. **Every bind from a salvage branch is logged.** Rescue, resurrection and the
   growth-driven spawn suppression each report the stage, the clause that
   accepted them, the IoU, the centroid delta, the track diagonal, the area
   ratio, `dtMs` and the track's age, with `tags: { deviceId }`. Stage 1 is
   never reported — it runs per track per frame at frame-rate. The reports are
   sampled (first of each stage+gate, then every 50th, `bindCount` carrying the
   exact total), the same shape as `REFIRE_LOG_SAMPLE_EVERY`.

2. **Growth reaches with the TRACK's diagonal, and only while the track is
   young.** `growthAdjacentMatch` takes an explicit `GrowthContext`
   (`trackAgeMs`, `gapMs`) and refuses past `GROWTH_MAX_TRACK_AGE_MS` (1500 ms,
   ≈ 9 frames on the slowest measured camera) or `GROWTH_MAX_GAP_MS` (1000 ms).
   Growth-adjacency describes a **detector that has not yet settled on a
   subject's extent** — the first frames after something appears. A track that
   has held a box for longer than that is settled, and a settled track that
   "grows" into a box it barely touches is a second object. The reach is
   `GROWTH_CENTROID_FACTOR × hypot(track.w, track.h)`, never `max(…)`.

3. **A salvage bind that rests on PROXIMITY ALONE loses to a plausible birth.**
   When the `centroid` clause is the only thing accepting a pair — i.e. the
   overlap is already below `rescueIouThreshold` — and the detection clears both
   spawn floors (per-class score, per-class bbox-area fraction), the rescue is
   refused and the detection spawns its own track. **A spare track costs media;
   a stolen track corrupts the plate, the travelled distance and the last frame
   of the track it was taken from.** The `iou` clause is untouched (real overlap
   is evidence) and the `growth` clause is exempt — it is already bounded by (2),
   and a partial crop is by construction the same subject, so refusing it there
   would re-fragment `4285605a`.

## Consequences

- The centroid clause now only rescues detections that could **not** have been
  born: below their class spawn score floor, or below their class spawn area
  fraction. For `person` — the only score-ungated class — that means the clause
  is effectively reserved for far-field boxes under the area floor. Flicker
  recovery for a person now rests on the `iou` clause, the ByteTrack low-tier
  second stage and resurrection, which is where it belonged.
- Track counts do **not** fall. The theft already produced two tracks (the thief
  and the re-born victim); it now produces two correct ones. Rules 2 and 3 can
  only ever *add* births, and that is the deliberate trade.
- `growthAdjacentMatch` can no longer be called without saying when: both call
  sites (`looseMatch`, `isDuplicateSpawn`) pass a `GrowthContext` built from the
  track's `firstSeen` / `lastSeen`.
- Nothing here helps a jump that happens in the first 1500 ms of a track's life.
  A young track can still be robbed within `GROWTH_CENTROID_FACTOR` of its own
  diagonal; losing a ≤1.5 s track is the cost accepted for keeping `4285605a`
  as one id.

## Enforcement

`packages/addon-post-analysis/src/pipeline-analytics/__tests__/sort-tracker-identity-theft.spec.ts` <!-- drift-ok: the old tracker's own enforcement, deleted with it (D683 Task 21) -->
replayed both live cases frame-for-frame and demanded two ids, and carried the
guard for rule 2: **for a fixed track box, no detection size buys a longer
reach** — the check swept detection scales 1.5× … 32× at 1.01 ×
`GROWTH_CENTROID_FACTOR × trackDiag` and requires a refusal at every one. Each
rule was disarmed individually and confirmed RED before being restored.
