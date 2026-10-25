---
id: D738
title: A class confidence floor defaults to the model that runs, and an operator override is bound to the model it was set for
status: accepted
date: 2026-10-07
supersedes:
applies-to:
  - packages/types/src/pipeline/model-bound-settings.ts
  - packages/addon-pipeline/src/detection-pipeline/registry/model-catalogs.ts
  - packages/addon-pipeline/src/detection-pipeline/pipeline/tree-builder.ts
  - packages/ui-library/src/composites/model-bound-slider.tsx
---

Extends [D662](adr-0662-a-detector-confidence-floor-belongs-to-the-model-and-a-face-lies-inside-its-person.md)
from the pool floor to the operator's per-class floors.

## Context

The object-detection step has three per-class floors, `minConfidencePerson`
/ `Vehicle` / `Animal` (0.65 / 0.50 / 0.50). They were tuned on the YOLOv9
root that every accelerator of this hub runs, and they applied to every
model. Detectors score the same true objects very differently. The median
score of a correct person, measured on this hub on 2026-10-07:
`yolov9m-320-int8` 0.78, `yolo26s-320-int8` 0.68, `yolo26n-320-int8` 0.40,
`yolo26s` (640) 0.89. One global floor is right only for the model it was
tuned on. At 0.65 a `yolo26n-320-int8` root misses most real people. On
`yolo26s` (640) the same floor is lax.

D662 already made the DEFAULT confidence a property of the model, but only
for the pool floor and the classifier sliders. An operator value on a
slider still won over every model, so a floor tuned on one model stayed in
force after the model changed.

The operator asked for this:

- the default floors follow the model;
- a model change applies that model's defaults automatically;
- the operator can then change them;
- a further model change resets them to the new model's defaults.

Three things rule out the obvious design, "reset the stored floors when the
model changes":

- **The model can change with no write at all.** An unpinned root runs the
  elected device's hardware-aware default (D736). The camera can also be
  balanced onto another accelerator, or a release can change a default.
- **An event-driven reset can be dropped.** Events are telemetry
  (D8/D11). A lost event would leave a stale floor in force with nothing to
  show it.
- **Settings and model are stored at different granularities.** Step
  settings are folded node-wide across accelerators (`foldNodeStepSettings`),
  while `modelId` is per device. One stored floor can be in force on two
  devices that run two different models.

## Decision

**The default belongs to the model.** A catalog entry may declare
`defaultClassFloors` (`{ person, vehicle, animal }`), which is a
`ModelCatalogEntry` field. A custom or imported model (plus catalog, BYO) can
carry the field through the custom-model registry. The object-detection
step's `getConfigSchema(model)` uses the model's row as each slider's
default. A class the row leaves out, or a model with no row, runs at the
step's global default (0.65 / 0.50 / 0.50).

The object-detection rows live in ONE table in `model-catalogs.ts`
(`OBJECT_DETECTION_CLASS_FLOORS`, model id → floors). That is the row shape
the floor measurement emits (`model-floors.json`). The table is stamped onto
the entries, and a test refuses a row that names no catalog entry.

**An override is bound to the model it was made for.** It is stored as the
plain value under its own key, plus a sibling key `<key>ModelId` that names
the model. Fields flagged `bindsToModel` (the three floors) follow one
rule, in `@camstack/types` `pipeline/model-bound-settings.ts`. The runner
and the editors both use that rule:

```
effective = stored value    if the binding names the model that RUNS
          | stored value    if there is no binding (legacy / programmatic)
          | the running model's default
          | the field's global default
```

**"The model that runs" is the resolved variant on the runner** — per
camera session, on the elected (node, device). `tree-builder` checks the
binding against `variant.modelId`. That is the model the device actually
loads, including an unpinned root's hardware-aware default. It is never the
stored pin. The override itself stays at the level where the operator
wrote it: the node row (folded node-wide) or the camera's per-(node, device)
override. It binds to the model that row or cell ran when it was saved. A
model change makes the override inapplicable by READ. Nothing is written on
the model-change path.

