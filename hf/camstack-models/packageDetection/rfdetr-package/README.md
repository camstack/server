<!-- Hand-written 2026-09-26 (plan in the planning repo: superpowers/plans/2026-09-26-model-license-compliance.md, Task 2) in camstack/server hf/camstack-models/. Edit it there, not on the Hub. -->

# packageDetection/rfdetr-package: RF-DETR-M package detector

| | |
| --- | --- |
| Catalog id | `rfdetr-package` |
| Upstream | Roboflow RF-DETR (Medium): https://github.com/roboflow/rf-detr |
| Obtained from | RF-DETR-M base weights (Apache-2.0 per the rf-detr README), custom-configured for package detection (`num_classes=2`, resolution 576; see `config.json`) |
| Code licence | Apache-2.0 |
| **Weights licence** | Apache-2.0 ([`LICENSES/Apache-2.0.txt`](../../LICENSES/Apache-2.0.txt)) |
| Training data | fine-tuning set not recorded (**unverified**) |
| CamStack modifications | fine-tuned to 2 classes at 576; exported to ONNX, OpenVINO IR and CoreML. `camstack-rfdetr-package.pth` is the training checkpoint the exports were made from |
| Commercial use | permitted by Apache-2.0; fine-tuning data terms unverified |

CamStack redistributes the files in this folder; every change from the upstream is stated above. Converting a model does not change its licence. The collection statement is [`LICENSE`](../../LICENSE); every model's attribution is in [`THIRD_PARTY_MODELS.md`](../../THIRD_PARTY_MODELS.md).

Deployable: ONNX and OpenVINO. Source checkpoint: `.pth`. (This card replaces the one-paragraph README previously in this folder; its content is kept above.)
