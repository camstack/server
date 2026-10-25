---
id: D931
title: A packages rule can open a candidate from a scene difference and confirm it with the LLM
status: accepted
date: 2026-10-24
supersedes:
applies-to:
  - packages/types/src/capabilities/schemas/zone-rule.ts
  - packages/types/src/capabilities/schemas/package-llm-verdict.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package/package-scene-diff.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package/package-scene-step.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package/package-scene-coordinator.ts
  - packages/addon-post-analysis/src/pipeline-analytics/pipeline/package-drop-detector.ts
  - packages/addon-pipeline-orchestrator/src/widgets/zone-editor/ZoneRulesEditor.tsx
---

## Context

On camera 101 the carton on the Uscio step is a package a person left. `rfdetr-package` scores that carton 0.033 on the native zone crop, so the model path never opens a candidate. The same two frames, shown to the vision model already on the LAN, were recognised as a parcel. The stored 960×540 twins are previews and are the wrong pixels for that comparison.

The candidate still belongs in `PackageStillnessTracker`. Identity is decided late (D683): this is not an L1 track and not a parked-object row. A second switch beside the zone rule would be a knob that disagrees with the rule the operator already edits (D62).

## Decision

Both options live on the package-stage `ZoneRule`, default off (the field absent). The rule editor shows them only for a packages rule.

**Detect by scene difference.** When a person track that was inside the rule's zone leaves, compare the zone crop from before they entered with the crop a few seconds after they left. The crops are native `getNativeCrop` answers with no `maxWidth`. A `ram-fullframe` reply is refused and logged. A uniform brightness shift is removed by subtracting the median luma delta; what remains, above the zone min-area and still there on the next look, becomes a candidate in `PackageStillnessTracker`. A region overlapping a still-present person or vehicle is not a candidate. While this option is on, a package-model box in that zone is extra evidence (it can raise confidence) and is not the gate. Every rejected blob logs its reason once, with `tags: { deviceId }`.

**Confirm with the LLM.** Before a package event is emitted, one `llm.generateVision` call (consumer `package-confirm`, no retry, `PACKAGE_LLM_CONFIRM_TIMEOUT_MS`) sees the after crop and the before crop. The answer is `{ package, confidence, reason }`, Zod-validated. Yes stores the verdict on the event. No drops the event and logs the reason. Unreachable, timeout, unparseable, or no image emits the event with `packagePossible: true`, and the notification uses the "possible parcel" sentence. The images are `Uint8Array` on the existing vision method. There is no new base64 field.

Options off is the path that shipped: raw governor boxes, no vision call, the ordinary delivery sentence.

## Consequences

A camera that turns scene difference on no longer waits for the package model to box the parcel. A crop that cannot be fetched at native resolution produces no scene candidate and says so; it does not fall back to the model gate. One episode is kept per device. The LLM call is one per candidate. `packagePossible` and `packageLlmVerdict` are declared columns on the object-event row, or the insert would drop them.

## Enforcement

`package-scene-rule.spec.ts` reconstructs the 101 sequence (still blob, global brightness, person overlap, LLM yes / no / timeout) and the options-off case. A brightness change must name `global-brightness`. Nothing else checks the two booleans; review does.
