---
id: D264
title: An object becomes stationary by REPETITION, not by one track surviving
status: proposed
date: 2026-08-28
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-evidence.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-evidence-ledger.ts
---

## Context

The operator's parking lot (device 102) holds three parked cars in view. The
registry held exactly **one** entry. He named the reason before the code did:
the two it missed are the ones the detector sees badly at night, and the
criterion rewarded being seen well.

It did, literally. An object became stationary when ONE track had stayed alive
and barely moved for `PROMOTION_WINDOW_MS` (30 s). Measured over 24 h on 102
(`pipelineAnalytics.listTracks`, 18 402 vehicle observations, 290 tracks):

| | car A (missed) | car B (missed) | entry today |
| --- | --- | --- | --- |
| separate tracks in 24 h | **140** | **112** | — |
| median track life | \~6.8 s (p90 29 s, max 66.9 s) | idem | — |
| agreement with its own spot | 6405/6467 = **0.99** | 343/343 = **1.00** | — |

Not one of those 252 tracks could reach 30 s. The two cars alone produced
**13 494 of 18 402 vehicle observations (73%)** — the entire re-spawn flood the
registry exists to stop. The track dies; the object does not. A criterion
anchored to track continuity is fragile exactly where it is needed.

**A raw count of sightings does not fix it.** Any floor high enough to exclude a
passer-by also excludes a car the detector only catches ten times an hour. What
a rarely-seen object CAN answer well is a ratio: of the times it was seen, how
many were in the same place. The measured populations do not overlap —

| candidate on 102 | N agreeing / M seen | ratio |
| --- | --- | --- |
| parked car A | 6405 / 6467 | 0.99 |
| parked car B | 343 / 343 | 1.00 |
| car manoeuvring | 12 / 41 | 0.29 |
| car turning through | 14 / 91 | 0.15 |
| car crossing the lot | 5 / 70 | 0.07 |

— and the threshold sits in the empty band between 0.29 and 0.99.

**What was tried first and does not work: a ratio alone.** A car that pauses for
four seconds agrees with itself perfectly. The day produced two such stops, at
4.2 s and 8.0 s, against real parked cars spanning 2 min to 24 h. Evidence has to
STRETCH as well as agree.

## Decision

A stationary entry is created by **repeated sightings in the same place**, never
by one track's survival. Evidence accumulates per candidate, anchored to a BOX:

- **N** — observations agreeing with the anchor (IoU ≥ 0.5, the same `iou` the
  suppression gate uses; there is no second notion of "same place").
- **M** — observations offered by a track once it has bound to that candidate,
  agreeing or not. A track that merely drove through the spot keeps counting
  toward M while it walks away, and dilutes itself out.

Promotion requires all three: `N ≥ 8`, `N/M ≥ 0.6`, and the agreeing
observations spanning `≥ 120 000 ms`. Every number is read off 102; the span
floor equals `DEFAULT_MAX_SESSION_HOLD_MS` so that no single motion session,
however long it is held open, can promote on its own.

**One ledger, two producers.** Evidence is keyed to a box, not to a track or a
session, so an object confirmed half by an active motion session and half by a
periodic burst still promotes. Occasion A (the session) is the primary path and
is sufficient alone — it is free, because the pipeline is already decoding and
already inferring. Occasion B (the burst) is the periodic occupancy recheck
(`occupancyRecheckSec`); it has always fed the same ledger through the same
detection queue. This record said it was "not implemented" and was believed for
two weeks because the fold tagged every observation `'session'` — see
[D495](adr-0495-a-spot-is-censused-once.md).

