---
id: D210
title: Step settings are node-scoped content — the provisioning read folds them across accelerators, and a save moves the single copy
status: superseded
superseded-by: D927
date: 2026-08-21
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/node-step-settings.ts
  - packages/addon-pipeline-orchestrator/src/pipeline-settings-store.ts
  - packages/addon-admin-ui/src/components/pipeline/inference-devices-write.ts
  - packages/addon-admin-ui/src/components/pipeline/step-inspector/NodeStepInspector.tsx
  - packages/addon-pipeline/src/detection-pipeline/pipeline/result-assembler.ts
---

## Context

The per-(node,device) provisioning base
(`agentSettings[node].inferenceDevices[deviceKey].steps[stepId]`) stores two
kinds of data in one slot: `modelId` / `jumpDeviceKey` (hardware — a node's
accelerators share no format) and `settings` (content — operator intent such as
the animal-classifier's `enabledClasses` species allow-list or a
`minConfidence`).

Until 2026-08-21 the dispatch read (`buildNodeInferenceDeviceSteps`) was
strictly per-deviceKey for both. The operator excluded `sheep`/`cow`/`deer` on
every node via the steps×accelerators matrix; the copies landed under `hub:cpu`
(weight 1), `agent-a:cpu` (weight 1) and `macmini:coreml:all`. Hub
sessions balance onto `openvino:gpu` / `openvino:npu` (weight 50 each), whose
entries carried no `steps` — so `applyDeviceProvisioning` attached nothing, the
runner's tree-builder hydrated the schema default (`enabledClasses: []` = every
species), and cameras 636/637 kept producing tier-1 `sheep` labels
(`labelMeta.stepId: animal-classifier`, e.g. track
`5846723e-…` on device 636, 2026-08-21 07:57, score 0.745, session engine
`openvino/npu`). The drop branch in `applyChildOutput` was also silent, so
"excluded by the allow-list" was indistinguishable from "classifier never ran".
This is the D62/D113 trap verbatim: a surface the operator writes, a read the
runtime never performs.

## Decision

Step `settings` are NODE-scoped content. The provisioning read folds them
across the node's accelerators (`foldNodeStepSettings`): per step, settings are
shallow-merged in deterministic precedence — disabled devices sorted by key,
then enabled devices sorted by key, then the requested device's own entry,
later wins per key. `modelId` and `jumpDeviceKey` remain strictly per-device
and never leak across accelerators. The matrix save keeps ONE settings copy per
(node, step): writing settings on a device strips the same step's settings from
every other device entry (`stripStepSettingsFromOtherDevices`), and the drawer
seeds its form from the folded effective value so no cell reads "unset" while
another cell's copy is in force. A confident classifier winner removed by the
class filter is reported through `AssemblyContext.onClassifierClassDropped` and
logged (sampled) with `tags: { deviceId }` — the detection keeps its macro
class (`animal`), matching the existing reject-class semantics.

A second leg of the same failure surfaced during live verification: a
single-eligible-device node (`pickInferenceDevice` → `default-pool`, no
elected `deviceKey` — the macmini shape) skipped the base read entirely at all
three provisioning sites (`deviceKey ? read : {}`), so even the node whose only
accelerator held the copy attached sessions without it. The base read now
always runs with `deviceKey ?? ''`; the fold resolves an unknown key to the
node's folded settings with no hardware fields.

## Consequences

- An allow-list or threshold saved on any accelerator binds the whole node —
  per-accelerator settings variance is no longer expressible from the UI
  (deliberate: nobody wants a species list that depends on where the balancer
  placed the session). Per-camera variance stays available via
  `stepOverridesByDevice`.
- Disabled devices still contribute settings (lowest precedence), so switching
  an accelerator off does not silently void the selection stored under it.
- Legacy multi-copy stores resolve deterministically by the precedence order
  instead of by map iteration; the UI converges them to one copy on the next
  save.
- No schema/cap change: the fix ships in `addon-pipeline-orchestrator`,
  `addon-pipeline` and `addon-admin-ui` without a `@camstack/server` release.

## Enforcement

- `packages/addon-pipeline-orchestrator/src/__tests__/node-step-settings-fold.spec.ts` <!-- drift-ok: deleted with D927 -->
  pins the fold (inheritance, hardware fields never folded, precedence).
- `packages/addon-pipeline-orchestrator/src/__tests__/agent-settings-cap.spec.ts`
  pins the store read end-to-end (fails if the read reverts to per-device).
- `packages/addon-admin-ui/src/components/pipeline/__tests__/inference-devices-write.spec.ts`
  pins the one-copy move semantics.
- `packages/addon-pipeline/src/detection-pipeline/__tests__/result-assembler-classifier-gate.spec.ts`
  pins the non-silent drop.
