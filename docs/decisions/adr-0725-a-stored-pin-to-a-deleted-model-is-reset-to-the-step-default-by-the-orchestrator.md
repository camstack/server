---
id: D725
title: A stored pin to a deleted model is reset to the step default, by the orchestrator, in one place
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - packages/addon-pipeline-orchestrator/src/removed-model-pin-reset.ts
  - packages/types/src/pipeline/removed-model-ids.ts
  - packages/ui-library/src/composites/model-picker.tsx
---

> Amends [D703](adr-0703-one-licence-clean-model-survives-per-enrichment-step-and-a-deleted-model-id-is-just-a-custom-model.md)
> ("a pin or a cluster row naming a deleted id is not rewritten any more … an
> operator whose row still names a deleted model has to pick the survivor") and
> the same sentence in
> [D719](adr-0719-the-plate-detection-survivor-is-open-lpr-yolox-tiny-and-every-other-plate-detector-is-deleted.md)
> ("a saved pin to `yolov8n-plate` is a custom model … until the operator picks
> `yolox-tiny-plate`"). Everything else in both stands, and
> [D54](adr-0054.md)
> is untouched.

## Context

D703 deleted the Coral sibling SSDs from the object-detection catalog and
decided that a stored pin to a deleted id is not rewritten: it passes through
as a custom model, the node that cannot serve it refuses it by name, and the
operator picks the survivor.

On the hub that left `inferenceDevices['edgetpu:usb'].steps['object-detection']
= { modelId: 'ssdlite-mobiledet-coco-edgetpu' }` in the orchestrator's
`agentSettings`. The admin UI's model picker showed the amber "is a removed
model" banner on every visit to that cell, and the operator reported that the
problem "keeps coming back" after he pressed "Use default".

Nothing wrote the pin back. Every `setAgentInferenceDevices` call logs
`agentSettings.inferenceDevices updated` with the enabled keys, and the
Node-matrix drawer's Save always force-enables the device it saves. Loki held 13
such lines between 2026-10-04 22:22 and 2026-10-06 20:30. Only one of them,
2026-10-04 22:22:09, enabled `edgetpu:usb`. That was a day and a half before D703
deleted the model, and the Coral was switched back off three seconds later. No
write at all reached the store on 2026-10-06.

The "Use default" button only edits the drawer's draft. The banner disappears the
moment it is pressed, which reads as "fixed", and the drawer is then closed
without Save. In the per-camera tab the picker is disabled until "Override" is
pressed, and saving there writes a camera override, never the node pin. Under
D703 the only way out was a save the UI made easy to miss. The store kept a
model that nobody could serve, and the operator's explicit decision was that it
should reset on its own.

## Decision

A stored step pin whose id was deleted from that step's catalog
(`REMOVED_MODEL_IDS` in `@camstack/types`) is reset, unless a registered custom
model (the `custom-model-registry` collection, i.e. Model Studio) carries the
same id for the same step. Resetting a pin means dropping it from the store, so
the step follows its default. The pin is never rewritten to the default's id.

This applies to every store that holds a pin:

- per (node, device): `agentSettings[node].inferenceDevices[key].steps[step].modelId`;
- per camera: `cameraSettings[id].stepOverridesByDevice[node][key][step].modelId`;
- cluster rows: `clusterModel:<step>`, cleared with `null` as the settings form
  clears a select.

The reset happens in ONE place, `removed-model-pin-reset.ts` in the
orchestrator, which owns all three stores. It runs:

- at boot, after the per-(node,device) migration;
- after every write that can carry a pin: `setAgentInferenceDevices`,
  `setCameraStepOverride` with a `modelId`, and `updateGlobalSettings` with a
  `clusterModel:*` value.

Each pin it resets is one WARN, `model pin reset: removed model → step default`.
The meta names the old id, the step, the trigger, the device key and the
scope. The tags carry the `nodeId`, plus the `deviceId` for a camera override.
The cameras affected are then re-dispatched.

These things do not change:

- **Resolution.** `resolveModelForFormat` still passes an unknown id through,
  and `REMOVED_MODEL_IDS` is not a resolver input. D703's objection to
  `RETIRED_MODEL_IDS` was a second catalog that every resolver had to consult;
  this list has one reader, and it acts on the store, not the dispatch.
- **A custom model's pin.** Model Studio imports carry their own ids (the
  plus catalog MobileDet import is `frigate-mobiledet-edgetpu`) and are never reset.
- **Bulk passes (D54).** `runStatelessStep` runs the model its caller pinned for
  the whole pass, verbatim, and a node that cannot serve it refuses. A bulk
  pass whose caller read a cluster row gets the reset row: absent, so the
  default.
- **A failed read changes nothing (D49).** If the custom-model registry cannot
  be read, the sweep resets nothing and logs why; the next trigger tries again.
  The same goes for a cluster row whose three-way read is unreadable: it is
  left alone.

The model picker's banner now names what can still reach it: an id that is not
offered for this device (a custom model that is not installed, or one with no
build for the accelerator). Its button says the choice applies on Save.

## Consequences

- An operator never has to clear a deleted model by hand. A model deleted from a
  catalog must be added to `REMOVED_MODEL_IDS` in the same change, or its pins
  stay behind as custom ids, exactly as under D703.
- A reset changes the model a step runs. A cluster row moving off a deleted
  embedder moves the cluster onto the default encoder, and the index rebuild
  that needs stays the operator's explicit pass.
- `custom-model-registry` is a collection. If its provider (Model Studio) is
  installed but has not registered yet when the boot sweep runs, the answer is
  an empty list, and a custom model sharing a deleted catalog id would be reset.
  This is accepted: Model Studio never mints an id that is also a CamStack
  catalog id, so the collision takes an operator naming his import after a
  deleted model.
- Templates and the wholesale `pipelineByAgent` override are not swept.
  Provisioning never reads a `modelId` from them; they carry step structure only.

## Enforcement

- `removed-model-pin-reset.spec.ts` (orchestrator) covers six cases, and each
  case except the custom-model one fails with the sweep removed:
  - the boot sweep clears and persists the Coral pin, keeping its settings;
  - provisioning then carries no model for the step;
  - a registered custom model with the same id is left pinned;
  - an unreadable registry resets nothing;
  - each write path re-runs the sweep;
  - the camera reset line carries `tags.deviceId`.
- `removed-model-ids.spec.ts` (addon-pipeline) reads `REMOVED_MODEL_IDS` and
  fails if a catalog still ships one of its ids, or names a step no catalog
  knows.
- `stateless-step.spec.ts` case (b2) pins that a bulk pass pinned to a deleted
  id dispatches it verbatim and is refused, never substituted.
- Nothing stops a catalog deletion that forgets to extend `REMOVED_MODEL_IDS`.
  Review is the only check, as D703 already recorded.
