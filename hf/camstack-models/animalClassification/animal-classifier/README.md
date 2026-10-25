<!-- Hand-written 2026-09-26 (plan in the planning repo: superpowers/plans/2026-09-26-model-license-compliance.md, Task 2) in camstack/server hf/camstack-models/. Edit it there, not on the Hub. -->

# animalClassification/animal-classifier: EfficientNet-Lite0 animal classifier

| | |
| --- | --- |
| Catalog id | `animal-classifier` (bird, cat, cow, deer, dog, horse, sheep, squirrel) |
| Upstream | timm EfficientNet-Lite0: https://github.com/huggingface/pytorch-image-models |
| Obtained from | fine-tuned by CamStack (2026-07-19) |
| Code licence | Apache-2.0 |
| **Weights licence** | Apache-2.0 ([`LICENSES/Apache-2.0.txt`](../../LICENSES/Apache-2.0.txt)) |
| Training data | Open Images V7 animal subset. Annotations © Google LLC, licensed under CC BY 4.0 ([`LICENSES/CC-BY-4.0.txt`](../../LICENSES/CC-BY-4.0.txt)); images listed by Google as CC BY 2.0, without warranty. https://storage.googleapis.com/openimages/web/factsfigures_v7.html |
| CamStack modifications | fine-tuned (8 classes); exported to ONNX, OpenVINO IR and CoreML |
| Commercial use | permitted (attribution to Open Images required) |

CamStack redistributes the files in this folder; every change from the upstream is stated above. Converting a model does not change its licence. The collection statement is [`LICENSE`](../../LICENSE); every model's attribution is in [`THIRD_PARTY_MODELS.md`](../../THIRD_PARTY_MODELS.md).
