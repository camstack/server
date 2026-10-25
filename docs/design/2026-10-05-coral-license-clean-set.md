---
title: Coral license-clean model set
status: proposed
date: 2026-10-05
revised: 2026-10-06
covers:
  - packages/addon-pipeline/src/detection-pipeline/registry/model-catalogs.ts
  - packages/addon-pipeline/src/pipeline-runner/device-jump.ts
  - packages/addon-pipeline/python/inference_pool.py
---

# Coral (EdgeTPU) — license-clean model set

Rewritten 2026-10-06 to match [D703](../decisions/adr-0703-one-licence-clean-model-survives-per-enrichment-step-and-a-deleted-model-id-is-just-a-custom-model.md)
and [D710](../decisions/adr-0710-a-coral-build-of-a-survivor-is-a-format-of-that-model-admitted-by-what-it-costs-the-shared-edge-tpu-context.md).
The first version proposed promoting SSDLite MobileDet and re-adding the AIY bird
Edge TPU file as its own model — both sibling models D703 deleted. Dropped.

**Rule (D710):** a Coral build is `formats.tflite` on a step's surviving model
(same id), admitted by licence, contract parity, cost on the one shared Edge TPU
context, and a stated placement. Background analysis:
(planning repo: .superpowers/sdd/coral-enrichment-models-analysis.md).

## The set

| Step | Survivor | Coral | Status |
| --- | --- | --- | --- |
| object-detection | `ssd-mobilenet-v2-coco-edgetpu` (Apache-2.0) | is the survivor | Shipped, `defaultModelIdByFormat.tflite`. MobileDet stays a **plus catalog catalog import** (Model Studio), not promoted. |
| bird-classifier | `bird-classifier` (AIY Birds V1, Apache-2.0) | `formats.tflite` = `tflite/bird-classifier_edgetpu.tflite`, compiled by CamStack from the Google int8 quant | **In the catalog** (2026-10-06, D710 addendum). Not live until the pipeline addon is deployed; set the Coral node's `jumpDeviceKey` first. |
| animal-classifier | `animal-classifier` (Lite0, Apache-2.0) | compile CamStack int8 → edgetpu | **Deferred** (low value: once-per-track, the iGPU does it in ms, would swap against the root). |
| vehicle-classifier | `vehicle-type-v1` (CC-BY-NC) | none — MobileNetV3 compiles poorly, and a Coral-only model is forbidden | **Retrain first**: [D711](../decisions/adr-0711-the-vehicle-classifier-survivor-is-trained-by-camstack-on-open-images-and-vehicle-type-v1-is-deleted.md) (proposed), plan [`2026-10-06-vehicle-classifier-licence-clean-retrain.md`](2026-10-06-vehicle-classifier-licence-clean-retrain.md). Coral build after it. |
| face-detection | `yunet-2023mar` (MIT) | YuNet int8 → edgetpu | Spike only, unscheduled (landmark precision is the risk; 0.2 MB would not swap). |
| face-embedding, clip-embedding | AuraFace, SigLIP2 | — | **Not admitted** (vector index; D52, D710). |
| plate-ocr, package-detection | CCT, RF-DETR | — | **Not admitted** (calibrated per-char gate; DETR head). |
| plate-detection | `yolox-tiny-plate` (open-lpr, Apache-2.0) | none — YOLOX's Focus stem fails `edgetpu_compiler` | **No Coral build** ([D719](../decisions/adr-0719-the-plate-detection-survivor-is-open-lpr-yolox-tiny-and-every-other-plate-detector-is-deleted.md)); the step jumps to another device of the node, as `yolov8n-plate` did. |

Do not redistribute as CamStack Coral defaults: Ultralytics YOLO → edgetpu
(AGPL-3.0 weights), plugin catalog YOLO ReLU tflite (GPL lineage, UNKNOWN per-model
terms). Imports stay operator-driven with their licence notices. Note: the
plugin catalog YOLOv9 tflite files emit six split-head tensors that the current
decoder does not understand (analysis §0.3) — verify on hardware before
calling that import working.

## Bird-classifier tflite — spike (2026-10-06)

