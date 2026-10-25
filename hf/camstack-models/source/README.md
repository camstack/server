<!-- Tracked in the CamStack repository as hf/camstack-models/source/README.md; edit it there, not on the Hub. The scripts beside it are copied by hf/camstack-models/upload.sh from scripts/ and packages/addon-model-studio/python/. -->

# Source: how the CamStack YOLO builds are made

This folder is the **Corresponding Source** under the GNU AGPL-3.0 for the
Ultralytics-derived weights in this mirror (`objectDetection/yolo26`,
`objectDetection/yolov9`, `segmentation/yolo26-seg`).
The full source offer is in
[`THIRD_PARTY_MODELS.md`](../THIRD_PARTY_MODELS.md#source-offer-for-the-agpl-30-weights).

| File | What it is |
| --- | --- |
| `build-camstack-models.py` | Rebuilds every file in the three folders above. One recipe per hosted file stem: upstream checkpoint, input size, the Ultralytics `export()` arguments, the OpenVINO precisions and the INT8 calibration count. Each value is what the hosted file records about itself in its metadata. |
| `convert_lib.py` | The converter `build-camstack-models.py` calls for OpenVINO: ONNX to IR (`ov.convert_model`, FP32 or FP16-compressed), NNCF INT8 post-training quantisation, and validation of every IR. It is the same file CamStack's Model Studio runs. |
| `requirements.txt` | Python dependencies of `convert_lib.py`, with per-platform markers. |
| `export-models.py` | An older bulk exporter for YOLOv8 / YOLOv9 / YOLO11 ids. No file in this mirror needs it. |

## Rebuilding

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt ultralytics openvino nncf
python build-camstack-models.py --list            # the recipes: one per hosted file stem
python build-camstack-models.py --check-hosted    # every hosted file is a recipe output?

python build-camstack-models.py --variant camstack-yolo26n-320   # one hosted model, every format
python build-camstack-models.py --family yolov9                  # one mirror folder
python build-camstack-models.py --all                            # the whole set
python build-camstack-models.py --all --formats onnx,openvino    # some formats only
```

Results go to `./exported-models/<mirror path>`, for example
`exported-models/objectDetection/yolo26/openvino/camstack-yolo26n-320-int8.xml`.
Each build step runs in its own Python process: on macOS, CoreML, OpenVINO and
TensorFlow crash one another when they share one. CoreML needs macOS.

What the recipes encode (the hosted files record each of these):

| Folder | Files | ONNX | CoreML | OpenVINO IR |
| --- | --- | --- | --- | --- |
| `objectDetection/yolo26` | `camstack-yolo26{n,s,m,l,x}` @640 | static, opset 17 | static, batch 1, FP16 | FP16 as `<stem>.xml` and `<stem>-fp16.xml`; INT8 `<stem>-int8.xml` (128 images) |
| `objectDetection/yolo26` | `camstack-yolo26{n,s,m,l}-{320,256}` | dynamic axes, opset 17 | static, batch 1, FP16 | FP32 `<stem>.xml`; INT8 `<stem>-int8.xml` (128 images) |
| `objectDetection/yolov9` | `camstack-yolov9{t,s,m,c}-{320,640}` | static, opset 13 | static, batch 1, FP16 | FP16 `<stem>-fp16.xml`; INT8 `<stem>-int8.xml` (300 images) |
| `segmentation/yolo26-seg` | `camstack-yolo26{n,s,m}-seg` @640 | static, opset 17 | static, batch 1, FP16 | FP16 `<stem>.xml` |

Recorded tool versions (Ultralytics / PyTorch / coremltools / OpenVINO):
YOLO26 @640 and YOLO26-seg 8.4.24 / 2.10.0 / 9.0 / 2026.2.1; YOLO26 @320 and
@256 8.4.92 / 2.13.0 for ONNX, 2.5.1 for CoreML / 8.3.0 / 2026.2.1; YOLOv9
8.4.98 / 2.13.0 / 9.0 / 2026.2.1. The script warns when the installed Ultralytics differs.
With these versions a rebuild gives the hosted weights. Other versions give the
same weights in a possibly different graph. The @320 and @256 CoreML exports
use coremltools 8.3 with PyTorch 2.5.1, the macOS pins in `requirements.txt`.

The @320 and @256 CoreML packages were batch-flexible (1..16) until
2026-10-07. That package aborts any process that loads it on macOS 26.2, on
every compute unit, because Core ML's `gather_nd` shape pass fails on a
flexible batch. They are now exported with a static batch of 1 and were
replaced in place, under the same names. The script refuses a batch-flexible
CoreML recipe for a YOLO26 checkpoint.

Every CoreML package computes in FP16, the only precision the Apple Neural
Engine runs. An FP32 package runs on the GPU or the CPU instead, 2–4× slower.
The YOLOv9 packages were FP32 until 2026-10-07: Ultralytics 8.4.98 pins FP32
unless `half=True` is passed. They were re-exported FP16 and replaced in place,
under the same names. The YOLO26 @640 and YOLO26-seg packages record
`half: False` but are FP16, because Ultralytics 8.4.24 left Core ML's FP16
default in place; their recipes now pass `half=True` so a current Ultralytics
gives the same precision. The script refuses an FP32 CoreML recipe.

### INT8 calibration

The INT8 IRs are NNCF post-training quantisation of the ONNX
(`convert_lib.quantize_openvino_int8`), calibrated on COCO images. The
documented calibration set is COCO val2017:

```bash
curl -LO http://images.cocodataset.org/zips/val2017.zip && unzip -q val2017.zip
python build-camstack-models.py --family yolo26 --calib-dir ./val2017
```

The recipe takes the first N images in file-name order: 128 for YOLO26, 300
for YOLOv9, as recorded in each IR's `rt_info`. Each image is letterboxed to
the model's input size with grey (114) padding and scaled to [0, 1], the way
CamStack feeds the model at runtime. `--calib-samples` overrides N. An IR does
not record WHICH images calibrated it, so a different set gives an equivalent
INT8 model, not a bit-identical one. Without calibration images the INT8 files
are skipped and the run says so.

## Licences

- **These scripts** (`build-camstack-models.py`, `convert_lib.py`,
  `export-models.py`, `requirements.txt`) are CamStack's own code and are
  offered under the **MIT** licence.
- **The weights they produce keep their upstream licence.** The Ultralytics
  checkpoints are AGPL-3.0 ([`LICENSES/AGPL-3.0.txt`](../LICENSES/AGPL-3.0.txt)),
  and so is every file derived from them in this mirror. Nothing here is
  relicensed; see [`LICENSE`](../LICENSE) and each folder's `README.md`.