**An unbound value applies to any model, as before.** A floor stored before
D738, or passed by a benchmark or replay that carries no model, keeps its
pre-D738 meaning. The editor binds it the next time the operator saves it.

**The editor shows the effective value and its source** ("Override for
this model" / "Model default" / "Default — not tuned for this model"). It
names an override made for another model as inapplicable, and it offers
"Reset to model default", which removes the value and its binding. Each
model's default reaches the UI as `modelApplicability.defaultByModel`.
`getSchema` computes it from the same `getConfigSchema(model)` the runner
hydrates from. Every write is bound to the row's EFFECTIVE model, so the
settings editors now receive the effective model, not the step's flat
catalog default.

## Consequences

- **Nothing changes on deploy for this hub.** Every accelerator of this hub
  runs a YOLOv9 root (`yolov9m-320-int8` on the iGPU and NPU of `hub` and
  `agent-a`, `yolov9m-320` on the Mac ANE). The YOLOv9 rows restate
  0.65 / 0.50 / 0.50 exactly. A read-only census on 2026-10-07 found no
  stored floor anywhere: no node `inferenceDevices` object-detection entry,
  no per-camera step override and no template. So no stored value needs a
  binding, and no migration ships. A CPU-class node runs `yolo26n`, which is
  untuned and stays at the global defaults.
- **Initial rows.** YOLOv9 (all 16 entries) are at today's values.
  `yolo26s-320` person 0.55, `yolo26s-320-int8` person 0.45, `yolo26s` (640)
  person 0.45, all precision-matched on this hub. Every other model is
  untuned and runs at the global defaults until the measurement fills its
  row.
- **Going back to a model brings its override back.** A→B→A with no edit on
  B restores A's override: it is still stored and bound to A. One override
  is kept per field and level. Editing on B replaces A's.
- **A legacy unbound value at a higher layer can inherit a lower layer's
  binding** through the shallow per-key merge (node base, then camera
  override). No such pair exists on this hub, and every editor write sets
  both keys.
- **The onboard root (camera firmware) gate reads the stored values raw**,
  binding ignored, exactly as before (`rootObjectGate`). The camera's own
  detector is not on any catalog model's scale.
- The classifier `minConfidence` sliders (D662) are not bound yet. They
  could take `bindsToModel` with no new mechanism.
- **Release.** This changes `@camstack/types` (catalog schema field, config
  field flag, the shared rule) and `@camstack/ui-library`. Both are bundled
  by `addon-pipeline` and `addon-admin-ui`. Until a `@camstack/server` with
  the new types is installed, the hub's `customModelRegistry` route strips
  `defaultClassFloors` from a registration, because it validates with
  `ModelCatalogEntrySchema`. The catalog rows ride the `addon-pipeline`
  deploy.

## Enforcement

- `packages/types/src/pipeline/__tests__/model-bound-settings.spec.ts`: the
  rule. It covers the default, an override for the same model, an override
  after a model change, a custom model with no defaults, a legacy unbound
  value, and an unknown model.
- `addon-pipeline/.../__tests__/model-bound-class-floors.spec.ts`: the
  catalog rows, with YOLOv9 exactly at the global floors and no orphan rows.
  It also runs the real `buildExecutableTree` hydration per running model
  (default, same-model override, model change, per-class bindings, custom
  model with and without floors), checks that binding keys never reach the
  runtime settings, the late per-device layer, and `defaultByModel`.
- `ui-library/.../config-schema-field-model-bound.test.tsx`: the editor
  shows the selected model's value and source, does not show another
  model's override as the value, writes bound changes, and resets.
- Each fix was disarmed and seen to fail its tests: the binding comparison,
  the tree-builder merge, the model default and the editor route.
- Nothing stops a new reader from merging raw `step.settings` over the
  defaults without `applyModelBoundSettings`. That is review only, and
  `tree-builder` is the one merge site.
