---
id: D508
title: Stillness has ONE authority per occasion, only an agreeing observation may mint, and an oversize box is answered by its REACH, never at birth
status: proposed
date: 2026-09-16
supersedes: D497
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-evidence.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-evidence-ledger.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-birth-guard.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-match.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/tracker/state-analyzer.ts
  - packages/addon-pipeline/src/pipeline-runner/runner.ts
---

## Context

In two days the stationary mechanism produced three distinct defects on device
102 and every closure re-opened one of the others: the area bar (D497) refused
the operator's own parked car twelve times in twelve hours (0.344–0.353 of the
frame) because the dawn ghost it was written for measured 0.361; the "second
door" written to admit the car on the SHARE of its evidence coming from the
periodic occupancy burst; a box that breathes 25 % in height at night being
called `moving` on every frame; and a 1–6 s scene flicker voting as a parked
object through the analyzer's never-moved shortcut, answered by a second
stillness clock inside the ledger (`MIN_STILL_FOR_EVIDENCE_MS`). The operator
asked for the design to be re-examined, not for a fourth patch.

Re-reading the whole path from the runner down found the tissue the patches
were sewn on:

- **The runner never labelled a live frame `'session'`.** From d946ce42e
  (2026-09-14) `enqueueReservedDetectionFrame` — the live path of an active
  motion session — stamped `occasion: 'burst'`, and only the pre-roll lane
  fell through to the `'session'` default. Every "burst" tally on the fleet
  was session frames: one candidate on 3836 carried 40 431 "burst" agreements
  and 55 "session" ones against a recheck that produces at most 1 152 frames a
  day. The burst door's measurement ("92.9–99.5 % burst for the car, a couple
  of dozen at most for the ghost") was a measurement of that label, and the
  door admitted any oversize box with a hundred agreements.
- **A real occupancy burst was never inferred while the camera watched.**
  `enqueueOccupancyFrame` admits frames only in `watching`; the picker
  dispatched `active` cameras only; `transitionToWatching` clears the queue
  and the queue is latest-only. The recheck's frames overwrote each other and
  the survivor ran on the next session's first tick, minutes stale, after the
  burst had already reported `found: false` — which disarms the timer after
  two reports. The mechanism the ledger's "occasion B" describes had no live
  path.
- **A four-frame burst cannot carry a tracker verdict** (every track in it is
  `entered`), so once agreement required the tracker to have said `idle`
  (f44befc8d) a genuine burst could never vote — invisibly, because the
  mislabelled session frames kept the tallies alive.
- **The ledger forgot a candidate the moment it tipped, before the birth site
  could refuse it.** A refused box re-accumulated from zero and re-tipped every
  120 s (vehicle) or 30 min (person); the burst door needed 100 burst
  agreements and the ledger tips at 8, so it was reachable only when session
  dilution happened to hold the ratio down for hours.
- **A disagreeing fold could mint.** The ratio window rotates on every fold;
  dropping a diluted bucket turns the verdict over, and the observation that
  did it — on 102 and 3836 a ONE-position `entered` track of some other
  subject — was the one torn down and closed as `stationary-promotion`.
- **A bound row was never re-checked for class**, so a track whose class vote
  flipped kept feeding the row it bound under its old class.
- **A coasted frame voted.** The observation loop never asked
  `matchedThisFrame`; a flicker that died coasted `maxMissedMs` on its last box
  and each coasted frame read as "still there, still still".
- **3836's insistent full-height "person" is a white quilted jacket on a coat
  stand** (key frame read from the hub), detected at 0.65–0.88 day and night.
  On 2026-09-15 21:44 the stale-anchor correction re-anchored the studio's
  person entry from 236×568 onto that 1094×1406 box, and for nine hours every
  person detection in the studio was a weak hold of it (`suppressed=692
  continuable=692 continued=0`). Only the artifact rule (97 % of the frame
  height) and the 06:40 hydrate purge removed it.

Alternatives considered and rejected:

- *Fix the label and keep the burst door.* With honest labels the door is
  reachable only when the recheck runs, and a real recheck yields ≤ 4 frames
  per 300 s — the door would take hours to open for the operator's car and
  never for a car on a busy camera. And it still cannot be measured on the
  ghost side: the dawn ghost's lifetime was never recorded.
