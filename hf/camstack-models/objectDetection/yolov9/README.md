<!-- Hand-written 2026-09-26 (plan in the planning repo: superpowers/plans/2026-09-26-model-license-compliance.md, Task 2) in camstack/server hf/camstack-models/. Edit it there, not on the Hub. -->

# objectDetection/yolov9: YOLOv9 (Ultralytics weights), object detection

| | |
| --- | --- |
| Catalog id | `yolov9t-320`, `yolov9t-640`, `yolov9s-*`, `yolov9m-*`, `yolov9c-*`, each with an `-int8` twin |
| Upstream | Ultralytics YOLOv9 implementation, COCO-pretrained: https://github.com/ultralytics/ultralytics. Architecture: Chien-Yao Wang, I-Hau Yeh, Hong-Yuan Mark Liao, https://github.com/WongKinYiu/yolov9 (GPL-3.0) |
| Obtained from | upstream checkpoints `yolov9{t,s,m,c}.pt`, https://github.com/ultralytics/assets/releases |
| Code licence | AGPL-3.0 (Ultralytics); original YOLOv9 repository GPL-3.0 ([`LICENSES/GPL-3.0.txt`](../../LICENSES/GPL-3.0.txt)) |
| **Weights licence** | **AGPL-3.0** ([`LICENSES/AGPL-3.0.txt`](../../LICENSES/AGPL-3.0.txt)) |
| Training data | COCO 2017 (annotations CC BY 4.0) |
| CamStack modifications | exported with Ultralytics to ONNX, OpenVINO IR FP16 and CoreML at 320 and 640; `-int8` post-training quantised with OpenVINO NNCF. These are Ultralytics' weights re-exported, not trained by CamStack |
| Corresponding source | [Source offer for the AGPL-3.0 weights](../../THIRD_PARTY_MODELS.md#source-offer-for-the-agpl-30-weights) |
| Commercial use | AGPL-3.0 obligations apply |

CamStack redistributes the files in this folder; every change from the upstream is stated above. Converting a model does not change its licence. The collection statement is [`LICENSE`](../../LICENSE); every model's attribution is in [`THIRD_PARTY_MODELS.md`](../../THIRD_PARTY_MODELS.md).
