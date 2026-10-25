<!-- Hand-written 2026-09-26 (plan in the planning repo: superpowers/plans/2026-09-26-model-license-compliance.md, Task 2) in camstack/server hf/camstack-models/. Edit it there, not on the Hub. -->

# audioClassification/yamnet: YAMNet, audio classification

| | |
| --- | --- |
| Catalog id | `yamnet-onnx` (521 AudioSet classes) |
| Upstream | tensorflow/models, `research/audioset/yamnet`: https://github.com/tensorflow/models/tree/master/research/audioset/yamnet |
| Obtained from | the YAMNet TensorFlow model; `tf/` holds the TensorFlow SavedModel the conversion was made from |
| Code licence | Apache-2.0 |
| **Weights licence** | Apache-2.0 ([`LICENSES/Apache-2.0.txt`](../../LICENSES/Apache-2.0.txt)) |
| Training data | AudioSet ontology and labels © Google LLC, CC BY 4.0 ([`LICENSES/CC-BY-4.0.txt`](../../LICENSES/CC-BY-4.0.txt)), https://research.google.com/audioset/ |
| CamStack modifications | converted from TensorFlow with tf2onnx; OpenVINO IR derived from the ONNX |
| Commercial use | permitted by Apache-2.0 |

CamStack redistributes the files in this folder; every change from the upstream is stated above. Converting a model does not change its licence. The collection statement is [`LICENSE`](../../LICENSE); every model's attribution is in [`THIRD_PARTY_MODELS.md`](../../THIRD_PARTY_MODELS.md).
