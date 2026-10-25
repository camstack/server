---
id: D495
title: A spot is censused ONCE, and the occasion that saw it is named by whoever produced the frame
status: proposed
date: 2026-09-14
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-registry.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary/stationary-match.ts
  - packages/addon-post-analysis/src/pipeline-analytics/zone-analytics-provider.ts
  - packages/addon-pipeline/src/pipeline-runner/runner.ts
---

## Context

On 2026-09-14 at 18:58 device 102 (the operator's parking lot) reported **eight
parked vehicles**. There were about four objects:

| row | box | born | label |
| --- | --- | --- | --- |
| a | 3476.4, 694.8, 360x774 | 14:30 | `Car` |
| b | 3476.4, 694.8, 360x774 | 16:32 | — |
| c | 3476.4, 694.8, 360x774 | 17:16 | — |
| d | 3476.4, 694.8, 360x774 | 18:00 | — |

One car. The same box to the decimal, four rows, all four alive and all four
confirmed by the same frame. A fifth row was a 34x137 box sitting wholly inside
the motorcycle entry next to it (452x420): IoU **0.024**, below `wakeAssocIou`
(0.1), so the suppression filter read it as "no detection overlaps this entry"
and let a fragment of the motorcycle become an object of its own.

Two independent causes, one shape:

1. **Nothing asked whether the spot was taken.** `birthStationaryFromEvidence`
   minted a `randomUUID()` and called `promote()`; `promote()` indexed and
   wrote. The weak-continuation path (D410) keeps feeding the evidence ledger
   from a track riding a parked object, so a candidate re-forms on an occupied
   spot roughly once an hour. The re-promotion is not the anomaly — it is a
   fresh, independent confirmation that the thing is still there.
2. **Containment is not IoU.** A small box inside a large one scores near zero
   against both thresholds. `detectionSwallowsEntry` existed for the opposite
   case (a merged box that covers the entry) and had no mirror.

While tracing it, a third thing turned out to be false. `stationary-evidence.ts`
and D264 both stated that occasion B — the periodic burst that looks at a still
scene — was "not implemented". It has been implemented the whole time, as the
per-camera **occupancy recheck** (`occupancyRecheckSec`, default on at 300 s,
D-era comment in `device-detection-settings.ts`: *"the periodic re-sample is the
only thing that looks at a still scene"*). Its frames enter the same detection
queue and have always fed the same ledger. The fold tagged every observation
`'session'`, so `burstAgreed` read zero on the whole fleet and the docblock
looked true. Two more facts fell out of the same trace: a freshly registered
camera was `occupancyArmed: false`, so after a hub restart an object already
parked in view could not be seen by the one mechanism that looks at still
scenes; and the baseline sampler wrote the RAM ring, the NC watcher and the
state slice but never the long-term series, leaving a hole in `occupancy`
exactly where the scene was nothing but parked objects.

## Decision

**One spot, one entry.** `StationaryObjectRegistry.promote` is the only place
that decides whether a place is already censused, and it decides with the SAME
predicate the per-frame filter uses (`findParkedOccupant` →
`parkedEntryHoldsDetection`): a box the filter would suppress as a parked
object's own can never become a second parked object. A promotion onto an
occupied spot is ABSORBED — it advances the tenant's clock, adopts an identity
the tenant lacks, never overwrites one it has, and says so in a log line.

**An entry swallows its own fragments.** `entrySwallowsDetection` is the mirror
of `detectionSwallowsEntry`: a detection smaller than `1 / SWALLOW_AREA_RATIO`
of the entry and at least `FRAGMENT_MIN_CONTAINMENT` inside it is held weakly,
like jitter. The scene-sized guard is checked first, or an entry covering the
view would swallow the frame.

**The occasion is named by whoever produced the frame.** `InferenceOccasion`
(`'session' | 'burst'`) is declared once in `@camstack/types`, set by the runner
on the queue entry, carried on `PipelineInferenceResultPayload.occasion`, and
consumed by the ledger — `StationaryEvidenceSource` is an alias of it, not a
second spelling. The occupancy recheck is armed from registration, and the
baseline sampler feeds the same long-term series the frame path feeds.

## Consequences

- Device 102 settles to roughly four rows within one sweep. The birth guard
  alone would NOT have got there: a duplicate cannot age out, because every row
  on the spot is confirmed by the same detection on the same frame, so all of
  them live exactly as long as the object does — 102's four rows were still
  being re-confirmed together hours after the guard shipped. "One spot, one row"
  is therefore an INVARIANT, re-established on every sweep by
  `collapseDuplicates`, which keeps the OLDEST row (it carries the object's real
  `becameStationaryAt` — "parked since 14:30" is the fact the operator reads),
  folds the losers' identities into it and deletes their rows outright. A
  retirement would announce a departure that never happened.
- A merge is logged per occurrence, not rolled up: a spot absorbing a promotion
  every hour is the signature of a track riding a parked object, and that is
  worth reading per camera.
- Arming from boot costs a camera with nothing parked two bursts per attach
  (each a decode dial or a tap) before the empty-burst streak disarms it. That
  is the price of seeing a car that was already there, and it is bounded.
- A runner older than `occasion` emits nothing, and absence means `'session'` —
  during a rolling deploy the burst tallies stay conservative rather than wrong
  in the other direction.

## Enforcement

`stationary-one-entry-per-spot.spec.ts` replays the measured 102 sequence (four
promotions of one car leave one row), the motorcycle fragment, and the sweep
collapsing four rows that were ALREADY on disk down to the oldest — verified to
fail when the collapse is removed. Controls: a different spot, a different
class, a different device, and two genuinely different objects the sweep must
leave alone.
`runner-occupancy-arm.spec.ts` pins boot arming and the self-disarm.
`zone-analytics-provider.spec.ts` pins that the baseline sampler writes the same
series as the frame path — verified to fail when the call is removed. Nothing
guards that a new producer of a `StationaryObservation` carries the occasion;
that is review only.
