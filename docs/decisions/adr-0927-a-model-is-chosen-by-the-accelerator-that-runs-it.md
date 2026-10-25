---
id: D927
title: A model is chosen by the accelerator that runs it; a camera only turns steps on or off
status: accepted
date: 2026-10-24
supersedes: D754 (the per-accelerator camera override and camera-wide model-bound floors), D650 (the warning that a jumped step leaves a camera override behind), D210 (the cross-device settings fold)
applies-to:
  - packages/addon-pipeline-orchestrator/src/node-step-settings.ts
  - packages/types/src/capabilities/pipeline-orchestrator.cap.ts
  - packages/types/src/types/agent-pipeline-settings.ts
  - packages/types/src/pipeline/step-settings-layers.ts
  - packages/addon-pipeline-orchestrator/src/pipeline-settings-store.ts
  - packages/addon-pipeline-orchestrator/src/apply-device-provisioning.ts
  - packages/addon-pipeline-orchestrator/src/attach-pipeline.ts
  - packages/addon-training/src/orchestrator/return-flow.ts
  - scripts/check-no-camera-model-layer.ts
---

## Context

A detection step's model could be chosen in up to five places: the node's
computed default tree (`getGlobalSteps`), the accelerator
(`agentSettings[node].inferenceDevices[key].steps[step].modelId`), a
per-(camera, node, accelerator) override (`stepOverridesByDevice`), a wholesale
per-node pipeline copy on the camera (`pipelineByAgent`), and the executor's
per-camera detector store. Confidence floors (`minConfidence*`) could live in
four: the accelerator, a node-wide fold, the camera-wide settings (D754) and
the executor store.

A camera does not know where it runs. Since D748 it is balanced onto a
`(node, accelerator)` at every session start, and accelerators of one node do
not even share a model format. Every camera layer was therefore a way for a
model the operator never saw on that accelerator, or a floor tuned on another
model (D738: a floor of one detector is wrong on the next), to run unseen. On
production the two override layers held 0 rows; the executor store and the
camera floors were invisible from the accelerator's own page; and the
confirmation gate had to ask `getGlobalSteps` which model a frame came from —
a computed tree, not the one that ran.

## Decision

**A model, and every model-bound threshold, is chosen by the accelerator that
runs it. A camera only turns steps on or off.**

- The accelerator's `inferenceDevices[key].steps[step]` is the ONE authority
  for `modelId` and for `minConfidence*` / `<key>ModelId`.
- Node-wide content (an allow-list) lives in `agentSettings[node].stepSettings`
  and is merged under each device's own entry; a sibling entry is never read.
- A camera has `stepToggles` and `stepSettings` (D754) for camera-semantic
  keys only. `setCameraStepSettings` refuses a model id, a binding or a
  `minConfidence*` floor by name; dispatch drops one a legacy row still holds
  (`layerCameraStepSettings`).
- Removed: `setCameraStepOverride`, `getCameraStepOverrides`,
  `setCameraPipelineForAgent`, `stepOverridesByDevice`, `pipelineByAgent`, the
  executor's per-camera detector store (`clearDeviceOverrides`,
  `clearModelBoundDeviceOverrides`), Auto tune's camera clears, Model Studio's
  camera-pin sweep, the Steps inspector's per-accelerator model picker and
  scope switch, and the `cameraPipeline` device-settings patch key (refused).
- A training canary pins accelerators (`canaryResult({ accelerators })`), not
  cameras.
- The reset probe reports the hosting accelerator's `defaultModelId`; the
  benchmark refuses an empty step list instead of running a computed tree.

## Consequences

- Testing a model "on one camera" is done by pinning one accelerator (a
  canary), which every camera balanced onto it then runs. That is coarser, and
  deliberate: a canary is a test of a model on an accelerator.
- A floor is tuned per accelerator. Two cameras that need different floors on
  the same model have no knob. **Future:** per-camera thresholds could return
  as a model-bound pair judged against the model the camera actually ran
  (`docs/ideas.md`). Not built. <!-- drift-ok: moved to the private planning repo -->
- No migration on deploy (D853, D900): stale keys are stripped by the store
  schema on the next write and ignored on read. The one-shot offline cleanup is
  an operator runbook, not product code.
- Node-wide content has its own key, `agentSettings[node].stepSettings`
  (`setNodeStepSettings`, refuses a model-scoped key). A device's
  `inferenceDevices[key].steps[step]` is read for THAT device alone — the
  D210 fold that also read disabled entries is gone, and so are the
  `addonDefaults` / step-gating boot migrations (D853, D900: a stale key is
  stripped by the store schema on the next write).
- The executor's computed node tree (`getGlobalSteps`,
  `getGlobalPipelineConfig`, `getDefaultSteps`) leaves the cap once nothing
  asks it which model ran.

## Enforcement

- `scripts/check-no-camera-model-layer.ts` (+ its spec): no camera-scoped
  `pipeline-orchestrator` input carries a model or floor key; a camera's
  stored settings hold only `stepToggles` and `stepSettings`; no production
  source names a retired identifier.
- `camera-step-settings-layer.spec.ts`: a legacy override row changes nothing,
  a legacy floor in the camera layer is dropped, a model-scoped write is
  refused and nothing is written.
- `CameraStepInspector.spec.tsx`: the model is read-only and no floor is
  offered on a camera.
