---
id: D505
title: A second detector's silence does not retract the first one's sighting
status: proposed
date: 2026-09-15
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/onboard-birth-authority.ts
---

## Context

The confirmation gate re-runs the ML detector on a crop of the birth frame and
retracts the track when it finds nothing compatible. On the `pipeline` path that
is a COHERENCE CHECK — the same detector, asked the same question about a
tighter crop — and a disagreement really does mean the first answer was noise.
It is the gate's whole justification.

On the `onboard` path the root detector is the CAMERA's own firmware, and the
gate is a second, DIFFERENT detector overruling it. A disagreement between two
detectors is not evidence that either is wrong, and the action taken on it is
one-shot and destructive: exactly the shape D49 forbids resting on a fallible
read.

Measured on device 106 (Baby monitor, the only camera on this fleet with
`detectionSources: ['onboard']`), 2026-09-15 17:22-17:25. The operator walked in
front of the camera; the firmware reported `person` for ~100 s continuously.
The gate retracted **18 births out of 18** in three hours — every one with
`cropSource=native`, so the crop arrived, and none with a `bestScore` at all,
so the ML found nothing compatible in it. Nothing survived: no track persisted,
no thumbnail, no recording, three notification events that matched no rule. The
event happened and left no trace.

Whether the ML is right (a subject at close range filling the frame is a hard
crop) or the pairing is skewed (box and frame are stamped with two different
`Date.now()`s, `ONBOARD_PAIRING_MAX_AGE_MS` 1 s, on a battery camera behind a
relay) cannot be decided from logs. Both readings lead here: the gate is not
entitled to the destructive half of the decision on this path.

## Decision

On a birth whose detection source is `onboard`, a `suppressed` verdict HOLDS
the birth instead of retracting it, and says so on its own line. Held is not
confirmed — the ordinary lifetime still decides. Every other source keeps the
gate whole, including a camera running both roots: there the ML is a root
detector in its own right and its verdict is its own to give.

Separately, and on every path: a retracted birth now runs
`clearLiveTrackState`. A birth that is retracted is a track that ended, and the
detail dispatcher, best-shot tracker and frame park were never told — 43
`no crop source resolved` and 27 refused parks on device 106 were spent on
tracks dropped seconds earlier, the first request landing ~20 s after the frame
it names (D391).

## Consequences

- A camera on an onboard root keeps its tracks. That is the point, and it is
  also the risk: a firmware false positive now survives to be judged by the
  rest of the pipeline rather than killed at birth. The held line is what makes
  that visible, and `suppressedBirths` no longer accumulates for this source.
- This does not make the onboard path first-class. The recorder still refuses
  `not-pipeline`, the stationary registry is still `pipeline`-only, and the
  decode lease still admits only inferred frames. Those are separate records.
- The measurement that would settle the gate's accuracy on this path — persist
  a handful of confirmation crops from 640 and look at them — is still worth
  doing, and this decision does not depend on its outcome.

## Enforcement

`onboard-birth-authority.spec.ts` (5 tests): three on the rule, with the
`pipeline` path as the control so this can never become "never retract"; two
structural, because the retraction is one branch inside a very large method and
a reordering edit would restore the defect with every other test still green.
Verified by neutralising the rule — 1 of 5 goes red.
