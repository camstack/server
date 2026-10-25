---
id: D754
title: A camera's step setting is camera-wide and field-level; only a model stays per accelerator
status: accepted
date: 2026-10-07
supersedes:
applies-to:
  - packages/types/src/capabilities/pipeline-orchestrator.cap.ts
  - packages/types/src/types/agent-pipeline-settings.ts
  - packages/types/src/pipeline/step-settings-layers.ts
  - packages/addon-pipeline-orchestrator/src/pipeline-settings-store.ts
  - packages/addon-pipeline-orchestrator/src/orchestrator-store-schemas.ts
---

## Context

Until now a camera could override a detection step's settings in exactly one
place: `cameraSettings[cam].stepOverridesByDevice[node][deviceKey][step]`, one
copy per **accelerator**. Dispatch merges it over the node's folded base, per
device (`applyDeviceProvisioning`: `{ ...base.settings, ...override.settings }`).

A camera does not live on one accelerator. Since D748 it is balanced onto a
`(node, accelerator)` at every session start. "Raise this camera's person floor"
therefore meant one edit per column — four on this hub (hub iGPU, hub NPU,
agent-a, Mac mini). Measured on the old step matrix, that was 9–11 clicks,
15 key presses and 7.4–9.4 k px of scrolling. Missing one column meant the old
floor ran whenever the balancer picked that accelerator, and nothing on screen
said so. The default pool (`deviceKey ''`) had no camera override at all.

The editor made it worse. Its "Override" button copied the node's WHOLE
settings bag into the camera override (`agent-step-editor.tsx`,
`setSettings({ ...agentDefault.settings })`). From then on every field was
pinned at the value it had that day, so a later node edit no longer reached that
camera on that accelerator — for every field, not only the one the operator had
meant to change. "Clear" removed the whole override. The node value behind an
overridden field was shown nowhere.

## Decision

**A camera's step settings are camera-wide and field-level. Only a step's model
is per accelerator.**

- `CameraPipelineSettings.stepSettings[step]` is a sparse bag of the fields this
  camera overrides on EVERY accelerator. A key that is present is an override;
  an absent key inherits. It is written by
  `pipelineOrchestrator.setCameraStepSettings({ deviceId, addonId, settings })`.
  `null` or `{}` clears the step, and an empty layer is pruned.
- Dispatch merges per key: **node (folded base) ⊕ camera ⊕
  camera-per-accelerator**. `readDeviceProvisioning` folds the camera layer
  under the per-device override (`layerCameraStepSettings`), so
  `applyDeviceProvisioning` is unchanged. The layer also reaches the default
  pool.
- The per-accelerator override (`stepOverridesByDevice`) stays. It is for the
  per-format model pin, and for a setting that really is per accelerator (rare).
  It too is written field-level from now on.
- **A model-bound field (D738) is written as a pair**: the value and its
  `<key>ModelId` binding. A layer never writes one half without the other. This
  is required because the merge is shallow per key: a value without its binding
  sitting over a lower layer's binding would be judged against the wrong model.
- The editors write DIFFS. A field equal to the next layer down is not stored,
  and resetting a field removes its key (both keys for a model-bound field)
  from that layer only. The rule is `@camstack/types`
  `pipeline/step-settings-layers.ts`, shared by the admin UI.

**Migration: none on deploy.** Behaviour must not change when this ships, so the
stored data is not touched:

- An existing per-accelerator override keeps applying exactly as before. The
  per-device merge is unchanged, and the camera layer is empty until someone
  writes it.
- A legacy full-copy override is **normalised lazily**, by the operator. The
  editor marks fields pinned at the node's current value ("pinned at node
  value"). The next save of that step writes the diff, and "Follow the node" on
  the step clears every pinned-but-equal field in one write. At that moment the
  values are equal, so nothing that runs changes. Only later node edits start to
  flow through, which is the point.
- We do **not** auto-fold identical per-accelerator overrides into the camera
  layer. The camera layer also applies to accelerators that carry no override
  today: a new accelerator, a node the camera has not run on, and the default
  pool. An automatic fold would change what runs there, on deploy, with no
  operator action. The editor offers it instead, explicitly, as "Apply to all
  accelerators" on a per-accelerator field. That moves the value to the camera
  layer and removes it from every per-accelerator override of that step.

## Consequences

- A camera-wide value made for model A (D738) does not apply while model B runs
  on some accelerator. It is reported there as inapplicable and falls to B's
  model default — **not** to the node's value. That is the existing D738
  semantics of a shallow per-key merge, now visible from one more layer. The
  editor shows the provenance per field: this accelerator · camera · node ·
  model default.
- Auto tune (D745) strips model-bound thresholds from node and per-accelerator
  layers, and leaves the camera layer alone. A camera-wide threshold bound to
  the old model then stops applying by itself (the binding no longer matches the
  model that runs), so no write is needed. A legacy UNBOUND camera-wide
  threshold cannot exist: every writer binds.
- "Reset node pipeline to defaults" clears per-camera overrides SCOPED to that
  node (`stepOverridesByDevice[node]`, `pipelineByAgent[node]`). It does not
  clear the camera layer, which belongs to no node.
- A camera's settings now have three layers instead of two. The admin UI is the
  only writer of the new one. Model Studio, the Auto tune and the removed-model
  sweep only ever touch models, which are not in it.

## Enforcement

- `addon-pipeline-orchestrator/src/__tests__/camera-step-settings-layer.spec.ts`
  checks the merge order, that the layer applies on an accelerator with no
  override and on the default pool, that a per-device model pin survives, the
  model-bound pair, and that an empty layer is pruned.
- The `setCameraStepSettings` router spec checks the admin tier and the null
  clear.
- `types/src/pipeline/__tests__/step-settings-layers.spec.ts` checks the diff /
  reset / provenance rule, including the model-bound pair.
- Nothing stops a future writer from storing a full copy again. The shared
  helper is the path of least resistance, and review is the rest.
