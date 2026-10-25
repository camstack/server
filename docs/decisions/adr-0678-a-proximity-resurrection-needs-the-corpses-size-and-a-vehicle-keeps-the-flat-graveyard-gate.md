---
id: D678
title: A proximity resurrection needs a box of the corpse's size, and a vehicle keeps the flat graveyard gate
status: accepted
date: 2026-09-29
supersedes:
applies-to: []
covers:
  - packages/addon-post-analysis/src/pipeline-analytics/index.ts
---

> **Superseded by [D683](adr-0683-identity-is-decided-late-tracklets-split-when-in-doubt-a-deferred-linker-fuses-them-and-a-still-subject-belongs-to-the-registry.md)
> (2026-09-29).** The online resurrection this record narrowed (vehicles
> flat, people/animals time-scaled with an area-ratio bound) has no
> equivalent in tracker v2 — a deferred linker, not a live reach budget,
> decides whether a later piece continues an earlier one, with every
> competitor for the window already known.

Amends [D665](adr-0665-a-box-under-the-class-floor-may-continue-a-track-and-do-nothing-else.md).

## Context

The operator reported "pairs of confused subjects" on cameras 101 and 102. The
analysis of 2026-09-29 read the stored positions of both cameras (04–18Z on the
24th, 25th and 28th, and the 29th until 10:35Z) and the tracker's log lines.

- Tracker-level confusion on these two cameras is rare: 0–6 cases per 100
  person tracks, per class.
- It is noticed because it happens in scenes with 2–5 subjects close together.
- It takes four shapes:
  - id swaps inside a group;
  - owner and dog;
  - a stopped track "trampled" by a walking one and then merged;
  - parked cars alternating.
- This record fixes the one defect D665 introduced (F2). The other fix proposed
  with it (F1, on `resolveDuplicates`) was withdrawn after review; see below.

### D665's proximity resurrection bound boxes of any size, vehicles included

D665 grew the graveyard reach with the gap: 0.25 diagonals/s, up to 2. It also
lifted the plausible-birth veto for a sole subject. The `centroid` clause says
where a box is, never what it is, and "sole" does not mean "the same".

**The sample.** The salvage log sampled 41 `resurrection / centroid` binds
fleet-wide on 2026-09-28.

- 18 bridged an area ratio of 2 or more.
- 14 bridged 2.5 or more, up to ×26.
- By class, the ratio was 2 or more for 3 of 4 vehicles, 6 of 14 people and 9
  of 23 animals.

**101, 2026-09-29 06:58:05.350Z: a person resurrected at ×3.6.**

- The corpse `avtq64vvxc` was [3005,86 379×252].
- The box that resurrected it was [2435,0 641×538] at score 0.658, 4.5 s later.
- It was 0.97 diagonals away, so the flat 0.75 would have refused it. The area
  was ×3.6 and the IoU 0.04.
- Three seconds later that id took the box of `nw34j8e0n1`, who was walking
  beside, and two people became one track.

**102, 2026-09-28 08:47:32.214Z: a car inherited the previous car's id.**

- The corpse `0qhf1mn02e` (vehicle) was [2748,582 409×628].
- 9.85 s later a car entered at the gate: [2070,2 235×115] at score 0.706.
- It was 1.51 diagonals away, with area ×9.5.
- The arriving car inherited the id of the car that had left. Before D665, both
  the flat reach and the veto refused this.

**Why vehicles.** D665 excluded vehicles from its low-score tier (a parked car
is the D410 hop), but not from `resurrectionTimeScaled`. D665's own argument
for the time-scaled reach is that a subject unboxed for over 4 s stood still
or stood half-hidden. That describes people and animals. A car gone for ten
seconds did not stand half-hidden; the next car arrived.

## Decision

**A resurrection that rests on proximity alone needs a box of the corpse's
size.**

- When the loose gate answers `centroid`, and the plausible-birth veto has let
  the pair through, the area ratio (larger / smaller) must be at most
  `RESURRECTION_MAX_AREA_RATIO` (2.5). Otherwise the bind is refused.
