---
id: D442
title: A flip votes without renaming the track, and an established id claims a box before a provisional one
status: accepted
date: 2026-09-10
applies-to: []
---

> **Partially superseded by [D683](adr-0683-identity-is-decided-late-tracklets-split-when-in-doubt-a-deferred-linker-fuses-them-and-a-still-subject-belongs-to-the-registry.md)
> (2026-09-29).** The "established id claims first" pass-order rule below
> has no equivalent in tracker v2 — Hungarian minimum-cost assignment has no
> pass order to tune. The flip-without-renaming rule — a weak cross-class
> read votes the reported label without rewriting the tracklet's own class
> — still holds, restated as `classVotingEnabled` / `classVoteMinFraction`
> in `tracker-v2/types.ts`.

## Context

The assignment was to port OC-SORT's observation-centric re-update (ORU) into
the association core, on the strength of a paper and two benchmark numbers,
and to use the 236-case test corpus to retire the hand-built geometric rules
one at a time. The operator's collaudo case: camera 101, 18:47:53–18:48:01
UTC, one person crossing the entrance right to left, tracked as three ids
(`d71ada50` → `f64acc9d` → `ab4d7a61`), the second cut missing `iouThreshold`
by 0.013.

**ORU has nothing to re-update here, and this was measured before anything
was written.** ORU corrects a Kalman state that drifted while the track was
unseen: it rebuilds the missed stretch as a straight line between the last
observation and the new one and re-runs predict/update along it, so the
velocity and covariance after a gap are the observed ones. This tracker holds
no such state. `InternalTrack.bbox` is the last observation and is never moved
by a prediction; `predicted()` extrapolates on the fly; and on every
re-association the velocity is set to `(observed centroid delta) / dtMs` —
the slope of the two observed endpoints, which is exactly what ORU's virtual
trajectory converges to. The rescue pass, which matches on the LAST-KNOWN box
at 0.1, is OC-SORT's OCR stage under another name. And ORU runs *after* an
association succeeds; it cannot make one happen.

The hub's docker log (9 h, every camera) says the same from the other side.
Of 507 `new id minted beside a live coasting track` lines:

| `declinedBy` | n | last-known IoU ≥ 0.1 | within reach | predicted IoU ≥ 0.3 | prediction worse than last-known |
| --- | ---: | ---: | ---: | ---: | ---: |
| `geometry` | 203 | **0** | 0 | 0 | 2 |
| `crowd-guard` | 186 | 0 | 186 | 0 | 17 |
| `native-measured-class` | 93 | 41 | 78 | 19 | 17 |
| `cross-class` | 25 | 9 | 14 | 7 | 1 |

Not one of the 203 geometric declines had any overlap with the last
observation: those subjects re-appeared somewhere else entirely, or were
someone else. The 26 pairs the geometry would have bound (predicted IoU ≥ 0.3)
were all refused by a class rule. A drifted prediction is not a measured
failure mode on this hub.

**What the case actually was.** Replayed with its stored positions and the
two spawn-frame boxes the log carries, the passage reproduces production to
four decimals (`iou 0.5161, predictedIou 0.6056, gapMs 252, trackAgeMs 4592`
on the `f64acc9d` line) and yields three ids:

1. `78 092` and `78 179`: two `animal` reads at 0.53 over the person's own
   box were flip-bound to `d71ada50` under D439 (predicted IoU 0.67) — and
   each bind set `track.class = det.class`. At `78 431` the person's own box
   at 0.80, predicted IoU **0.61**, was a `person` against a track now called
   `animal`, scored above the flip bar, and D439 refused it:
   `declinedBy=cross-class`. `f64acc9d` was minted.
2. `80 082`: the detector returned two boxes for the person — the full body
   and the upper body (IoU 0.11). The second spawned a provisional id.
   `80 501`: only the upper-body box remained. `ab4d7a61`, two hits old,
   predicted it at 0.68; `f64acc9d`, eleven positions old, overlapped it 0.29
   on its last box — over the rescue bar, but the strict pass of every track
   ran before the rescue pass of any. The provisional id took it, and did so
   on every later frame; `f64acc9d` coasted to death.

