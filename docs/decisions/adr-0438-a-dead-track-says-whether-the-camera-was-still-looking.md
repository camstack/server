---
id: D438
title: A dead track says whether the camera was still looking
status: accepted
date: 2026-09-10
---

## Context

The operator reported losing the thread on tracks, and named animals and
vehicles alongside people. Twenty-four hours of production data on this hub says
the `animal` class is the uniform case, and it is uniform across the whole
house:

| camera | n | p50 life | last position mid-frame | positions |
| --- | --- | --- | --- | --- |
| front door | 22 | 1.7 s | 95 % | 5 |
| hall | 57 | 2.9 s | 96 % | 6 |
| kitchen | 18 | 1.9 s | 94 % | 5 |
| sala da pranzo | 56 | 1.9 s | 100 % | 6 |

`person`, for contrast, holds 4.4–12.4 s across 13–44 positions.

Three comfortable explanations are already dead:

- **Not false positives.** Best-score-of-track p50 **0.78**, p90 0.89 (person:
  0.88); 125 of 158 above 0.70.
- **Not class oscillation.** 144 of 158 are pure `animal` in `classes[]`, so the
  D378 `sameGroupAsMeasured` veto on a {person, animal} widening cannot be it.
- **Not fragmentation.** Only 16 of 158 are followed within 4 s by any track at
  all. The track does not split — it ends, and nothing follows.

Two explanations remain, and they demand **opposite** fixes:

1. the frames kept arriving and the detector stopped finding the animal — a
   detection threshold;
2. the frames STOPPED, because the animal stopped moving and the motion area
   bar (D394) closed the gate — the camera went quiet with the animal still in
   the room.

Nothing recorded anywhere separates them. Track rows cannot: a cat going under a
sofa produces the first shape, a cat sitting down produces the second, and both
die mid-frame with nothing after. Even "was anything else detected in the next
three seconds" cannot — it answered *nothing at all* in 71 % of cases, which is
what BOTH look like from outside.

## Decision

Count **frames, not tracks**. `update()` runs once per delivered frame, so the
number of deliveries between a track's last matched frame and its death is
exactly how many chances the detector was given. Against the elapsed
milliseconds it is unambiguous:

    many frames, seconds elapsed  →  the camera looked and did not find it
    ~no frames, seconds elapsed   →  the camera stopped looking

`TrackLossRecord` therefore carries `framesSinceLastSeen` beside
`msSinceLastSeen`, plus the `cause` (the three sweeps are three different
events), `lifeMs`, `positions` and `emitted`.

Since D665 a low-score continuation also advances `lastSeenFrameSeq` and
`lastSeen`: a box under the class floor is the camera still finding the
subject, weakly. `positions` (hits) does NOT advance on it.

So the two readings above gain a third shape, **found weakly until the cap**.
A track held by sub-floor boxes and dropped at `lowScoreContinuationMaxMs`
reaches its death record with `framesSinceLastSeen` and `msSinceLastSeen`
counted from the last LOW box. That gives few frames and little time, while
`lifeMs` and `positions` stopped growing up to 8 s earlier. Read it together
with `sustainCapDrops` on the `tracker: low-score continuation` line.

This changes **no** decision in the tracker. Both candidate fixes are plausible,
each is wrong for half the population, and neither may be attempted on a guess.

## Why a second reporter

`reportTrackLoss` already existed and speaks only for spawns that never reached
`minHits`. Every one of the 158 animal tracks had **emitted**, so that path
never saw a single one of them. Reusing it would have reported the wrong
population — and reported it as a refusal, which this is not.

## Why `debug`

Every subject that ever appears eventually produces a track death. Unlike a
refusal it is ordinary, so it is sampled (first ten of each cause, then every
fiftieth, with the exact running total on `lossCount`) and logged below `info`.
