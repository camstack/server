---
id: D736
title: The animal and vehicle classifiers are on by default, sourced from the root model — and a root supplies only a step the camera runs
status: accepted
date: 2026-10-07
supersedes: D730
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/registry/step-definitions.ts
  - packages/addon-pipeline-orchestrator/src/pipeline-resolver.ts
  - packages/addon-pipeline/src/pipeline-runner/root-supply.ts
  - packages/addon-admin-ui/src/components/pipeline/inference-devices-write.ts
---

## Context

[D730](adr-0730-a-step-takes-its-result-from-the-root-model-when-its-flag-is-on-and-the-current-root-declares-it.md)
made `useRootModel` default ON for the label kinds, while the animal and
vehicle classifiers stayed `enabledByDefault: false`. Out of the box the flag
waited on a step nobody had switched on — a contradiction the operator
rejected: the default was "take it from the root", and the default did
nothing.

Tracing the per-camera and per-node settings end to end on the live hub
(2026-10-07) found three links where the runtime or the UI did not read the
values that are in force:

- **The supply ignored the per-camera gate.** `planRootSupplies` planned every
  suppliable step whether or not it was in the camera's tree. Camera 103 had
  no `stepToggles` (both classifiers gated OFF) and its runner logged `root
model supplies a pipeline step` for both, and raised the root's labels to
  the detection's score for a function the camera did not run.
- **The runner judged the wrong root.** An unpinned root was planned as the
  step's flat `defaultModelId` (`yolo26n`) while the elected device ran its
  hardware-aware default (`yolov9m-320-int8` on the hub's Intel GPU/NPU,
  `yolov9m-320` on the Mac's ANE, an SSD on a Coral). `filledBy` named a model
  that was not running, and D731's 640 px gate would have measured the wrong
  input.
- **The UI read a device's own settings, not the folded ones.** The runtime
  provisions a step with its settings FOLDED across the node's accelerators
  (`foldNodeStepSettings`); on the hub every classifier setting sits on the
  disabled CPU row. The per-camera tab and the node matrix read the column
  device's own copy for the root chip (and the camera tab for the editor's
  inherited baseline), so a `useRootModel` stored on another accelerator was
  in force at dispatch and absent on screen.

## Decision

**`animal-classifier` and `vehicle-classifier` are enabled by default with the
root model as their source; a root supplies a step only while the camera runs
it.** Everything else in D730 stands.

1. **Defaults.** Both classifiers are `enabledByDefault: true` in the catalog
   (the one authority: the resolver's gate, `DEFAULT_OFF_STEP_IDS` and the
   node-default tree all follow it). `useRootModel` keeps defaulting ON for
   them. When the current root declares the step its label is the answer and
   the classifier is not dispatched; when it does not, the enabled step runs
   **its own model** — a cost the operator accepted (one MobileNetV3 crop
   inference per animal / vehicle track, at the step's `once ×3` cadence).
2. **Only DEFAULTS change.** An explicit `stepToggles[step] = false` and an
   explicit `useRootModel: false` stay what the operator set. On 2026-10-07
   the hub had no explicit `false` for either step on any camera, no per-camera
   step override at all, and no stored `useRootModel` or `labelLink` at any
   level; the explicit values are `stepToggles` `true` on 101 (vehicle), 102
   (vehicle, animal, bird), 636 and 637 (animal, bird), and node-level
   `animal-classifier.enabledClasses` on the hub CPU row, the agent-a CPU
   row and the Mac `coreml:all` row.
3. **`package-detection` is not changed.** It is zone-driven
   (`applyPackageZoneActivation`), not a default toggle: switching it on by
   default would run `rfdetr-package` on every camera whose root has no
   `package` class and admit `package` on every plus catalog camera with no zone
   drawn. Its `useRootModel` default (ON) already applies whenever a zone
   switches it on.
4. **The supply follows the gate.** `planRootSupplies` plans a suppliable
   step only when it is in the camera's tree and enabled. A gated-off step
   has no state: its root linked label stays the score-0 fallback, its root
   child boxes are removed, nothing is announced and nothing logs.
5. **The root is the one that runs.** An unpinned root is planned as the
   elected device's default (`resolveDefaultDetectionModel` on the backend,
   accelerator and format of `deviceKey`) — the executor's own rule. No
   elected device, or an unknown backend, falls back to the flat default.
6. **The UI reads the folded settings.** `effectiveStepSettingsForDevice` (the
   UI mirror of `foldNodeStepSettings`) feeds the root chip on both matrices
   and the camera editor's inherited baseline; a camera override still wins
   over it.

Precedence, unchanged and now read the same everywhere: per-camera
`stepToggles` is the only gate; settings and model are camera override >
node-folded per-(node,device) base > catalog default (the cluster row applies
only to `face-embedding` / `clip-embedding`, not to these steps).

## Consequences

- Every camera without an explicit toggle gains both classifiers on the next
  attach after `addon-pipeline` is deployed. On the hub today every root is a
  CamStack COCO model, which declares animals 6/8 and vehicles 5/8, so no
  classifier model is dispatched there; the visible change is the
  `detailSteps` announce carrying `filledBy`, and fine labels at the
  detection's score. `deer`, `squirrel`, `Ambulance`, `Taxi`, `Van` are not
  produced from a COCO root — unchecking "Use the root model" brings the
  classifier back for that step.
- A camera whose root does not declare a step (a plugin catalog-style macro-only
  root, a custom model without animals) now runs the classifier by default.
- A camera that gated a classifier off no longer gets the root's fine label
  raised to the detection's score for it; the executor's score-0 fallback
  still lands, as under D715.
- `filledBy` names the model the device runs; announces that named `yolo26n`
  on GPU/NPU/ANE sessions stop doing so.
- Deploy order: `addon-pipeline` (the catalog default the resolver reads, the
  runner's plan) first, then `addon-pipeline-orchestrator` (only the
  catalog-free `DEFAULT_OFF_STEP_IDS`, used by the done-flagged migration),
  then `addon-admin-ui` and `addon-model-studio` (text and chips). No
  framework package changes behaviour; `@camstack/types` changes a comment.

## Enforcement

Tests: `root-sourced-classifier-defaults.spec.ts` (the catalog defaults, the
node-default tree, a declaring root announces `filledBy` and a non-declaring
root leaves the classifier running), `root-supply.spec.ts` (a gated-off or
absent step is not planned; an unpinned root is the elected device's default),
`root-supply-through-run-inference.spec.ts` (the log names only steps the
camera runs), `pipeline-resolver.spec.ts` (`DEFAULT_OFF_STEP_IDS`),
`NodeDeviceStepsMatrix.spec.tsx` and `DeviceStepOverrideTab.spec.tsx` (the
chip reads the node-folded settings). Removing each fix fails its test.
Nothing structural stops a new consumer of `resolveRootSupply` from passing a
device's own settings instead of the folded ones — review only.
