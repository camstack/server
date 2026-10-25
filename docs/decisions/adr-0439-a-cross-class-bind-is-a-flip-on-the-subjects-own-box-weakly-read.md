---
id: D439
title: A cross-class bind is a flip on the subject's own box, weakly read — never a salvage
status: accepted
date: 2026-09-10
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/tracker-v2/association.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/tracker-v2/__tests__/l1-kept-rules.spec.ts
last-verified: 2026-10-01
---

## Context

The operator's verdict, verbatim: *"questo dedup di animali e persone fa più
danni che altro — una persona con un animale non è affatto inusuale."* [this dedup of animals and people does more harm than good — a person with an animal is not at all unusual.] A person
walking a dog is the common case on this hub, and animals were vanishing.

The case that was measured, camera 101 at 16:45:32 UTC: an independent system
notified an animal; CamStack's native crop pass recovered it at **0.766**, in
the watched zone, and no `animal` track was ever born. Two more outcomes on the
same camera, same rule, within 26 minutes: 16:49:18, a dog born on three
native recoveries in one second, an event with `zones: []`, then lost the moment
it reached its owner; 17:04:17 and 17:11:01, the dog alone in the zone, born,
zoned, notified — "perfettamente allineata".

### What the logs said, once read from the right place

The hub's `logs.query` ring holds ~5 000 rows per addon, about 25 minutes of
`pipeline-analytics`. The "zero refusal lines on 101 in three hours" that
started this investigation was that ring, not the camera. The docker log holds
6.6 h and answers:

| what | count (sampled: first 10 per camera, then 1 in 10) | note |
| --- | --- | --- |
| `animal-over-person` — the dedup gate the operator blamed | **0** | never fired |
| `merged-duplicate`, animal losing to person | 3 | all ≤ 0.61 — crouching people |
| `cross-class-absorbed`, animal → person track | **125** | p50 **0.62**, p90 0.78, up to **0.92** |
| `cross-class-absorbed`, person → animal track | **141** | **0.65–0.95** — the animal's id walks off as a person |
| `new id minted beside`, animal beside animal, `crowd-guard` (101) | 12 | the "crowd" was the owner |
| `unconfirmed-spawn-lost`, animal, 1–2 hits | 137 | p50 0.71; every record said `native=false` |
| `a track ended and nothing took over` (D438, `debug`) | **0** | the hub writes at `info` — the tool was blind for every hub-run camera |

The 16:45:32 animal died as `unconfirmed-spawn-lost` (`measured=1`,
`threshold=3`), 100 % inside Aiuola, reported at 16:45:54 — fourteen seconds
after the one and only sighting. Every gate on its path passed: score floor
0.45, no area floor for animals, dedup, the person-over-animal fold (exempt as
a native measurement, D377). It was seen once and `minHits` is three. That is
not the dedup, and this record does not change `minHits` (see Consequences).

What the dedup family DID do, in numbers, is the association widening.
`classGroupAssoc` collapses {person, animal} into one association group for one
failure of the coarse pass — a bending person read as `animal` for a frame, on
the person's own box, at the 0.4–0.6 the model gives a shape it half
recognises. Until today the widening reached **every** pass that binds the pair
(the strict predicted-box stages AND the rescue/resurrection salvage passes),
for a box of **any** score, and the crowd guards (D399, D436) counted a person
as an animal's competitor. Three collateral mechanisms fall out of that, all
visible above:

1. a `person` at 0.86 binds to a coasting animal track on the rescue clause
   (IoU 0.23 with the dog's last box — 101, 17:11:01, `a28c1557`: born as a
   native animal, confirmed as a person);
2. a coarse `animal` at 0.8–0.9 beside a coasting person is taken as the
   person's flip on IoU 0.1;
3. a native recovery within the dog's time-scaled reach is refused the bind
   because the owner is on screen (`isUnambiguousReach` counts the group), so
   the dog's id is re-minted and has to earn `minHits` again — which, at two
   recoveries a second, it often does not.

### What was tried first

The threshold hypothesis — "0.766 fails, 0.88 and 0.92 pass, look for a bar
between them." There is none on the path: spawn floor 0.45, crop-only floors
only for person/vehicle (D396), confirmation gate `minConfidence` 0.4. The two
good cases differ from the bad one in the number of sightings before the dog
reached the owner or left the zone, not in confidence.

## Decision