**`person` is off by default, and that is a measurement.** (Superseded by
[D494](adr-0494-one-authority-says-an-object-is-still.md): the class gate is gone — the
person THRESHOLDS below stayed, and what made the switch unnecessary is that an
observation now agrees only when the TRACKER also calls the track still.) Replaying 24 h of
person observations from devices 102/111/104/107 through this exact ledger
produces 22 entries at ratio 0.85 and still **6** at ratio 0.99 / N ≥ 80 / span
30 min. There is no setting that reaches zero: 104 holds a person-shaped thing
agreeing with itself 1292/1654 across 26 tracks over ten hours, and 592 produced
eleven candidates at ratio 1.00 between 02:00 and 05:00. The ledger cannot tell a
statue from someone standing still. D49 read in the direction that destroys
work: for a car the destructive read is the RETIREMENT (the flood returns), for a
person it is the BIRTH (we stop seeing them).

**The 30 s stillness test is not deleted — it is DEMOTED.** It was doing two
jobs, and only one was destructive. Creating an entry blinds the pipeline to an
object, so it now needs repeated evidence. Deciding that a motionless subject
should stop holding a motion session open destroys nothing — if it is wrong the
session closes early and the next motion re-opens it — so one recent stillness
read remains the right amount of proof. `PROMOTION_WINDOW_MS` is renamed
`SESSION_STILLNESS_WINDOW_MS`, `evaluateStationaryPromotion` becomes
`trackIsStill`, and its one consumer is the presence signal.

## Consequences

- **Birth latency rises**, deliberately, from \~36 s to the span floor plus
  whatever it takes to gather N — on 102, minutes rather than seconds. Two
  minutes of repetition is much stronger proof than thirty seconds of survival.
- **Removing promotion WITHOUT the demoted valve is a 70%-uptime regression.**
  A parked car stays in `result.tracked` continuously, so it would pin every
  session to the 120 s cap: 102 runs 504 sessions/24 h, and 104/103/1443 are
  already above 50% uptime. The subtraction in `hasLiveTrack` is the only thing
  standing between the fleet and a permanent session.
- **Known false positive, stated:** device 3829 promoted an envelope-exploded
  box covering 74% of the frame — under the 85% `isPlausibleThumbnailBox`
  threshold, so that gate does not catch it. One per day on one camera.
- **A still track that never gathers enough evidence now enters the Events
  gallery**, where the old path marked it `stationary-promotion` at 30 s. Tracks
  under 25 s are still caught by the short-motionless close in `expireStale`;
  the band between is a real gap and is not closed here.
- Evidence is durable (`pipeline-analytics:stationary-evidence`), staged on the
  frame path and flushed on the existing 5-minute sweep. A lost flush costs
  minutes of repetition, never a wrong birth: the decision is always read from
  the RAM mirror (D49).
- **There is no grid.** The predecessor (`phantom-cells.ts`) quantises to a
  32 px cell and its write path passes a centroid while its read path passes a
  corner — a live defect its own test cannot see, because it calls both halves
  with the same literal coordinates. Candidates here are found by overlap over a
  device's own rows, bounded by an LRU cap; 102 holds 8.

## Enforcement

`scripts/check-stationary-promotion-reachable.ts` (CI), rewritten:

1. `SESSION_STILLNESS_WINDOW_MS + 6 000 ms <= DEFAULT_MAX_SESSION_HOLD_MS`.
2. the falling edge still consults the hold; one caller of the close.
3. the tap is gated on `hasLiveTrack` and never on `hasMovingTrack`.
4. **the presence signal FILTERS `result.tracked` through `trackIsStill`** — not
   merely reads it. `result.tracked.length > 0` on its own is the permanent-
   session bug, and it is what the old assertion allowed.
5. **`evaluateStationaryPromotion` may not reappear in `pipeline-analytics`**,
   and `birthStationaryFromEvidence` must still be called — two authorities for
   one decision is D62.

Behavioural cover, all disarm-verified (revert the line, watch it go red):
`pipeline/stationary/__tests__/stationary-evidence.spec.ts` (the ratio, the span,
the floor, the class policy, one ledger two producers) and
`__tests__/frame-tracked-presence.spec.ts`, which drives the real addon: 60 s of
a motionless track — twice the old window — creates **nothing**, the same track
**does** stop holding the session, and repetition past the span floor **does**
create an entry end to end.
