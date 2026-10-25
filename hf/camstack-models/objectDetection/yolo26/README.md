<!-- Hand-written 2026-09-26 (plan in the planning repo: superpowers/plans/2026-09-26-model-license-compliance.md, Task 2) in camstack/server hf/camstack-models/. Edit it there, not on the Hub. -->

# objectDetection/yolo26: YOLO26 (Ultralytics), object detection

| | |
| --- | --- |
| Catalog id | `yolo26n`, `yolo26s`, `yolo26m`, `yolo26l`, `yolo26x`, and every `-fp16`, `-int8`, `-320`, `-256`, `-320-int8`, `-256-int8` variant |
| Upstream | Ultralytics YOLO26, COCO-pretrained: https://github.com/ultralytics/ultralytics |
| Obtained from | upstream checkpoints `yolo26{n,s,m,l,x}.pt`, https://github.com/ultralytics/assets/releases |
| Code licence | AGPL-3.0 |
| **Weights licence** | **AGPL-3.0** ([`LICENSES/AGPL-3.0.txt`](../../LICENSES/AGPL-3.0.txt)) |
| Training data | COCO 2017 (annotations CC BY 4.0, [`LICENSES/CC-BY-4.0.txt`](../../LICENSES/CC-BY-4.0.txt); images under their Flickr owners' terms) |
| CamStack modifications | exported with Ultralytics to ONNX (dynamic batch), OpenVINO IR (FP32 and FP16) and CoreML FP16; `-320` and `-256` re-exported at that input size; `-int8` post-training quantised with OpenVINO NNCF |
| Corresponding source | [Source offer for the AGPL-3.0 weights](../../THIRD_PARTY_MODELS.md#source-offer-for-the-agpl-30-weights) |
| Commercial use | AGPL-3.0 obligations apply (source, licence text, notices) |

CamStack redistributes the files in this folder; every change from the upstream is stated above. Converting a model does not change its licence. The collection statement is [`LICENSE`](../../LICENSE); every model's attribution is in [`THIRD_PARTY_MODELS.md`](../../THIRD_PARTY_MODELS.md).
