---
license: other
license_name: camstack-models-collection
license_link: LICENSE
tags:
  - onnx
  - openvino
  - coreml
  - object-detection
  - image-classification
  - feature-extraction
library_name: onnx
---

<!-- Tracked in camstack/server as hf/camstack-models/README.md; edit it there, not on the Hub. The table between the GENERATED markers is written by scripts/gen-model-licenses.ts from the catalog licence records (D661) — run `npm run models:notices`; everything else is hand-written. -->

# CamStack model mirror

This repository is a **mirror of third-party models** converted by
[CamStack](https://camstack-docs.zentik.app) into the formats its inference
engines run (ONNX, OpenVINO IR, CoreML). **Nothing here is relicensed.**
Each folder stays under the licence of the model it was made from, stated in the
folder's `README.md` and in the table below, with the full text in
[`LICENSES/`](LICENSES). The repository as a whole has no single licence; see
[`LICENSE`](LICENSE).

Every model file here is a *modified* version of its upstream: at minimum
converted to another format; where the folder card says so, re-exported at a
smaller input size, quantised (OpenVINO NNCF INT8), fine-tuned, or with a graph
edit.

[`THIRD_PARTY_MODELS.md`](THIRD_PARTY_MODELS.md) is the notice CamStack ships
with its software. It covers every model CamStack can download, including those
fetched from other repositories, with the attributions each licence requires.

## AGPL-3.0 models (Ultralytics)

`objectDetection/yolo26`, `objectDetection/yolov9` and `segmentation/yolo26-seg`
hold Ultralytics weights under **AGPL-3.0** ([`LICENSES/AGPL-3.0.txt`](LICENSES/AGPL-3.0.txt)).
Their Corresponding Source is set out in
[Source offer for the AGPL-3.0 weights](THIRD_PARTY_MODELS.md#source-offer-for-the-agpl-30-weights).

## Non-commercial models

This **may not be used commercially**. See the folder's card.

- `vehicleClassification/vehicle-type-v1`: trained on a CC BY-NC 4.0 dataset
  ([`LICENSES/CC-BY-NC-4.0.txt`](LICENSES/CC-BY-NC-4.0.txt)).

## Required attributions

- **Ultralytics YOLO26, YOLOv9**: © Ultralytics, AGPL-3.0. YOLOv9
  architecture: Chien-Yao Wang, I-Hau Yeh, Hong-Yuan Mark Liao, GPL-3.0.
- **open-lpr models** (plate detector): Copyright the open-lpr contributors,
  Apache-2.0; YOLOX architecture and COCO pretraining by Megvii, Apache-2.0.
  The upstream `NOTICE` is in the folder and in
  [`LICENSES/NOTICE-open-lpr.txt`](LICENSES/NOTICE-open-lpr.txt).
- **fast-plate-ocr**: Copyright (c) 2024 ankandrew, MIT.
- **Open Images V7** (animal-classifier training data): annotations © Google
  LLC, CC BY 4.0.
- **Vehicle classification dataset** (vehicle-type-v1 training data): DrBimmer,
  https://huggingface.co/datasets/DrBimmer/vehicle-classification, CC BY-NC 4.0.
- **AudioSet** (YAMNet labels): © Google LLC, CC BY 4.0.
- **COCO** (YOLO pretraining): annotations CC BY 4.0.
- Apache-2.0 upstreams: RF-DETR (Roboflow), AuraFace v1 (fal.ai), U²-Net
  (Xuebin Qin et al.), YAMNet and AIY Vision Birds V1 (Google LLC),
  EfficientNet-Lite0 via timm (Ross Wightman).

## Models

"Unknown" means no licence could be traced; it does not mean free to use.
*default* marks the model a CamStack step runs when nobody chose one; *hidden*
marks an entry kept resolvable for a saved selection but no longer offered.

<!-- BEGIN GENERATED MODEL TABLE -->
| Folder | Catalog ids | Upstream | Weights licence | Licence text | CamStack modifications |
| --- | --- | --- | --- | --- | --- |
| `segmentation/yolo26-seg` | `yolo26n-seg`, `yolo26s-seg`, `yolo26m-seg` | Ultralytics | AGPL-3.0 | [`AGPL-3.0.txt`](LICENSES/AGPL-3.0.txt) | exported to ONNX, OpenVINO IR and CoreML |
| `objectDetection/yolo26` | `yolo26n` (default), `yolo26s`, `yolo26m`, `yolo26l`, `yolo26x` (hidden), `yolo26n-fp16` (hidden), `yolo26n-int8`, `yolo26s-fp16` (hidden), `yolo26s-int8`, `yolo26m-fp16` (hidden), `yolo26m-int8`, `yolo26l-fp16` (hidden), `yolo26l-int8`, `yolo26n-320`, `yolo26n-320-int8`, `yolo26n-256`, `yolo26n-256-int8`, `yolo26s-320`, `yolo26s-320-int8`, `yolo26s-256`, `yolo26s-256-int8`, `yolo26m-320`, `yolo26m-320-int8`, `yolo26m-256`, `yolo26m-256-int8`, `yolo26l-320`, `yolo26l-320-int8`, `yolo26l-256`, `yolo26l-256-int8`, `yolo26x-fp16` (hidden), `yolo26x-int8` (hidden) | Ultralytics | AGPL-3.0 | [`AGPL-3.0.txt`](LICENSES/AGPL-3.0.txt) | exported to ONNX, OpenVINO IR and CoreML (scripts/build-camstack-models.py); OpenVINO FP16 export; exported to OpenVINO IR, then OpenVINO NNCF INT8 post-training quantisation; re-exported at 320×320 to ONNX, OpenVINO IR and CoreML; re-exported at 320×320 to OpenVINO IR; OpenVINO NNCF INT8 post-training quantisation; re-exported at 256×256 to ONNX, OpenVINO IR and CoreML; re-exported at 256×256 to OpenVINO IR; OpenVINO NNCF INT8 post-training quantisation |
| `objectDetection/yolov9` | `yolov9s-320-edgetpu` (default), `yolov9s-512-edgetpu`, `yolov9t-320`, `yolov9t-320-int8`, `yolov9t-640`, `yolov9t-640-int8`, `yolov9s-320`, `yolov9s-320-int8`, `yolov9s-640`, `yolov9s-640-int8`, `yolov9m-320`, `yolov9m-320-int8`, `yolov9m-640`, `yolov9m-640-int8`, `yolov9c-320`, `yolov9c-320-int8`, `yolov9c-640`, `yolov9c-640-int8` | YOLOv9-s EdgeTPU (Dan Brown); Ultralytics | GPL-3.0, AGPL-3.0 | [`GPL-3.0.txt`](LICENSES/GPL-3.0.txt), [`AGPL-3.0.txt`](LICENSES/AGPL-3.0.txt) | none: the publisher release files are mirrored byte-identical; exported at 320×320 to ONNX, OpenVINO IR FP16 and CoreML; exported at 320×320 to OpenVINO IR; OpenVINO NNCF INT8 post-training quantisation; exported at 640×640 to ONNX, OpenVINO IR FP16 and CoreML; exported at 640×640 to OpenVINO IR; OpenVINO NNCF INT8 post-training quantisation |
| `packageDetection/rfdetr-package` | `rfdetr-package` (default) | Roboflow RF-DETR | Apache-2.0 | [`Apache-2.0.txt`](LICENSES/Apache-2.0.txt) | RF-DETR-M fine-tuned to 2 classes at 576; exported to ONNX, OpenVINO IR and CoreML; training checkpoint .pth also published |
| `faceDetection/yunet` | `yunet-2023mar` (default) | OpenCV Zoo YuNet | MIT | [`MIT-yunet-reference.txt`](LICENSES/MIT-yunet-reference.txt), [`BSD-3-Clause.txt`](LICENSES/BSD-3-Clause.txt) | input contract baked into the graph (the pool RGB /255 becomes the upstream BGR 0..255: Mul(255) plus a channel Gather); internal tensor names cleared in the OpenVINO IR; ONNX fp32, OpenVINO IR fp32, CoreML fp16 (scripts/build-yunet-model.py); Edge TPU build: the bake folded into the first Conv, full-integer int8 post-training quantisation calibrated on CamStack person crops, compiled with edgetpu_compiler 14 (scripts/build-yunet-edgetpu.py) |
| `faceRecognition/auraface` | `auraface-r100` (default) | fal.ai AuraFace v1 (glintr100.onnx only) | Apache-2.0 | [`Apache-2.0.txt`](LICENSES/Apache-2.0.txt) | input scaling y = 2x - 1 baked ahead of the first Conv (scripts/build-auraface-model.py); converted to OpenVINO IR and CoreML FP16 |
| `plateDetection/yolox-tiny-plate` | `yolox-tiny-plate` (default) | open-lpr models (faisalthaheem/open-lpr-models), YOLOX-tiny | Apache-2.0 | [`Apache-2.0.txt`](LICENSES/Apache-2.0.txt) | input contract baked into the graph (static 1x3x640x640 RGB /255 becomes the upstream BGR 0..255: Mul(255) plus a channel Gather) and the output reshaped to the YOLOv8 layout (cx, cy, w, h, obj*cls); ONNX fp32, OpenVINO IR fp16, CoreML fp16 (scripts/build-yolox-plate-model.py); Edge TPU build: the Focus stem rewritten as the equivalent 6x6 stride-2 Conv with the input bake folded into it, the graph cut before the grid decode (raw per-stride head), full-integer int8 post-training quantisation calibrated on CamStack vehicle crops, compiled with edgetpu_compiler 14 (scripts/build-yolox-plate-edgetpu.py) |
| `plateRecognition/cct-s-v2-global` | `cct-s-v2-global` (default) | ankandrew/fast-plate-ocr | MIT | [`MIT-fast-plate-ocr.txt`](LICENSES/MIT-fast-plate-ocr.txt) | input head removed (recorded in the ONNX doc_string); converted to OpenVINO IR and CoreML |
| `animalClassification/animal-classifier` | `animal-classifier` (default) | timm EfficientNet-Lite0, fine-tuned by CamStack | Apache-2.0 | [`Apache-2.0.txt`](LICENSES/Apache-2.0.txt) | fine-tuned by CamStack on the Open Images V7 animal subset (8 classes); exported to ONNX, OpenVINO IR and CoreML |
| `animalClassification/bird-classifier` | `bird-classifier` (default) | Google AIY Vision birds_V1 | Apache-2.0 | [`Apache-2.0.txt`](LICENSES/Apache-2.0.txt) | converted from TensorFlow with tf2onnx; OpenVINO IR and CoreML derived from it; the Edge TPU build is the Google full-integer quantised TFLite of the same model, compiled with edgetpu_compiler 14 (scripts/build-bird-classifier-edgetpu.py) |
| `vehicleClassification/vehicle-type-v1` | `vehicle-type-v1` (default) | torchvision MobileNetV3-Large, fine-tuned by CamStack | **CC-BY-NC-4.0** | [`CC-BY-NC-4.0.txt`](LICENSES/CC-BY-NC-4.0.txt), [`BSD-3-Clause.txt`](LICENSES/BSD-3-Clause.txt) | fine-tuned by CamStack (8 classes); exported to ONNX, OpenVINO IR and CoreML |
| `clip/siglip2` | `siglip2-b16-224` (default), `siglip2-b16-224-text` | Google SigLIP 2 (google/siglip2-base-patch16-224) | Apache-2.0 | [`Apache-2.0.txt`](LICENSES/Apache-2.0.txt) | input scaling y = 2x - 1 baked ahead of the patch embedding; converted to OpenVINO IR and CoreML FP16, an FP32 ONNX hosted as the verification reference (scripts/build-siglip2-model.py); input sliced to the model's 64 positions in the graph; ONNX weights FP16, OpenVINO IR and CoreML FP16; a Lowercase normalizer prepended to the Gemma tokenizer (scripts/build-siglip2-model.py) |
| `segmentationRefiner/u2netp` | `u2netp` (default) | xuebinqin/U-2-Net | Apache-2.0 | [`Apache-2.0.txt`](LICENSES/Apache-2.0.txt) | converted to ONNX, OpenVINO IR and CoreML |
| `audioClassification/yamnet` | `yamnet-onnx` (default) | tensorflow/models research/audioset/yamnet | Apache-2.0 | [`Apache-2.0.txt`](LICENSES/Apache-2.0.txt) | converted from TensorFlow with tf2onnx; OpenVINO IR derived from it |
<!-- END GENERATED MODEL TABLE -->

This mirror holds only the models CamStack offers. Models it no longer offers
(SCRFD, ArcFace, Inception-ResNet, VGG-English, MobileCLIP S1/S2,
YOLOv8n-package, SSDLite MobileDet, the YOLOv8n plate detector, and earlier a third-party face, PaddleOCR,
animals-10, NABirds and EfficientNet folders) were removed, and the repository
history was squashed on 2026-10-06.