Neither cut is a re-acquisition across a gap. The first is the association
class being rewritten by a read D439 itself calls weak; the second is the
tracker having no notion that an eleven-position identity is worth more than
a two-hit one.

Tried and rejected on the way:

- **ORU** — see above; a port would have been a no-op with a paper's name on it.
- **OCM** (a direction-consistency term in the association cost): the only
  population where direction could decide anything is the 186 `crowd-guard`
  declines — zero overlap, within reach, a second same-class subject present.
  Whether those were the same subject continuing or a genuine neighbour the
  log cannot say, so there is nothing to tune a weight against. Instrument
  first (the observed heading of the coasting track against the bearing to
  the box, on that record); decide after.
- **Association class = voted class.** Coherent, but at two frames the vote
  is noise: `person 0.50` then `animal 0.55` renames the track on the second
  frame, and the next confident person box is refused exactly as before.

## Decision

Two rules, both in `SortTracker.update`:

1. **A flip votes; it does not rename.** A cross-class bind — the weak
   {person, animal} flip D439 allows on a predicted-box pass — adds its class
   to the track's vote and is recorded as `frameClass` (what the detector
   said, for the latest-frame fallback of the reported label), but
   `InternalTrack.class`, the class every gate reads, is unchanged. Only a
   same-class bind or a birth sets it.
2. **An established identity claims before a provisional one.** The passes
   run in this order and no other: strict (predicted box) for tracks at or
   past `minHits`; rescue OVERLAP (`iou` clause, last-known box) for the
   same; strict for provisional tracks; rescue PROXIMITY (`centroid`,
   `growth`) for everyone; the ByteTrack low pass, established then
   provisional. This is ByteTrack's own convention ("unconfirmed tracks match
   the remaining detections") applied at the one boundary that matters
   downstream — under `minHits` a track has no row, no media, no event — with
   one invariant kept from the old single tier: a proximity clause never
   outbids a predicted-box claim, whoever holds it.

   D665 appends one stage AFTER all of these: low-score continuation. It
   works on a separate list of boxes the class floor refused, binds only to
   established tracks, and skips any box that sits on one a confident
   detection claimed this frame. "Claimed this frame" means claimed by the
   passes above (stages 1a–1c), so it cannot change a claim made here.

   One residual remains. A subject resurrected (4a) or spawned (4b) later in
   the same frame is not yet claimed when the stage runs, so a sub-floor box on
   it can continue another track for that one frame. From the next frame the
   subject is matched and its shadow is skipped.

## Consequences

- The 101 passage is one id, on the operator's real timings. The upper-body
  double box still mints a provisional id at `80 082` — the tracker cannot
  know two boxes are one person on the frame they appear — but it earns no
  third hit and dies as `unconfirmed-spawn-lost` (`measured=2, threshold=3`),
  which is the residual the replay spec pins by name.
- CPU per frame, measured on one synthetic 4K scene, 20 000 frames, median of
  three alternating runs: 6 subjects 14.3 → 13.7 µs, 20 subjects 109.9 →
  97.2 µs. The fixes are not slower; the inference in front of them is ~14 ms.
- What rule 2 can now do that it could not: an established track's OVERLAP
  claim (≥ 0.1 with its last box) takes a box from a two-hit id that predicts
  it at 1.0. The theft it permits is of an identity nobody downstream holds;
  the theft it prevents ends a row. The proximity clauses were deliberately
  NOT given that precedence: `growthAdjacentMatch` reaches 2.3 diagonals for
  a track under 1.5 s old — 2 254 px on a 980-px person at 4K — and in a
  fixture it claimed a second person 1 937 px away the moment it ran before
  the provisional strict pass.
