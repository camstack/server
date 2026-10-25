<!-- Hand-written 2026-09-26 (plan in the planning repo: superpowers/plans/2026-09-26-model-license-compliance.md, Task 2) in camstack/server hf/camstack-models/. Edit it there, not on the Hub. -->

# faceRecognition/auraface: AuraFace v1 (iResNet-100), face recognition

| | |
| --- | --- |
| Catalog id | `auraface-r100` |
| Upstream | fal.ai AuraFace v1: https://huggingface.co/fal/AuraFace-v1 |
| Obtained from | `glintr100.onnx` only, from `fal/AuraFace-v1` |
| Code licence | Apache-2.0 |
| **Weights licence** | Apache-2.0 ([`LICENSES/Apache-2.0.txt`](../../LICENSES/Apache-2.0.txt)) |
| Training data | stated upstream as commercially and publicly available data sources |
| CamStack modifications | graph edit: input scaling `y = 2x - 1` baked ahead of the first Conv (`scripts/build-auraface-model.py` in the CamStack source); converted to OpenVINO IR and CoreML FP16 |
| Commercial use | permitted by Apache-2.0 |

CamStack redistributes the files in this folder; every change from the upstream is stated above. Converting a model does not change its licence. The collection statement is [`LICENSE`](../../LICENSE); every model's attribution is in [`THIRD_PARTY_MODELS.md`](../../THIRD_PARTY_MODELS.md).
