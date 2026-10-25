<!-- Hand-written 2026-09-26 (plan in the planning repo: superpowers/plans/2026-09-26-model-license-compliance.md, Task 2) in camstack/server hf/camstack-models/. Edit it there, not on the Hub. -->

# animalClassification/bird-classifier: AIY Vision Birds V1 (MobileNetV2), bird classifier

| | |
| --- | --- |
| Catalog id | `bird-classifier` (964 species plus background) |
| Upstream | Google AIY Vision `birds_V1`, published in https://github.com/google-coral/test_data |
| Obtained from | the TensorFlow model `aiy/vision/classifier/birds_V1` (per the ONNX metadata) |
| Code licence | Apache-2.0 |
| **Weights licence** | Apache-2.0 ([`LICENSES/Apache-2.0.txt`](../../LICENSES/Apache-2.0.txt)) |
| Training data | not stated upstream |
| CamStack modifications | converted from TensorFlow with tf2onnx; OpenVINO IR and CoreML derived from the ONNX; the Edge TPU build (`tflite/`) is the Google full-integer quantised TFLite of the same model, compiled with `edgetpu_compiler` 14 |
| Commercial use | permitted by Apache-2.0 |

## Formats

| Format | File | Notes |
| --- | --- | --- |
| ONNX | `onnx/bird-classifier.onnx` (+ `bird-classifier-labels.json`) | fp32, NHWC, input `x/255` |
| OpenVINO IR | `openvino/bird-classifier.{xml,bin}` | from the ONNX |
| CoreML | `coreml/bird-classifier.mlpackage` | from the ONNX |
| Coral Edge TPU | `tflite/bird-classifier_edgetpu.tflite` | full-integer uint8; input raw 0..255 RGB (scale 1/128, zero point 128 in the graph); output `[1,965]` uint8 softmax, scale 1/256 — dequantise, do not re-softmax. All 65 operations on the Edge TPU, 3.75 MiB of parameter cache |

The Edge TPU file is built from `mobilenet_v2_1.0_224_inat_bird_quant.tflite`
(google-coral/test_data commit `104342d2`, sha256 `350fcd8c…04f9`) by
`scripts/build-bird-classifier-edgetpu.py` in the CamStack repository. Every
compile writes a fresh random parameter-cache token, so a rebuild differs from
this file in those 16 bytes only. Labels: the ONNX folder's labels file (same
965 entries, same order).

CamStack redistributes the files in this folder; every change from the upstream is stated above. Converting a model does not change its licence. The collection statement is [`LICENSE`](../../LICENSE); every model's attribution is in [`THIRD_PARTY_MODELS.md`](../../THIRD_PARTY_MODELS.md).