A cross-class bind under `classGroupAssoc` is a **flip claim**, and a flip is
the same subject in the same place, weakly read. So it is allowed only when all
of these hold: the box was measured by the coarse pass (never `nativeRecovery`,
D378); it is the {person, animal} pair; it scores **below
`animalOverPersonMaxScore`** — the same bar the spawn gate already uses for the
same claim; and the pass is a **predicted-box pass** (the strict stage or the
ByteTrack low stage). The salvage passes — rescue and resurrection — bind their
own class only, always. Every crowd count (`isUnambiguousReach`, the
resurrection guard, the D436 record) is an **exact-class** count: a competitor
is a subject the id could actually be handed to, and after this rule a person
cannot take a dog's id on a salvage pass.

Two things become sayable: `cross-class-absorbed` carries the predicted-box
IoU and the score bar it bound under; `unconfirmed-spawn-lost` carries the
native score of the box that fed the track. And the D438 line moves to `info`
— it is sampled at ten then one in fifty, and at `debug` it reached the hub's
log zero times.

## Consequences

What this costs, in the measured window:

- A crouching person the coarse pass reads as a **confident** animal (≥ 0.6)
  on a partially overlapping box (predicted IoU 0.3–0.6) now spawns a
  concurrent animal track instead of updating the person. It lives until
  `resolveDuplicates` merges it (IoU ≥ 0.6 for 5 frames, person wins) or it
  coasts out, and it can emit an animal event first. Bound: of the 125 sampled
  animal→person absorptions, ~65 were at or above the bar; how many of those
  were crouching people rather than dogs the logs cannot say, and the operator
  has said which way to err. On the subject's OWN box nothing changes: the
  confident flip is refused a second id by `dedupSpawnIou` (0.6) rather than
  folded in, and the person track coasts one frame.
- A person box at any score beside a coasting animal now gets its own id, and
  the animal keeps its own — one more id per such event (141 sampled), no
  hijack.
- A weak crouch flip that misses the strict gate but would have rescued the
  coasting person at IoU 0.1–0.3 now spawns an animal candidate; the
  person-over-animal spawn gate refuses it when weak and overlapping (≥ 0.2),
  so the person coasts one frame instead of being fed the flipped box.
- `spawn-beside-coasting` loses the unreachable `assoc-group` reason and gains
  `cross-class`.

What this does NOT fix, named so nobody reads this record as closing them:

- **`minHits` stays 3.** The 16:45:32 dog was seen ONCE. Emitting a track on
  one native sighting would notify on one frame of anything the crop pass
  scores over 0.45; the 137 sampled single-sighting animals in 6.6 h have no
  ground truth, and D396 found the crop arm's false positives on quiet footage.
  The one-sighting case belongs to the runner: the session attached 7.3 s after
  motion (`dispatchMs 5032`), the pass runs at most twice a second, and its
  region gate skips a motion region the person's box covers (101, 6.6 h: 263
  passes, 138 `covered`, 152 `tooLarge`). That is the 16:49 loss too — the dog
  disappeared from the recovery pass the moment it reached the owner, with
  frames still arriving.
- The pass report (`small-subject recovery: pass report`) is emitted only on
  a frame that RAN a pass, so a window of nothing but skips is silent.
- Rider pairing, the stationary gate's roll-up, `forgetDeviceProcessors` on a
  settings change (drops live and graveyarded tracks with no loss report) and
  `SortTracker.reset()` remain the silent consumers they were.

## Enforcement

D683 Task 21: the old tracker this enforcement section describes (`SortTracker`,
`spawn-beside-coasting.ts`, `sort-tracker-person-with-animal.spec.ts` and its
siblings named below) is deleted. The RULE survives in tracker v2's
`classRelation` (`pipeline/tracker-v2/association.ts`) — a confident cross-class
box is `'none'` (forbidden to bind, never salvaged), a weak one is `'flip'`
(bound, never renamed) — pinned at the tracker level by
`pipeline/tracker-v2/__tests__/l1-kept-rules.spec.ts` and at the association
level by `pipeline/tracker-v2/__tests__/association.spec.ts`. The table below is
historical: the old tracker's own disarm proof, not v2's.

`sort-tracker-person-with-animal.spec.ts`, plus the three existing specs whose
fixtures moved to a weak flip. Each guard was disarmed and the suite re-run:

| disarmed | red |
| --- | --- |
| salvage passes cross the pair again | 6: both salvage tests here, the confident-same-box tests here and in `sort-tracker-overhaul`, the D378 native-absorption test, the D399 `native-measured-class` line |
| crowd counts count the family again | 2: the reach bind with a person on screen, the sole-subject resurrection |
| no score bar on the flip | 2: the confident-same-box tests here and in `sort-tracker-overhaul` |
| the loss record forgets the native measurement | 1: `unconfirmed-spawn-lost` native score |

Nothing checks the runner-side gates named above.
