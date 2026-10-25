---
id: D710
title: A Coral build of a survivor is a FORMAT of that model, admitted by what it costs the shared Edge TPU context
status: accepted
date: 2026-10-06
supersedes:
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/registry/model-catalogs.ts
  - packages/addon-pipeline/src/pipeline-runner/device-jump.ts
  - packages/types/src/pipeline/step-format-runnable.ts
  - scripts/build-bird-classifier-edgetpu.py
  - scripts/build-yunet-edgetpu.py
  - scripts/build-yolox-plate-edgetpu.py
  - scripts/edgetpu_toolchain.py
  - packages/addon-pipeline/python/edgetpu_dequant.py
---

## Context

D703 left one licence-clean model per enrichment step and one Coral object
detector (`ssd-mobilenet-v2-coco-edgetpu`); every enrichment step on a
Coral-elected camera jumps to another device of the node (D650/D657).

The first Coral plan written after it (`docs/design/2026-10-05-coral-license-clean-set.md`,
first version) undid D703 by the back door: it proposed promoting SSDLite
MobileDet into the CamStack catalog next to the SSD survivor, and adding
Google's AIY bird Edge TPU file as its own model. Both are sibling models of a
step that D703 had just reduced to one — the very shape (`bird-classifier-aiy-edgetpu`,
`ssdlite-mobiledet-coco-edgetpu`) D703 deleted.

The second thing the plan did not weigh is what a Coral build COSTS. Adding a
`tflite` build to a non-legacy entry makes `stepModelRunsOnFormat(…, 'tflite')`
true, so `resolveStepDevice` answers `no-jump`: the step starts running ON the
Coral for every camera elected there. The Coral is one USB context, concurrency
1, no batching, ~8 MB of parameter SRAM. The root SSD alone is 6.6 MB, so any
second model is a parameter re-stream on every swap, paid by the root detection
of every camera on that pool. Compiling to the Edge TPU is the easy half; the
shared context is the scarce resource.

## Decision

A Coral (Edge TPU, `tflite`) build of an enrichment step is a **format of that
step's surviving model** — `formats.tflite` on the same catalog entry, same
`modelId`, same labels and same licence record (plus a `modifications` line) —
never a new model id. No `-edgetpu` sibling is added to any step, object
detection included: MobileDet stays reachable as a plus catalog catalog import
(Model Studio), not as a CamStack catalog entry.

A build is admitted only when all of these hold, and the change that adds it
states each one:

1. **Licence** — clean under D661 at the weights level, with no data reserve
   the survivor does not already carry.
2. **Contract parity** — normalisation baked into the graph (the edgetpu
   preprocess ignores `inputNormalization`), integer outputs dequantised by the
   edgetpu predict closure, and top-1 agreement with the survivor's reference
   build measured on real crops under the step's own confidence gate.
3. **Cost on the shared context** — parameter size, whether it swaps against
   the root detector, and the step's rate (once-per-track classifier vs
   per-frame). A build that would swap on a per-frame step is not admitted.
4. **Placement** — the deploy note names, per node with a Coral, whether the
   step should stay on the Coral or keep jumping, and sets that node's
   `edgetpu:*` `jumpDeviceKey` for the step BEFORE the build ships when it should
   keep jumping.

Steps whose survivor is a vector index (`face-embedding`, `clip-embedding`) are
not admitted at all: an int8 build of the same id would mix numerics in one
index (D52). Plate OCR (calibrated per-character gate), DETR package detection
and ViT CLIP are excluded structurally, so a later session does not re-spike
them.

## Consequences

- Adding a Coral build changes WHERE a step runs on every Coral-elected camera,
  not just what can be downloaded. It ships with its placement setting, not
  after it.
- A step whose survivor cannot be compiled (hard-swish/SE, attention) gets no
  Coral build until the survivor itself changes — the vehicle classifier waits
  for its licence-clean retrain (D711), not for a Coral-only model.
- No catalog-level "the Coral can, but prefer to jump" flag is added; the
  per-(node, device) `jumpDeviceKey` is the lever until a measured case needs
  more.
- The edgetpu output dequantisation is a prerequisite of every non-SSD build
  and lands before the first one.

## Enforcement