- `iou` binds are overlap evidence and are not measured.
- A refused pair may still bind on `growth`, the partial-crop rule, which
  exists for exactly a size change. This fallback is reachable only on a
  camera whose `maxMissedMs` is under growth's 1 s gap bound; with a longer
  budget, a corpse is too old for it.

**A vehicle corpse keeps the flat pre-D665 gate.**

- The reach is `rescueCentroidFactor` × diagonal (0.75).
- The plausible-birth veto is never lifted for a vehicle.
- D665's two relaxations, the low-score tier and the time-scaled graveyard
  gate, apply to one class set, `LINGERING_SUBJECT_CLASSES` = {person, animal}.
  It is defined once in `reacquire.ts` and read by both.
- `resurrectionTimeScaled: false` still restores the flat gate for every class.

**A refused re-attach names its gate.**

- `tracker: salvage bind` with `stage: 'resurrection-refused'` now carries a
  `refusal` field: `crowd-guard` (the existing guard) or `size-incompatible`.
- Tags stay `{ deviceId }`, as for every line of that stream.
- The sampler keys on (stage, gate, refusal), so a rare refusal is not sampled
  away behind a frequent one.
- The size check runs after the veto, so a pair the veto refuses is never
  reported as a size refusal.
- As before, a refusal is reported only when it is the reason the box found no
  corpse.

### Why 2.5

What 2.5 refuses in the 2026-09-28 sample of 41 centroid binds:

- **Both named wrong binds**, at ×3.6 and ×9.5.
- **The largest ratios**: ×8.7 (person), ×15.4 (vehicle) and ×26.1 (person, at
  score 0.31).
- **Six animal binds**: 2.79 (1443), 2.86 (618), 3.63 (3836), 3.81 (1443), 6.04
  (587) and 10.78 (3836).
  - The ones at 2.79 and 2.86 are as plausibly a dog changing pose as the ones
    just under the bar. Nobody has shown them wrong. We accept refusing them.
- **Three person binds at 2.64–2.96** (3628, 3839, 618). None is shown wrong
  either. The 3628 one changed aspect ×3.25, which looks like sitting down.

What it keeps: four animals at 2.10–2.48 and one person at 2.09.

**This bar is conservative, not calibrated.** A bar of about 3.2 would refuse
the same named cases.

**What 2.5 costs.**

- A refused bind costs one fragment, which is the pre-D665 behaviour. It never
  corrupts another track.
- The upper bound is about 14 of every 41 centroid binds. On 28/09 that is
  about 28 extra fragments on the whole fleet, about 1 pp of 2,867 tracks.
- `iou` resurrections (844 that day) are untouched.

**Calibrating it** needs images. That is a follow-up, not done here: extend the
operator-debug crop that `index.ts` makes today only for `growth` binds to
`refusal: size-incompatible`. Also not done: an aspect-ratio bar. Aspect
changes of up to ×2.6 appear among animal binds that look genuine.

### F1 was withdrawn after review

**What F1 proposed.** `resolveDuplicates` would merge only pairs whose tracks
were both confidently matched on every frame of the overlap. A coasting or
low-score-held track under another subject would never be merged.

**Why it was withdrawn.**

- **It makes a short id swap permanent.** A walking subject that stops on the
  frozen box of a coasting track loses its box to that track in the greedy
  strict pass (IoU ≈ 1 against a velocity-overshot prediction).
  - Before F1, the pair overlapped at ≥ 0.6 and was merged. When the walker
    had more hits, the stale track was deleted and the walker got its box
    back one frame later.
  - Under F1 the stale track is the matched side, so it keeps the walker's box
    and path for good.
  - A simulation of the stand-on case (0–10 px stop, either hit order) showed
    "back to the walker after 1–2 frames" under the old code and "stale track
    permanently" under F1.
- **It removed merges nobody had measured.**
  - 58% of merges on 28/09 (104/180) were `animal` phantoms on a person, and
    69 of those lived 1 s to over 5 s. Under F1 they would merge only on 5
    consecutive frames where both sides are boxed.
  - At least 32% of all merges had a loser under 400 ms old, which F1 makes
    impossible.
  - Nothing counted the deferred merges.
