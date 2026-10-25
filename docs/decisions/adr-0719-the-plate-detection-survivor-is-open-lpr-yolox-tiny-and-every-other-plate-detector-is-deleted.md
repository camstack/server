---
id: D719
title: The plate-detection survivor is open-lpr's YOLOX-tiny, and every other plate detector is deleted
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/registry/model-catalogs.ts
  - packages/addon-pipeline/src/detection-pipeline/registry/model-licenses.ts
  - packages/addon-pipeline/src/detection-pipeline/registry/step-definitions.ts
  - packages/addon-pipeline/src/detection-pipeline/pipeline/plate-ocr-crop-policy.ts
  - scripts/build-yolox-plate-model.py
  - scripts/build-camstack-models.py
---

> **Amended by [D725](adr-0725-a-stored-pin-to-a-deleted-model-is-reset-to-the-step-default-by-the-orchestrator.md)
> on 2026-10-06.** A saved `yolov8n-plate` pin is reset to the step default by
> the orchestrator, not left for the operator to replace.

> Extends [D703](adr-0703-one-licence-clean-model-survives-per-enrichment-step-and-a-deleted-model-id-is-just-a-custom-model.md)
> to the one enrichment step it left out, and applies
> [D710](adr-0710-a-coral-build-of-a-survivor-is-a-format-of-that-model-admitted-by-what-it-costs-the-shared-edge-tpu-context.md)
> to it.

## Context

D703 left one licence-clean model per enrichment step, except plate detection.
Its only model, `yolov8n-plate`, was two different third-party fine-tunes of
Ultralytics YOLOv8n under one id: the ONNX and OpenVINO files were ml-debi's
`best.onnx`, the CoreML and TFLite files exports of Koushim's `best.pt`. Both
were AGPL-3.0 through the Ultralytics base, neither published its training
data, and the ONNX had no checkpoint at all, so its AGPL "Corresponding Source"
was the ONNX itself. It was also the reason the plate reader needed a +15%
margin: its box clipped the leading glyph of an oblique plate (D200).

No CamStack-trained replacement existed. The 2026-09-26 Coral study had named
"train a clean plate detector" as a multi-day item. On 2026-10-06 open-lpr
published a YOLOX-tiny plate detector (`faisalthaheem/open-lpr-models`, tag
`detector-2026.10.1`), trained from Megvii's COCO `yolox_tiny.pth` and released
under Apache-2.0. Phase 1 of the swap measured it against `yolov8n-plate` on
real hub vehicle tracks:

- the graph edit (RGB /255 in, the YOLOv8 output layout out) lets the shipped
  pool and `yolo` postprocessor run it unchanged;
- OpenVINO IR fp16 and CoreML fp16 return the same detections as ONNX Runtime
  at confidence 0.5 on 30 of 30 samples;
- at the shipped OCR margin of 0.15 it LOSES about 8 readings, because its boxes
  are bigger than YOLOv8n's: the margin padded an already padded plate and
  shrank it in the reader's 128x64 tile. At 0.05 it reaches parity.

## Decision

`yolox-tiny-plate` is the plate-detection step's only model and its default.
`yolov8n-plate` is deleted from the catalog, from `build-camstack-models.py`
(its recipe, the third-party download and the TFLite path that only it used)
and from the Hugging Face mirror (`plateDetection/yolov8-plate`). The
`plate-slots` reader margin moves from 0.15 to 0.05 with it: the margin is a
property of the detector's box, and it changes only together with the detector.

- Built by `scripts/build-yolox-plate-model.py` from the upstream ONNX pinned by
  commit and SHA-256; ONNX fp32, OpenVINO IR fp16, CoreML fp16, each runtime in
  its own process, with a parity check against upstream and across runtimes.
- Licence record `OPEN_LPR_YOLOX_APACHE`: weights and code Apache-2.0. The
  weights' Apache status is inferred from the open-lpr repository licence and
  its NOTICE (YOLOX code and its same-repository weights are Apache-2.0; no
  Ultralytics weights used), not from a per-file statement. Training data
  terms are `UNKNOWN`: the imagery is unpublished, and the upstream NOTICE says
  the community photographs were "uploaded without consent obtained". The
  NOTICE travels verbatim (`licenses/models/NOTICE-open-lpr.txt`, and the
  mirror folder's `NOTICE`), as Apache-2.0 §4(d) requires.
- Confidence floor stays 0.5.
- **No Coral build.** Under D710 a `formats.tflite` would have to be the same
  id, contract-checked and cost-checked. It cannot be produced: YOLOX's Focus
  stem (four strided Slices and a Concat over the full 640x640 input) is the
  documented reason YOLOX fails `edgetpu_compiler` ("large activation
  tensors"), and even a build that compiled could not pass D710's contract
  check: an int8 build needs a plate calibration set and parity measured on
  real plate crops, and none is kept (the evaluation samples were deleted on
  purpose). The compiler itself is reachable on the Mac (amd64 container under
  Lima + Rosetta, as the bird-classifier build does); it is not the blocker.
  The old Koushim TFLite file is not kept as a substitute. A
  Coral-elected camera keeps running plate detection on another device of its
  node (D650/D657), as it already did: `yolov8n-plate` never had a catalog
  `tflite` format either.

## Consequences

- A saved pin to `yolov8n-plate` is a custom model (D703): a node that cannot
  serve it refuses it by name until the operator picks `yolox-tiny-plate`.
  Rows that never pinned a model follow the new default.
- With the mirror folder deleted, a node that does not already hold the
  `yolov8n-plate` files can no longer download them.
- The plate reader's margin is now coupled to the detector in the code comment
  and the spec. A future detector swap must re-measure it; 0.05 is not a
  property of `cct-s-v2-global`.
- No AGPL weights remain in plate detection, so the AGPL source offer and the
  `source/` folder of the mirror cover only the object-detection and
  segmentation folders.

## Enforcement

- `removed-model-ids.spec.ts` keeps `yolov8n-plate` out of every catalog and
  pins `yolox-tiny-plate` as the step's only entry and its default.
- `plate-ocr-crop-policy.spec.ts` and `step-registry-plate-ocr-charset.spec.ts`
  pin the 0.05 margin.
- `scripts/check-catalog-licence.ts` requires the licence record and the model
  card (`CARDS_IN_BUILD_SCRIPTS` names the build script that owns it);
  `scripts/check-model-notices-shipped.ts` fails if the cited NOTICE file is
  missing.
- Nothing stops a later detector swap from keeping the 0.05 margin unmeasured:
  review only.

## Addendum, 2026-10-06 — the Coral build exists after all

The "No Coral build" paragraph above is overtaken by the D710 addendum of the
same date: with the Focus stem rewritten as the equivalent 6x6 stride-2 Conv
and the graph cut before the grid decode, `edgetpu_compiler` maps all 274 ops
(one subgraph, 640 input, 5.55 MiB of parameters), and the int8 build passed
parity on 172 real camera-102 vehicle crops (all 109 reference plates found,
reads 80 vs 83 at margin 0.05). `yolox-tiny-plate` now ships `formats.tflite`
(`scripts/build-yolox-plate-edgetpu.py`). Nobody needs to re-spike it; the
measured numbers are in D710. Beside the root detector it is loaded from the
co-compiled set `root-plate-bird` (D724).