- `removed-model-ids.spec.ts` keeps the deleted Coral siblings out of every
  catalog; the `format-defaults-buildable` guard keeps `defaultModelIdByFormat`
  naming a model that really has the build.
- Each admitted build carries a fixture test that runs the real file's tensors
  through the real dequantisation and postprocessor.
- Nothing mechanically refuses a new `-edgetpu` model id or a build shipped
  without its placement note: review only.

## Addendum, 2026-10-06 — the first admitted build: `bird-classifier`

`bird-classifier` gains `formats.tflite`
(`animalClassification/bird-classifier/tflite/bird-classifier_edgetpu.tflite`),
built by `scripts/build-bird-classifier-edgetpu.py`. The four conditions, as
measured:

1. **Licence.** The Google AIY Birds V1 full-integer quant from
   `google-coral/test_data` (commit `104342d2`), Apache-2.0 — the same model
   and licence record as the ONNX survivor, plus a `modifications` line. It is
   compiled, not re-quantised: a CamStack calibration would be new weights.
2. **Contract parity.** Normalisation is in the graph (input uint8, scale
   1/128, zero point 128 — the pool feeds raw pixels), the output is a uint8
   softmax dequantised by `edgetpu_dequant`. On 224 crops (103 bird boxes cut
   by the CPU SSD from 90 photos, the same boxes at 48 px, 18 whole photos with
   no box) against the ONNX survivor: top-1 identical on 204 (91.1 %); the
   EMITTED outcome under the step gate (0.6, `background` rejected) identical
   on 216 (96.4 %); no crop where the two emit different species; all 8
   differences are the same species straddling 0.6; every ONNX emission at
   p ≥ 0.8 (32) emitted identically. Run on CPU LiteRT over the graph the
   Edge TPU file is compiled from — the Coral itself is unverified until the
   first deploy. Fixture: `postprocessors/test_bird_edgetpu.py`.
3. **Cost on the shared context.** All 65 operations map to the Edge TPU, one
   subgraph. Alone: 3.75 MiB of parameter cache, 0 streamed (the cache holds
   6.93 MiB in all, not 8). The root SSD alone takes 6.39 MiB, so the two never
   fit together: separately compiled (each compile writes its own random cache
   token) every alternation re-loads the cache; co-compiled (SSD first) the
   bird keeps 0.54 MiB on chip and streams 3.18 MiB per invoke. The step is
   once-per-track (`cadence: once`, `maxPerTrack: 3`), not per-frame — the
   reason it is admitted at all.
4. **Placement.** With the build, a Coral-elected camera runs the step ON the
   Coral (`resolveStepDevice` → `no-jump`, pinned by
   `model-catalogs-classifiers.spec.ts`). Each node with an enabled Coral sets
   `steps['bird-classifier'].jumpDeviceKey` (e.g. `openvino:gpu` on the hub)
   BEFORE the addon carrying this catalog is deployed, unless the operator
   decides to measure it on the Coral. The Coral itself stays opt-in (D39).