Artefacts (google-coral/test_data, Apache-2.0):
`mobilenet_v2_1.0_224_inat_bird_quant_edgetpu.tflite` (4.30 MB,
sha256 `5b468dfe…afe`), its CPU sibling `mobilenet_v2_1.0_224_inat_bird_quant.tflite`
(sha256 `350fcd8c…4f9`), `inat_bird_labels.txt`.

**Labels.** 965 lines vs the 965 entries of HF
`animalClassification/bird-classifier/onnx/bird-classifier-labels.json`: same
order, index 964 `background` in both. The txt carries a common name in
parentheses; after stripping it, 963/965 are byte-identical and the other two
differ only because the txt spells `×` as the literal escape `\xd7`
(indices 110, 758). **The existing labels json is reused as is.**

**Signature.** in `[1,224,224,3] u8 (scale 1/128, zp 128)` — raw 0–255 pixels,
what the edgetpu path already feeds; out `[1,965] u8 (scale 1/256, zp 0)` —
softmax in-graph, so it needs dequantisation (`(q−zp)·scale`) and nothing else.

**Agreement vs the ONNX `bird-classifier`.** No Coral on the dev machine and no
real bird crops locally, so: CPU LiteRT on the quantised CPU sibling (same
int8 graph the Edge TPU file was compiled from), ONNX Runtime on the shipped
ONNX, both fed the pipeline's preprocessing (bilinear resize to 224; ONNX
`x/255`, tflite raw u8). Sample: 88 Wikimedia Commons bird photos (featured /
quality categories: passerines, raptors, pigeons, ducks, woodpeckers, corvids,
herons) + 3 animal crops from the repo's reference images.

| Measure | Result |
| --- | --- |
| Top-1 agreement, all 91 | **85/91 = 93.4 %** |
| Top-1 agreement where ONNX top-1 ≥ 0.5 (non-background) | **27/27** |
| Every disagreement's ONNX top-1 probability | ≤ 0.196 (near-ties between low-confidence species) |
| Emitted outcome under the step gate (`defaultConfidence` 0.6, `background` rejected) | **89/91 identical**; each side emits 23 |
| The 2 gate differences | same species both sides, probability straddling 0.6 (0.585↔0.633, 0.627↔0.516) |
| Top-5 overlap (mean) | 4.27 / 5 |
| Max per-class |Δp| (mean / p95) | 0.036 / 0.113 |
| Background as top-1 | 1 both sides |

Verdict: **passes** — wherever the step would emit a species, the tflite build
emits the same species. Not yet measured: the Edge TPU file on a real Coral
(expected equal to the CPU int8 run, unverified) and real camera crops; both
belong to the build's fixture test and its first deploy.

### Shipping the bird build (done 2026-10-06)

1. The dequant landed (`edgetpu_dequant.py`).
2. `formats.tflite` is on `bird-classifier` (same id, labels and licence record
   plus a `modifications` line). The file is NOT Google's prebuilt edgetpu
   file: `scripts/build-bird-classifier-edgetpu.py` compiles the pinned CPU
   quant with `edgetpu_compiler` 14 (the 15/16 apt repository is gone, 403) in
   an amd64 container — Lima + Rosetta on this Mac. 65/65 ops on the TPU,
   3.75 MiB parameter cache; co-compiled after the root SSD (6.39 MiB) it would
   keep 0.54 MiB on chip and stream 3.18 MiB. Parity on 224 crops: emitted
   outcome identical on 96.4 %, never a different species. Figures in the D710
   addendum. HF: `animalClassification/bird-classifier/tflite/bird-classifier_edgetpu.tflite`
   (sha256 `f5b37245…229c`).
3. **Deploy note (still open):** before deploying the pipeline addon that
   carries the catalog, set each Coral node's `steps['bird-classifier'].jumpDeviceKey`
   (the hub: `openvino:gpu`) unless the step is meant to be measured on the
   Coral. Then verify the first Coral classification against the ONNX one.

## Related

- `THIRD_PARTY_MODELS.md` (generated)
- (planning repo: .superpowers/sdd/coral-enrichment-models-analysis.md)
- D650 / D657 (detail-step jump), D661 (licences), D703, D710, D711
