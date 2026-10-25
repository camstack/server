---
id: D739
title: The floor defaults are measured per model, every model-scaled threshold binds to its model, and an import brings its source's defaults
status: accepted
date: 2026-10-07
supersedes:
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/registry/model-catalogs.ts
  - packages/addon-pipeline/src/detection-pipeline/registry/step-definitions.ts
  - packages/types/src/catalogs/plus-catalog-classmap.ts
  - packages/types/src/pipeline/model-bound-settings.ts
  - packages/ui-library/src/composites/model-bound-slider.tsx
  - docs/benchmarks/model-floors.json
---

Extends [D738](adr-0738-a-class-confidence-floor-defaults-to-the-running-model-and-an-override-is-bound-to-the-model-it-was-set-for.md).

## Context

D738 put the per-class floor defaults on the model. It kept YOLOv9 at the
global values and set three YOLO26 person floors from an early estimate. A
measurement run on 2026-10-07 then calibrated 29 catalog detectors on 409 hub
frames. The ground truth is an ensemble of two large reference detectors. The
record is [`model-floors.json`](../benchmarks/model-floors.json), with
precision and recall per class.

The run showed two problems with the D738 rows:

- **The tuned-on-v9 globals are wrong for the live root itself.**
  `yolov9m-320-int8` keeps its false-positive budget at vehicle 0.40 and
  animal 0.45, so the 0.50 floors cost it recall for nothing.
- **The early YOLO26 estimates were off by 0.05–0.10.**

The operator settled the open points of D738:

- An override stays per model. A→B→A brings A's back.
- Unbound legacy values get no migration.
- The drawer needs one button that resets every threshold of the step.

Two more model-scaled thresholds turned out to have the D738 problem. The
classifier `minConfidence` sliders and the package detector's
`minConfidencePackage` sit on the model's scale, and an operator value
outlived a model change.

Imported detectors had no floors of their own. Their source systems publish
defaults, and those defaults apply to a different kind of gate. The source
code (plus catalog `dev` at f1c4a9f, plugin catalog at 440926e) and plus catalog's docs show
this:

| Source | Knob | Default | What it is |
| --- | --- | --- | --- |
| plus catalog | `objects.filters.<label>.min_score` | 0.5 | Drops a single detection before tracking (`is_object_filtered`) |
| plus catalog | `objects.filters.<label>.threshold` | 0.7 | Compared with the **median of the last 10 scores** of a tracked object. A frame without a detection adds 0.0. The docs say the history is "padded to 3", the code does not pad. |
| plus catalog | Detector-internal cut | 0.4 | Any `min_score` below 0.4 has no effect |
| plus catalog | Attribute labels (face, plate, …) | `min_score` 0.7 | No `threshold` |
| plus catalog docs | Starting values | person 0.65/0.85, car 0.65/0.85, cat 0.65/0.8, dog 0.7/0.9 (`min_score`/`threshold`) | "plus catalog models generally have much higher scores" |
| plugin catalog (openvino, coreml, onnx, ncnn, tflite share one parser) | `defaultThreshold` | 0.2 | One cut for every class and model, no per-model value. Consumers apply their own: smart motion sensor 0.7, occupancy sensor 0.4. |

## Decision

**The per-model floor rows are the measurement.** `OBJECT_DETECTION_CLASS_FLOORS`
holds exactly the 29 rows of `model-floors.json` for person, vehicle and
animal. Two floors hinge on a single high-score false positive, and each takes
the next-lower value the file names:

- `yolov9m-320` vehicle: 0.75 measured, 0.50 used;
- `yolov9s-320-int8` vehicle: 0.70 measured, 0.45 used.

`package` stays at its global default because it is not calibrated. A spec
reads the JSON and holds the table equal to it, so a re-measurement replaces
both together. The globals (0.65 / 0.50 / 0.50) stay as the fallback for
unmeasured models.

**Every operator threshold that sits on a model's score scale binds to the
model** under the D738 rule (`bindsToModel`). That covers the object-detection
floors, `minConfidence` of the animal, vehicle and bird classifiers, and
`minConfidencePackage`. Plate and face detection have no operator threshold.
Their floor is the model's `defaultConfidence` alone (D662), so there is
nothing to bind. The audio classifier's `minConfidence` is not bound: the
audio path reads it outside the step tree, and its models declare no
per-model default.

**"Reset thresholds to model defaults" is one write.** The step drawer, both
the node matrix and the camera override, offers it when any model-bound
override is in force for the row's effective model. It clears all of them in
one settings change. An override stored for another model is kept, because
it applies again when that model runs. The per-slider reset stays.

**An imported detector brings its source's per-detection default, never its
track gate.**

- A stock plus catalog import (public catalog, uploaded preset, unified
  registration) gets `min_score`: 0.5 for every class.
- A plus catalog import gets the documented plus catalog starting `min_score`:
  person 0.65, vehicle 0.65, and animal 0.65, the lower of cat 0.65 and dog
  0.70, so no class is cut above its documented value.
- An import that states its own floors keeps them. A template may carry
  `defaultClassFloors`.
- plus catalog's `threshold` is a different gate. It is a median over a track's
  recent scores, zeros included. CamStack confirms identity through the
  tracker (D683), not with a score median, so it is not carried.

**The plugin catalog values are not adopted.** Its 0.2 is a candidate cut, the
same role as our pool floor. Its 0.4 and 0.7 are consumer gates, and none
of them is per model. Our floors are measured on the same YOLOv9 family on
this hub's frames, which their values cannot replace.

## Consequences

- **The live root changes on deploy.** `yolov9m-320-int8` runs on the hub
  iGPU and NPU and the agent-a iGPU. Its vehicle floor goes 0.50 → 0.40
  and animal 0.50 → 0.45. Person stays 0.65. This is intended. On 409 frames
  it keeps the same false-positive count (1 vehicle, 3 animal) and raises
  recall.
- **The Mac ANE default changes too.** `yolov9m-320` goes to person 0.70
  (from 0.65), vehicle 0.50 (unchanged) and animal 0.55 (from 0.50).
- **A CPU-class node runs `yolo26n`.** Every CPU device on this hub is
  disabled. If one were enabled, its floors would be person 0.65, vehicle
  0.40 and animal 0.50.
- The Coral SSD (`edgetpu:usb`, disabled on the hub) gets person 0.60,
  vehicle 0.35 and animal 0.40.
- No stored override exists on this hub (D738 census), so nothing masks
  these defaults.
- A plus catalog model imported before this release has no `defaultClassFloors`
  and runs at the globals until it is re-imported.
- Floors carry about ±0.05–0.10 of noise, because the false-positive counts
  are single digits. Animal is the least stable: most animal false positives
  are people labelled dog or cat at high confidence.

## Enforcement

- `model-bound-class-floors.spec.ts` checks:
  - the catalog equals `docs/benchmarks/model-floors.json` (fragile floors at
    the lower value);
  - the in-use rows, and that no `package` row exists;
  - the four classifier and package thresholds are `bindsToModel`;
  - a classifier threshold does not survive a model change.
- `model-bound-settings.spec.ts` checks `clearModelBoundOverrides` and
  `hasModelBoundOverrides`.
- `agent-step-editor-model-defaults-reset.test.tsx` checks:
  - one change clears every override for the effective model, in both
    editors;
  - an override stored for another model is kept;
  - no button appears when there is nothing to reset.
- `plus-catalog-default-floors.test.ts` checks stock versus plus catalog defaults on
  every import path, carried floors, template parsing, and that a custom
  model gets nothing.
- Each was seen to fail with its fix disarmed.