The compiler is version 14 (Google's bundle in `google-coral/edgetpu`): the
apt repository that carried 15/16 answers 403 since Coral support ended.

## Addendum, 2026-10-06 — `yunet-2023mar` and `yolox-tiny-plate` are admitted, and placed by set (D724)

Both survivors gain `formats.tflite`, same id:
`faceDetection/yunet/tflite/camstack-yunet-2023mar_edgetpu.tflite`
(`scripts/build-yunet-edgetpu.py`) and
`plateDetection/yolox-tiny-plate/tflite/camstack-yolox-tiny-plate_edgetpu.tflite`
(`scripts/build-yolox-plate-edgetpu.py`). Each folder also carries the CPU int8
graph the Edge TPU file is compiled from (`*_int8.tflite`): the calibration
frames are not kept, so recompiles and co-compiled sets start from that file.
The shared compile/report helper is `scripts/edgetpu_toolchain.py`.

1. **Licence.** YuNet: MIT weights, the WIDER FACE caveat it already carries.
   YOLOX: Apache-2.0, data terms UNKNOWN as D719 already records; the open-lpr
   NOTICE travels in every folder holding its weights. Both licence records
   gain a `modifications` line.
2. **Contract parity**, against each survivor's ONNX on REAL hub crops (fetched
   read-only, deleted after the run), under the step's own gate, run on CPU
   LiteRT over the graph the Edge TPU file is compiled from, dequantised
   exactly as the edgetpu closure does:
   - YuNet (gate 0.85), 243 padded person crops (+122 calibrating): 110 of the
     reference's 115 faces, 111 emitted; the emitted face set identical on
     237/243 crops (97.5 %); every one of the 6 one-sided faces straddles the
     gate (other side 0.827–0.865); box IoU 0.965; landmarks 1.1 % of the face
     diagonal on average (p95 2.8 %). The bake (`Mul(255)` + `Gather`) is
     folded into the first Conv (max |diff| 4e-6): the int8 input is uint8 at
     scale 1/255, so the raw pixels the edgetpu preprocess feeds are the
     RGB [0,1] tensor and nothing is applied twice. 640 only: at 480 recall is
     0.82 of the reference, at 320 0.50 — the fp32 graph at 320 loses the same
     faces, so it is resolution, not quantisation.
   - YOLOX (gate 0.5), 172 vehicle crops (+15 %, native keyframes, camera 102;
     86 calibrating): 109/109 of the reference's plates found (IoU mean 0.959,
     min 0.906), 2 extra at 0.60 and 0.51; end to end with `cct-s-v2-global`
     at margin 0.05, reads equal to the hub's reading 80 vs the reference's 83
     (96.4 %), same text on 163/172 crops. Bar: >= 95 % of the reference's
     detections and of its reads. D719's "Focus does not compile" did not
     hold once the Focus stem was rewritten as the equivalent 6x6/s2 Conv
     (fp32 max |score| diff 7e-7); the graph is cut before the grid decode so
     coordinates and probabilities never share an int8 scale, and `yolo.py`
     decodes the named raw head (`yolox_head_to_v8`). 640 compiled whole, so
     416 and 320 were not needed.
   - Runtime: the edgetpu closure keys a name-matching postprocessor's outputs
     by tensor name (`edgetpu_output_keys`: `yunet`, `yolo`; SSD stays
     positional), dequantises vectorised, and takes `inputSize` from the file.
     Fixtures: `postprocessors/test_yunet_edgetpu.py`,
     `postprocessors/test_yolox_plate_edgetpu.py`.
3. **Cost on the shared context** (`edgetpu_compiler` 14.1, `-s`):
   - YuNet: 81/81 ops on the TPU, 0.11 MiB of parameters — but at 640 its
     activations leave the cache 3.34 MiB in all. Co-compiled after the root
     SSD, the ROOT keeps 3.34 of 6.39 MiB and streams 2.93 MiB on every frame;
     compiled separately it swaps against the root at the face step's rate
     (periodic, 1 Hz per person track, unbounded per track).
   - YOLOX: 274/274 ops on the TPU, 5.55 MiB alone. Co-compiled after the
     root SSD, the root keeps all 6.39 MiB and the plate streams 5.41 MiB per
     invoke (periodic 2 s, <= 8 per track).
   - Streaming cost is ESTIMATED, not measured (no Coral on the build host;
     CPU LiteRT cannot show USB transfer): ~3–4 ms per MiB on USB 3,
     ~30–35 ms per MiB on USB 2, per invoke of the streaming model.
4. **Placement** — see D724 for the set mechanism. With these builds a
   Coral-elected camera runs both steps ON its Coral unless the node sets
   `jumpDeviceKey`. Per node with a Coral, before the addon carrying this
   catalog is deployed:
   - **one Coral** (`edgetpu:usb`): set `steps['face-detection'].jumpDeviceKey`
     to the node's GPU/NPU (e.g. `openvino:gpu` on the hub) — root + face has
     no acceptable set. Plate (and bird) may stay: the pool loads
     `root-plate-bird`, where the root keeps its whole cache. Or set their
     `jumpDeviceKey` too to keep the Coral root-only.
   - **two Corals**: the root Coral (`edgetpu:usb`) sets
     `steps['face-detection' | 'plate-detection' | 'bird-classifier'].jumpDeviceKey`
     = `edgetpu:usb:1`; the second Coral (enabled, not elected for sessions)
     then loads `face-plate-bird` (YuNet fully cached; plate 3.23 on /
     2.27 MiB streamed; bird 4.54 MiB streamed) or `plate-bird` without faces.
   The Coral was opt-in then (D39, superseded by D912). Untested on hardware.
