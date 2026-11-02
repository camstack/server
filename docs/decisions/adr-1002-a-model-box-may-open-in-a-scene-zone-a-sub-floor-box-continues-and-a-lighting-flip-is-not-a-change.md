---
id: D1002
title: A model box may open in a scene zone, a sub-floor box continues, and a lighting flip is not a change
status: accepted
date: 2026-11-02
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package/package-scene-plan.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package/package-scene-step.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package/package-scene-diff.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package/package-stillness-tracker.ts
  - packages/addon-pipeline-orchestrator/src/occupancy-recheck-controller.ts
---

## Context

Camera 615 missed a parcel (planning#395). Its rule had `detectBySceneDifference`
on, so D931 removed every model-box sighting inside the scene zone. The scene
diff then failed on the day to IR flip (`zone-wide-change`), `rememberClear`
re-baselined on the IR crop with the parcel already in it, and the model's
0.75 box had only the tracker's L1 route left (`unconfirmed-spawn-lost`).
Separately the occupancy recheck counted a burst that returned no result as
empty, so two silent bursts disarmed the cadence.

## Decision

Amends D931. A model box inside a scene-difference zone is still a stillness
sighting: it may OPEN a candidate, and the scene diff's own sighting merges
with it by IoU. A below-threshold package box (score at least 0.3, observed
0.35 to 0.50) on a looked frame may CONTINUE an unpromoted candidate that
already has two above-floor hits, and never opens one (D665); a real sighting
and a continuation box on one frame count once. A day to IR flip, read from the crop's chroma spread
(`IR_CHROMA_THRESHOLD`), is rejected as `lighting-mode-changed`, not as a
zone-wide change: the reference is re-baselined, a pending blob is dropped,
and the model's gated box (delivered by the plan) is the gate for that episode.
The measure is taken on a 32x32 box-averaged grid, where the threshold was
calibrated. A burst that produced no result is
`no-verdict`: the empty streak and the cadence stay as they were.

## Consequences

The L1 tracker is untouched (D683). A scene zone can now deliver on a model box
alone. The continuation floor is a constant, not a setting.

## Enforcement

Specs in `package-scene-rule.spec.ts`, `package-stillness-tracker.spec.ts`,
`package-look-evidence.spec.ts`, `package-scene-fetch.spec.ts` and
`occupancy-recheck-controller.spec.ts`.