- **It had no visible benefit on the named cases.**
  - 102 14:01: the old merge already deleted the stale track, and the walker
    kept `tg9ftpcct2` on every box.
  - 101 05:59: the merged-away id was a one-hit unconfirmed spawn, invisible
    either way.
  - The only real wrong merge cited is pre-D665: 101, 24/09 13:10:28
    (Bob into Alice). Nobody has checked whether a coasting or held
    track was involved.

**The follow-up design.** Do it only after checking the 24/09 13:10 case in the
stored positions, for an unmatched side at 13:10:27–28.

- Keep the pair count running while only one side is matched.
- **Pause, do not reset.** A frame where one side is unmatched neither
  increments nor resets the count. An IoU drop below the bar still resets it.
- **The loser is the side that was unmatched when the overlap began.** Fall
  back to hits.
- **The loser goes to the graveyard** (`resurrectable`), not deleted, so an
  occluded person's id can come back.
- **Add a sampled `dedup-deferred: unmatched` counter** tagged `{ deviceId }`,
  with the pair classes and the unmatched side's hits. A fall in
  `merged-duplicate` can then be read against it.
- **Tests.** The stand-on scenario above becomes a regression test, next to
  the existing genuine-duplicate merge.

## Consequences

- **A person or animal returning at more than ×2.5 area gets a new id** where
  D665 kept the old one. That includes a person who sat down during the gap.
- **A car returning more than 0.75 diagonals away, or as a box that would
  spawn on its own, gets a new id.** This is the pre-D665 behaviour for cars.
  - A parked car's return binds on `iou`, which is unchanged.
- **The size bar is not limited to veto-lifted binds.**
  - It also refuses a `centroid` bind for a box too weak or too small to
    spawn, which the pre-D665 code accepted. That box is now dropped by the
    spawn floors instead of re-attaching.
  - Such a box cannot mint a fragment.
  - Sampled pre-D665 centroid resurrections: 0 on 24/09, 0 on 25/09, and 1 on
    26/09 (a vehicle at ×253 and score 0.33, which the bar rightly refuses).
- **Log volume.**
  - `size-incompatible` is sampled on its own key: the first line, then every
    50th, per tracker, at debug level.
  - A spawnable refused box matches its own new track on the next frame.
- **Follow-ups, not done here:**
  - **F1, rebuilt as above.**
  - **F3, low-score ownership.** `continueOnLowScore` does not ask whose
    sub-floor box it takes. Add per-hold logging first, then size the fix on
    that measure.
  - **F4, appearance in association.** The strict pass is IoU-only, so
    subjects in a tight group swap ids. Design it with D665's R4, using one
    descriptor and one comparator.
  - **The debug crop for `size-incompatible`** described above.

## Enforcement

`sort-tracker-resurrection-size.spec.ts` covers:

- the 101 ×3.6 and 102 ×9.5 cases, and the named refusal;
- the vehicle flat reach, with a car too weak to spawn at 1.2 diagonals after
  6 s. That is inside D665's 1.5 but outside the flat 0.75, so only the reach
  decides;
- the vehicle veto;
- a veto-refused pair not being reported as a size refusal;
- regressions:
  - a same-size person at 1.2 diagonals after 6 s;
  - the ×2.4 / ×2.6 bar;
  - an animal keeping the time-scaled reach;
  - a non-spawnable car within 0.75;
  - the growth fallback;
  - `boxAreaRatio`;
  - the sampler key.

Disarms, each red and each restored:

| Disarm | Tests red |
| --- | --- |
| vehicle reach alone | 1 |
| vehicle veto alone | 2 |
| `vehicle` added to the class set | 4 |
| size bar | 3 |
| size check before the veto | 1 |
| growth fallback | 1 |
| refusal name | 1 |
| refusal record | 1 |

**Live check.** Watch `tracker: salvage bind` for `stage:
resurrection-refused` with `refusal: size-incompatible`. The sample predicts
about 14 of every 41 centroid binds.
