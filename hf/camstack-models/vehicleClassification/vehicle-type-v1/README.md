<!-- Hand-written 2026-09-26 (plan in the planning repo: superpowers/plans/2026-09-26-model-license-compliance.md, Task 2) in camstack/server hf/camstack-models/. Edit it there, not on the Hub. -->

# vehicleClassification/vehicle-type-v1: MobileNetV3-Large vehicle-type classifier

| | |
| --- | --- |
| Catalog id | `vehicle-type-v1` (Ambulance, Bicycle, Bus, Car, Motorcycle, Taxi, Truck, Van) |
| Upstream | torchvision MobileNetV3-Large: https://github.com/pytorch/vision |
| Obtained from | fine-tuned by CamStack |
| Code licence | BSD-3-Clause ([`LICENSES/BSD-3-Clause.txt`](../../LICENSES/BSD-3-Clause.txt)) |
| **Weights licence** | **CC BY-NC 4.0**, from the training data ([`LICENSES/CC-BY-NC-4.0.txt`](../../LICENSES/CC-BY-NC-4.0.txt)). Whether NC binds trained weights is contested; CamStack takes the conservative reading |
| Training data | Vehicle classification dataset by DrBimmer, https://huggingface.co/datasets/DrBimmer/vehicle-classification, licensed under CC BY-NC 4.0 |
| CamStack modifications | fine-tuned (8 classes); exported to ONNX, OpenVINO IR and CoreML |
| Commercial use | **not permitted** (conservative reading) |

CamStack redistributes the files in this folder; every change from the upstream is stated above. Converting a model does not change its licence. The collection statement is [`LICENSE`](../../LICENSE); every model's attribution is in [`THIRD_PARTY_MODELS.md`](../../THIRD_PARTY_MODELS.md).

Attribution: trained on the Vehicle classification dataset by DrBimmer (https://huggingface.co/datasets/DrBimmer/vehicle-classification), CC BY-NC 4.0.
