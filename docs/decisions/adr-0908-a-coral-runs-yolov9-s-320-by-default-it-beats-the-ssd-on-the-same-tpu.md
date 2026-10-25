---
id: D908
title: A Coral runs YOLOv9-s @320 by default — it beats the SSD on the same TPU
status: accepted
date: 2026-10-22
supersedes:
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/registry/step-definitions.ts
  - packages/addon-pipeline/src/detection-pipeline/registry/model-catalogs.ts
  - packages/addon-pipeline-orchestrator/src/inference-device-model.ts
---

## Context

[D710](adr-0710-a-coral-build-of-a-survivor-is-a-format-of-that-model-admitted-by-what-it-costs-the-shared-edge-tpu-context.md)
kept the one Coral object detector, `ssd-mobilenet-v2-coco-edgetpu`, as the
`tflite` default and admitted the community YOLOv9-s Edge TPU builds as
"selectable only, never a default" until they had been measured on the
operator's own frames. They now have (`docs/benchmarks/2026-10-22-coral-pcie-amd-phoenix.md`,
91 frames, 18 cameras, the same PCIe Coral for every row):

| Detector | full frame @0.3 | with a region crop | small subjects, full frame / crop |
| --- | --- | --- | --- |
| SSD MobileNet V2 | 18/134 | 91 | 2 / 35 |
| YOLOv9-s @320 | 29 | 92 | 2 / 43 |
| YOLOv9-s @512 | 50 | 81 | 12 / 40 |

("Crop" is an upper bound: one 320 or 512 crop centred on each subject.) The
YOLO builds are never worse on the same TPU. At production floors the gap is
wider still, because the SSD's row was tuned and the YOLO builds had none
(their true-positive median score is 0.48-0.61; the global person floor of
0.65 halves their recall).

Choice between the two builds: 320 runs the pool step in 23-29 ms on PCIe
against 54-62 ms for 512 (the pure-Python split-DFL decode grows with the
cell count), and is the best of the three once the frame is cropped to a
region (92 vs 81). 512 wins only on small subjects of a full frame.

## Decision

The `tflite` format default of the object-detection step is
`yolov9s-320-edgetpu`. It is declared once, in
`defaultModelIdByFormat.tflite` (`step-definitions.ts`); `resolveDefaultDetectionModel`,
`getDefaultModelForFormat`, Model Studio and cold start all read it. The
orchestrator's per-device view duplicates it by necessity
(`inference-device-model.ts`) and follows. Auto tune is untouched: it still
never picked for a Coral then and a Coral stayed opt-in; both are superseded by D912 (an enabled Coral is sized, and a Coral is enabled by default).
The SSD and the 512 build stay selectable; an explicit pin keeps its model.

Both YOLO Edge TPU builds get their own `defaultClassFloors` row, person 0.4,
vehicle 0.4, animal 0.3 (benchmark recommendation 0.3-0.4; animal has the
lowest true-positive median, 0.48-0.49). These are not in
`model-floors.json`: that file is the 409-frame hub measurement, and these
rows come from the 91-frame Coral benchmark.

## Consequences

- **Existing nodes.** Only an UNPINNED Coral changes: the next pipeline build
  that resolves the root through the format default loads `yolov9s-320-edgetpu`,
  downloading it once from the Hugging Face mirror (sha256-pinned, D743/D744)
  if the node's models directory does not hold it. A Coral with an explicit
  model pin (per-device `steps` or addon settings) keeps the SSD. A node
  needs the new `@camstack/addon-pipeline` / `@camstack/addon-pipeline-orchestrator`
  deployed for any of this to happen; nothing re-downloads before that.
  agent-b (live Coral, `edgetpu:pci` + `edgetpu:pci:1`): unpinned units
  switch to YOLOv9-s @320 at their next pool load after the deploy and
  download it once; a pin census (`model_pin_census`) tells which are pinned.
- **17-class label set.** The community build has COCO's first 17 classes
  (person, vehicles, animals), no `package`. Package still comes from its own
  step; a Coral-rooted camera that relied on the SSD's 80-class vocabulary for
  anything outside the macro mapping loses nothing CamStack consumes.
- **Cost.** More step time than the SSD (30 vs 18 ms warm p50), mostly the
  Python decode; the Coral is one shared context, so the D710 rule that any
  second model on it is a parameter re-stream is unchanged.
- The GPL-3.0 weights licence (D661) is unchanged; the notice now marks the
  320 build as the default.
- Amends D710 on exactly one point: "never a default".

## Enforcement

`model-catalogs-coral-yolov9.spec.ts` (default resolves to the 320 build for
cold start and for `edgetpu:usb|pci`; a pinned SSD/512 still resolves to
itself; both builds carry floors at or under 0.4/0.4/0.3),
`model-catalogs-coral-ssd.spec.ts`, `default-detection-model.spec.ts`,
`get-default-model-for-format.spec.ts` and the orchestrator's
`node-inference-devices-cap.spec.ts`.