- Untouched, and named so nobody reads this as closing it: a **confident**
  box of the other class over a LIVE track of the pair is still refused the
  bind (D439's score bar) and refused a birth (`dedupSpawnIou` 0.6 spans the
  pair) — 40 such drops in 9 h (`dedup-iou` person→animal 34, animal→person
  6). While that persists the track coasts, up to `maxMissedMs`. That is
  D439's accepted cost; this record does not reopen it.
- The rule-removal ladder (Enforcement) is the other result: the substrate
  did not change, so no geometric rule became superfluous. The ladder says
  which rules the corpus actually holds and which it does not.

## Enforcement

`sort-tracker-101-one-person-three-ids.spec.ts` (nine cases: the replay, the
residual, each rule in isolation, and three counter-tests), plus one
assertion in `sort-tracker-fp.spec.ts` retargeted from "association stays on
the raw class" to "association keeps the track's class, `frameClass` holds
the read" — the old line pinned the mechanism of cut 1. Each fix disarmed and
the whole pipeline-analytics corpus (3 660 cases) re-run:

| disarmed | red |
| --- | --- |
| rule 1 — a flip renames the track again | 3: the replay's "one person id", "after two weak animal reads a confident person box binds", and the retargeted `sort-tracker-fp` vote case |
| rule 2 — one association tier | 3: the replay's "one person id", "the upper-body double box … starves under minHits", "a two-hit id does not take a box the established track can rescue" |

And the ladder over the rules the task named as candidates for removal, each
disarmed alone against the same corpus (3 660 cases, the new replay included).
**None fell.** The substrate did not change, so no geometric rule was made
superfluous; what the ladder measures is how many recorded failures each rule
actually holds — the answer to "would we notice if it went":

| rule disarmed | red | held by |
| --- | ---: | --- |
| D399 time-scaled reach (`reacquireTimeScaled` default off) | 9 | the drift clamp, both D439 reach cases, the 880 ms / 908 px split, the frame-count-invariance case, the spawn-beside record, the D436 crowd count — and two zone-inheritance replays that turn out to depend on it |
| crowd guard (`isUnambiguousReach` always true) | 5 | the second-subject refusals (D399), the D436 record, the D439 second-animal counter-test |
| `isPlausibleBirth` veto on the reach clause | 5 | the SAME five cases as the crowd guard — the corpus never separates the two |
| D439 flip score bar | 2 | the confident-same-box cases (here and in `sort-tracker-overhaul`) |
| D439 salvage passes exact-class | 8 | both salvage cases, the four flip-boundary cases, the animal-beside-owner birth; the eighth (the D378 `native-measured-class` line) is red because the disarm also crossed the native veto |
| D378 native clause on the predicted-box passes (`associable` / `crossClassFlip`) | **0** | nothing — every native box the corpus has scores ≥ 0.6, so D439's score bar refuses it first; only a native box under 0.6 would tell the two apart, and none is exercised |
| `growthAdjacentMatch` (never matches) | 5 | the `4285605a` crop→body case, the same-frame crop, the maturity bound, and the two growth records |
| resurrection crowd guard (default off) | 1 | the 0.149-overlap re-attach with two other people on screen |
| ByteTrack low pass (default off) | **1** | one case — and it is the D439 flip-on-the-low-stage case, not a fragmentation case. "The single biggest fragmentation reducer" is held by nothing written for that reason |
| dedup family (default off) | 3 | the confident-same-box refusal, the growth spawn-dedup record, the same-frame crop |
| `classGroupAssoc` (no flip binds) | 7 | the weak-flip cases, both frame-processor label-refusal cases, the vote case, the voting-off case here, the D377 weak-flip counter-test |
| occlusion handling (default off) | 2 | the two native-recovery occluder counter-tests |
| predictive coasting (default off) | 1 | the frame-count-invariance case |

Two things to act on next, neither done here because neither was measured on
the fleet: the D378 clause on the predicted-box passes is unguarded (add the
weak-native case or fold it into the score bar), and the low pass is guarded
only by accident.