- *Replace the burst share with a SPAN bar for oversize boxes.* The same
  unmeasured ghost; and 3836's jacket, present day and night, passes any
  time-based test. "Not another threshold" was the brief.
- *Keep `MIN_STILL_FOR_EVIDENCE_MS`.* It is a hand-kept copy of the tracker's
  per-device `stationaryThresholdSec`, i.e. the second authority D494 forbade,
  and it also refuses every genuine burst.

## Decision

1. **The runner names the occasion where it owns the frame, and the field is
   required.** Live session frames and pre-roll history are `'session'`; only
   `enqueueOccupancyFrame` — admitted in `watching` alone — is `'burst'`. A
   frame accepted on a watching camera's queue is dispatched while watching.
2. **Stillness has one authority per occasion.** On a session observation the
   tracker's `TrackState` travels on the observation and only `idle` agrees;
   an absent verdict on a session frame is a producer that forgot the field
   and does not agree. On a burst observation no verdict travels: the runner
   admits a recheck only while its motion gate says the scene is still, and
   that occasion is the authority. `observationAgrees(overlap, agreeIou,
   source, movementState)` is the only place this is written.
3. **`idle` costs the dwell, for every track.** The analyzer's never-moved
   shortcut is gone; `stationary` means the per-device `stationaryThresholdSec`
   has elapsed. The ledger has no clock of its own.
4. **Only an agreeing observation may mint**, and a coasted frame offers no
   observation at all (`trackOffersEvidence`). A binding is class-bound: a
   track whose class changed re-binds by class.
5. **The birth bar is the artifact rule and nothing else**, and it is asked
   inside the evidence verdict (`implausible-box` shortfall), so a refused
   candidate keeps its evidence and is reported once per candidate. Size
   decides nothing at birth.
6. **An oversize entry is answered by its reach.** At or above
   `OVERSIZE_AREA_FRAC` (0.30, formerly `SCENE_BOX_AREA_FRAC` at 0.55) an
   entry holds a detection on a strong read only — no jitter hold, no fragment
   hold — and a weak overlap on it is a miss, never a departing read. The
   registry keeps no list of who may absorb whom (`censusTenants` is gone):
   the predicate that stops an oversize entry holding a fragment stops it
   absorbing one.

## Consequences

- `sessionAgreed` / `burstAgreed` are honest for the first time. Until the
  runner is deployed, every existing tally is session frames mislabelled.
- A genuine recheck can vote: two bursts of the same still vehicle box 300 s
  apart promote it (8 agreements, span 300 s). A scene artifact that recurs in
  two rechecks at the same box is born too — that is the operator's own
  definition of parked, and the honest tallies now say when it happens. This
  is the open door to measure first.
- The dawn ghost is BORN as an oversize vehicle entry and holds only its own
  exploded box: no neighbour is swallowed, and the box it suppresses is junk.
  Cost: one "parked" and one "departed" for the envelope, per transition.
  Deployed code admitted it anyway, through the mislabelled door.
- 102's car (0.36) is born plainly and held on strong reads only; measured
  cost before the number moved: 1 717 reads absorbed, `continuable: 0`.
- `object.stationary` fires `stationaryThresholdSec` later for a track that
  never moved; no event is bound to `moving`, so nothing new fires.
- 3836's jacket stays refused (artifact), keeps its candidate, and is logged
  once. Its 300-second tracks continue until the operator deals with the
  scene or the model.
- Cost: an addon-pipeline deploy on every node (the runner) plus post-analysis.

## Enforcement

`runner-occasion.spec.ts` pins each producer's occasion end to end through the
result callback, and that a watching camera's recheck frame is inferred while
watching. `stationary-single-authority.spec.ts` pins `observationAgrees`,
`stillnessVerdictFor` and `trackOffersEvidence`. `stationary-evidence.spec.ts`
pins that a session sighting without a verdict never promotes, that two bursts
promote and the same eight frames as `entered` session sightings do not, that a
disagreeing fold cannot mint, that a binding is class-bound, and that the
jacket is refused as `implausible-box` while keeping its evidence.
`stationary-match.spec.ts` and `stationary-birth-bar.spec.ts` pin the oversize
reach rule and that the registry absorbs nothing into an oversize row. Every
rule above was neutralised one at a time and its spec went red before this
record was written.
