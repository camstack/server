---
id: D506
title: The onboard root is a root, not a second-class source
status: proposed
date: 2026-09-15
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/pipeline/macro-gate.ts
  - packages/addon-pipeline/src/pipeline-runner/detection-source-plan.ts
  - packages/addon-pipeline/src/recorder/object-trigger.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/stationary-planes.ts
---

## Context

`docs/architecture/detection-execution.md` promises that downstream of the
runner "everything cannot tell which detector produced the boxes". On
2026-09-15 that was false in six places, and the bill came due on device 106 —
the only camera on this fleet with `detectionSources: ['onboard']`. The
operator walked in front of it; the firmware reported `person` for ~100 s
continuously; **nothing survived**: no track, no thumbnail, no recording.

The entry point was never the problem, and the first diagnosis that said so was
wrong. The firmware's boxes are merged into the same `FrameResult.detections`,
on the same decoded frame, in that frame's pixel space. The divergence is in
premises further down that say `pipeline` without noticing:

- **The operator's gate never ran.** `enabledMacroClasses` and the
  `minConfidence<Macro>` floors were applied by the executor, and the firmware
  never enters it. So the boxes reached the tracker ungated — a "vehicle" at
  0.30 spanning the whole frame, on every frame, ~280 `score-floor` discards a
  minute, surviving only because a tracker floor happened to catch it.
- **The recorder refused every one of them** (`not-pipeline`, 11 of 11 in two
  minutes), and was RIGHT to: acting on an ungated box would have made the
  operator's sliders describe one detection while the recording followed
  another. A second truth.
- **The stationary machinery never ran**, behind five separate
  `source === 'pipeline'` comparisons whose stated reason was where the flood
  they were written for had been measured (102, the ML plane), never an
  argument that firmware boxes were unfit. A still object is therefore never
  promoted, holds `hasLiveTrack` true, and every session runs to its 120 s cap
  instead of closing on cooldown — tearing down and rebuilding a battery
  camera's lazy stream each time.

## Decision

The operator's gate is ONE authority (`macroGateVerdict`) and both roots ask
it: the executor for the ML tree, and `onboardRootDetections` for the firmware,
at the point where its boxes enter. A gate that refuses every box yields
`gated`, which is a different outcome from `none` — a camera muted by its own
settings is not an idle camera and must not log as one.

Because the gate has then genuinely run, the recorder's `not-pipeline` refusal
is REMOVED rather than weakened: a detection that reaches it has passed the
classes and floors the operator chose, and there is no second truth left to
conflict with. The macro-class filter stays, because the firmware's vocabulary
is wider than the macro classes (`face`, `other`).

The stationary machinery runs on every plane that produces object boxes on
decoded frames — `planeRunsStationary`, one predicate instead of five
comparisons (D62). `sensor` and `audio` carry no geometry to park and stay out.

## Consequences

- An onboard camera records, parks, and closes its sessions on cooldown.
- The firmware's full-frame ghost is now refused by the operator's own floor
  instead of by a tracker accident, which is where an operator can see and
  change it.
- On a camera running BOTH roots the registry now receives promotions from two
  planes. That is safe because the registry is already the one authority per
  device and merges onto an occupied spot rather than minting a neighbour
  (D495) — but it is new, and it is where to look first if parked rows behave
  oddly on a dual-root camera.
- `'not-pipeline'` stays in the reason union although nothing produces it:
  counters already written name it, and removing it would make them unreadable.

## Enforcement

`onboard-obeys-the-operator-gate.spec.ts` (6) pins the gate, including the
legacy "empty list means ALL" — widening it to "none" would silently mute every
camera whose operator never opened the checklist. `stationary-planes.spec.ts`
(4) pins the planes and asserts no bare `source === 'pipeline'` comes back.
`object-trigger.spec.ts` now asserts an onboard detection QUALIFIES, with a
non-macro class as the control. Verified by neutralising the gate: 4 of 6 red.

Not addressed here: `TrackSourceSchema` still lacks `'onboard'`
(`pipeline-analytics.cap.ts:259`), so a persisted onboard track is read back
without a source. That is a cap change and needs a published server.
