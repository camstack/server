---
id: D1065
title: A pipeline step is switched per cluster, node and device; a camera toggles only what the cluster allows
status: accepted
date: 2026-11-18
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/pipeline-resolver.ts
  - packages/addon-pipeline-orchestrator/src/step-switch-matrix.ts
  - packages/addon-pipeline-orchestrator/src/pipeline-settings-store.ts
  - packages/addon-pipeline-orchestrator/src/attach-pipeline.ts
  - packages/addon-pipeline-orchestrator/src/node-step-settings.ts
  - packages/addon-pipeline-orchestrator/src/inference-device-model.ts
  - packages/addon-pipeline/src/pipeline-runner/device-jump.ts
  - packages/types/src/capabilities/pipeline-orchestrator.cap.ts
  - packages/types/src/capabilities/pipeline-runner.cap.ts
  - packages/types/src/types/agent-pipeline-settings.ts
---

## Context

D927 left one switch per step: the camera's `stepToggles`, defaulting to the
catalog's `enabledByDefault`. An operator who wanted a step off everywhere had
to turn it off on every camera, and a new camera came up with it on again. A
step could not be kept off one node (an agent too small for face embedding)
or off one accelerator (a Coral that runs the root but should not take the
detail plane). The inspector derived its "enabled" column from the catalog
default alone, so it showed segmentation as on although no camera ran it, and
its `resolvePipeline` preview resolved on the node's default format with no
jump roster, reporting as dropped every detail step a sibling accelerator runs.

## Decision

A step has three switch layers above the camera, read by ONE gate
(`gateStep`) and ONE placement (`placeStepOnDevices`) that the attach path and
the inspector read (`getStepSwitches`) both call:

- **Cluster mode** (`setClusterStepMode`, orchestrator store
  `clusterStepModes`): `off` — hard off, no camera can turn it on; `on` — on
  unless a camera turns it off; `opt-in` — off unless a camera turns it on.
  Absent = the catalog default (`enabledByDefault: false` → `opt-in`, else
  `on`).
- **Node switch** (`setNodeStepEnabled`, `agentSettings.stepEnabled[step]`):
  `false` skips the step on that node (`disabled-on-node`).
- **Device switch** (`setDeviceStepEnabled`,
  `inferenceDevices[key].steps[step].enabled`): `false` means the device never
  runs the step. A detail step jumps to an allowed sibling (the runner's
  auto-jump and a manual `jumpDeviceKey` exclude the device; the attach roster
  carries `disabledSteps`); with no allowed sibling it is skipped
  (`disabled-on-device`). The camera root switched off on its elected device
  is skipped, not refused as unrunnable.

Precedence: cluster off > camera toggle (else the cluster default) > node off
> device off / jump. Every switch skip is logged with its reason and
`tags: { deviceId }`; a camera's own toggle is intent and is not logged as a
skip. `package-detection` stays zone-driven, but the cluster, node and elected
device switches apply to it. This amends D927: the camera still only turns
steps on or off, but within what the cluster mode allows.

## Consequences

- A switch change re-resolves every placed camera on the affected node (all
  nodes for a cluster switch) through `resolveAttachPipeline` on its elected
  device and re-attaches it; a camera whose root would be refused keeps its
  live attach and logs an error.
- The election never elects a device the camera root (`object-detection`) is
  switched off on — by the cluster, its node or the device itself
  (`makeRootSwitchGuard`, the same `gateStep` plus the device switch). The
  device is reported `root-switched-off` and does not suppress the CPU
  fallback. A switch change re-resolves placed cameras on their current
  device; the re-election happens at the next placement.
- A default-pool attach (no elected device) obeys the device switches of the
  device(s) the pool may be (`poolDisabledSteps`): the eligible devices, or,
  with none eligible, every enabled device. A step is skipped only when all of
  them switched it off.
- The `resolvePipeline` preview goes through placement
  (`previewAttachPipeline`): the device an attach would elect, its roster and
  its switches.
- The inspector reads cells; it never derives one.

## Enforcement

Specs: `pipeline-resolver.spec.ts` (precedence and reasons),
`attach-step-switches.spec.ts` (writers through the real store and the attach
path), `step-switch-matrix.spec.ts` (inspector cells, `opt-in-unused`,
audio never format-gated), `device-jump.spec.ts` and `detail-subtree.spec.ts`
(the runner never runs a switched-off subtree), `election-root-switch.spec.ts`
(the election and the device view), `resolve-pipeline-preview.spec.ts` (the
preview goes through placement). No guard.
