# plus catalog's Coral models on the same suites (2026-10-24)

covers:
  - packages/addon-pipeline/python/inference_pool.py
  - packages/addon-pipeline/python/postprocessors/ssd.py
  - packages/addon-model-studio/src/plus-catalog/plus-catalog-catalog.ts
  - packages/addon-model-studio/src/plus-catalog/plus-catalog-api.ts
applies-to:
  - packages/addon-pipeline/python/inference_pool.py
  - packages/addon-pipeline/python/postprocessors/ssd.py
  - packages/addon-model-studio/src/plus-catalog/plus-catalog-catalog.ts
last-verified: 2026-10-24

Question: is the Coral detector worse than what a plus catalog user runs, and is
that a model gap or a pipeline gap? Measured on the dev hub `.50` (CT200),
which holds the three Corals (`edgetpu:pci`, `edgetpu:pci:1`, `edgetpu:usb`).
Production (`.9`) was read, not changed.

## Method

Suites, both already on disk under `~/camstack-eval`, scored by
scripts/eval/suite/lib/score.mjs (branch `eval-suites`, not merged) (greedy match, same macro, IoU ≥ 0.5):

- `realcam-v1` — 300 frames, labels are **unreviewed prelabels**. The runner's
  second pass (square motion crops) is included in `final`.
- `coco-val2017-v1` — 400 frames, reviewed COCO labels, full frame only.

Each run pinned one model on one device through `benchmark.runPipelineTest`
(scripts/eval/run-device-suite.mjs (branch `eval-suites`, not merged), the `eval-suites` runner). The request
carried `minConfidencePerson/Vehicle/Animal = 0.3` with no model binding, so
the floor applies to that call only and nothing was stored. Production-floor
rows drop boxes under that model's `defaultClassFloors` after the fact. NMS
has already run at 0.3, so a low box can have suppressed a higher one; on
COCO the filtered numbers match the 2026-10-23 production-floor captures
exactly, and on realcam they differ by at most 0.01 recall.

Size buckets are COCO's 32² / 96², measured in the 640 view the full pass
sees. "Invoke" is `fullPredictMs` (invoke plus output copy). "Step" is
`fullStepMs` (preprocess, hop, invoke, postprocess). The three devices ran
at once, so the shared CPU preprocess makes the step figure slightly
pessimistic; the boxes themselves do not depend on it.

The node's debug label on every row is `python+onnx`. That string is the
node's default engine (`runtime+backend`), not the device the call was
pinned to. The pin is what the boxes show: for each model, all three Corals
returned the same boxes (class, score and rectangle). USB invoke is slower
than PCIe on every model, which is the bus, not a CPU fallback.

`.50` already had the three Corals enabled at weight 1 with default model
`yolov9s-320-edgetpu`. That map was not written. Model Studio was absent on
the fresh hub; `@camstack/addon-model-studio@1.1.289` was installed from the
registry so the public catalog import could register, and it was left
installed. No setting on `.9` was changed, and `importPlusCatalogModel` was
not called there, so no plus catalog file was downloaded onto production.

The NPU reference is the 2026-10-23 capture of `yolov9m-640` on `openvino:npu`
through the same runner (realcam second pass included). It was not re-run:
the crop path is the runner's, and `.50`'s CPU would not be a like-for-like
stand-in for the NPU. Its capture floor is the model's own floors (person
0.6, vehicle 0.4, animal 0.55), so its recall at 0.3 is unknown and at least
the number below.

## Which Coral models plus catalog runs

### Free default

plus catalog's stock Coral detector is Google's SSDLite MobileDet, 320×320, 90
COCO classes, full-integer, with the `TFLite_Detection_PostProcess` op.
Model Studio's public catalog lists it as `frigate-mobiledet-edgetpu`
(`packages/addon-model-studio/src/plus-catalog/plus-catalog-catalog.ts`). Registered
on `.50` from that catalog; the pipeline downloaded the public file on first
invoke.

| | |
| --- | --- |
| Source | `https://github.com/google-coral/test_data/raw/release-frogfish/ssdlite_mobiledet_coco_qat_postprocess_edgetpu.tflite` |
| Size | 5.4 MB (catalog) |
| Licence | `CORAL_MOBILEDET_APACHE`: weights and code Apache-2.0, data COCO 2017, hosting the Google Coral `test_data` repository |
| Floors we ship for a stock import | person 0.5, vehicle 0.5, animal 0.5 (`PLUS_CATALOG_STOCK_CLASS_FLOORS`) |
| Published figure | Coral's model card: 32.9% mAP on a subset of COCO17, 9.1 ms on a USB Accelerator. That mAP is not the recall in the tables below. |

### plus catalog on this account, detector `edgetpu`

`plusCatalogPlusListModels` on `.9` (the key stays in Model Studio; it was not
read). 111 models on the account, 14 of them for `edgetpu`, every one
320×320. Other detector labels on the account, not measured and not Coral:
`hailo8l`, `onnx`, `rocm`, `openvino`, `zmq`, `rknn`, `cpu`. A Plus import
would carry floors person/vehicle/animal 0.65 (`PLUS_CATALOG_CLASS_FLOORS`).
The weights are the account's; they are not redistributable and they were
not copied.

Base models (plus catalog's own, not trained on this account's cameras):

| Base | Name | Type | Id | Trained | Verified images |
| --- | --- | --- | --- | --- | --- |
| 2026.1 | mobiledet | ssd | `e39924321228f76edd6b727c0cf2a4be` | 2026-04-15 | 0 |
| 2026.0 | mobiledet | ssd | `c7b38453956cda87076baba4aca213e6` | 2026-01-15 | 0 |
| 2025.3 | mobiledet | ssd | `e08864ec08832bd52c6037984ce72f1c` | 2025-10-15 | 0 |
| 2025.2 | mobiledet | ssd | `e074d6405b3257c98d255cd2efc9d21f` | 2025-06-25 | 68666 |
| 2025.1 | mobiledet | ssd | `c241fae21de50ecf6c0f2a63769dcacd` | 2025-03-29 | 68666 |
| 2026.1 | yolov9s | yolo-generic | `be9c11b486ba0e2b8ea13338d4cc66ee` | 2026-04-15 | 0 |
| 2026.0 | yolov9s | yolo-generic | `35877a6045227082ca72e73d6d34c72a` | 2026-01-15 | 0 |

This account's own mobiledet trains (ssd, base as named):

| Base | Id | Trained | Verified images |
| --- | --- | --- | --- |
| 2025.1 | `42958636d17dd0cd4c05958b1086fce5` | 2025-06-02 | 1932 |
| 2025.1 | `73e1b2b2fcb0f1588530a7008e0252cb` | 2025-06-01 | 1212 |
| 2024.1 | `cac1963020f5c53de9cf5d804c806a09` | 2024-07-21 | 199 |
| 2024.1 | `6fb28301f32ec718783410f76a002b90` | 2024-04-25 | 189 |
| 2024.0 | `79a954dd952c8f65e5dd2b106ff4ad36` | 2024-04-06 | 189 |
| 2024.0 | `be80be479b8e344c60515bc6b9bad199` | 2024-03-04 | 172 |
| 2024.0 | `aabc12e9b543a2e9f37645fa8bbba7ab` | 2024-03-03 | 16 |

### Ours, already in the static catalog

Community YOLOv9-s Edge TPU builds (Dan Brown,
`github.com/dbro/frigate-detector-edgetpu-yolo9`), mirrored byte-identical.
Licence `DBRO_YOLOV9_EDGETPU_GPL`: weights and code GPL-3.0, data COCO,
upstream that repository. Both are ReLU6, full-integer, compiled for the
Edge TPU. Floors: person 0.4, vehicle 0.4, animal 0.3.

| Id | File | Input |
| --- | --- | --- |
| `yolov9s-320-edgetpu` | `yolov9-s-relu6-best_320_int8_edgetpu.tflite` | 320 |
| `yolov9s-512-edgetpu` | `yolov9-s-relu6-tpumax_512_int8_edgetpu.tflite` | 512 |

### Why the 14 plus catalog models have no row

`importPlusCatalogModel` downloads on the hub that holds the key and
registers a `camstack-local://` entry in that hub's model directory. There
is no custom action that returns those bytes. `distributeModel` can push a
`camstack-local://` file only to an agent of the same cluster
(`modelDistributor.distributeModel`); `.50` is its own cluster, not an agent
of `.9`. `beginModelUpload` / `importModelBundle` are inbound (the caller
must already have the file). No HTTP route serves a model file back out.

Moving the file with `scp` or `docker cp`, or sending the key to `.50`,
would be a workaround around that missing path. It was not done. The free
model did not need it: its URL is public, and `importPlusCatalogCatalogModel`
on `.50` only registers it.

## Results

Recall / precision. Per-class cells are recall/precision. Small is recall.
Median TP is the median score of matched boxes. Devices agreed, so one
accuracy row per model; latency is per device below.

### realcam-v1, final (second pass included)

| Detector | Floor | Recall | Precision | person | vehicle | animal | small | median TP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `yolov9s-320-edgetpu` | 0.3 | 0.556 | 0.875 | 0.495/0.822 | 0.605/0.952 | 0.633/0.833 | 0.250 | 0.705 |
| `yolov9s-320-edgetpu` | 0.4 / 0.4 / 0.3 | 0.516 | 0.909 | 0.445/0.881 | 0.567/0.967 | 0.633/0.833 | 0.223 | 0.716 |
| `yolov9s-512-edgetpu` | 0.3 | 0.653 | 0.913 | 0.644/0.868 | 0.667/0.961 | 0.646/0.944 | 0.348 | 0.701 |
| `yolov9s-512-edgetpu` | 0.4 / 0.4 / 0.3 | 0.603 | 0.925 | 0.574/0.879 | 0.625/0.976 | 0.646/0.944 | 0.313 | 0.719 |
| `frigate-mobiledet-edgetpu` | 0.3 | 0.595 | 0.288 | 0.615/0.255 | 0.571/0.281 | 0.595/0.758 | 0.295 | 0.617 |
| `frigate-mobiledet-edgetpu` | 0.5 / 0.5 / 0.5 | 0.458 | 0.650 | 0.461/0.627 | 0.444/0.624 | 0.494/0.886 | 0.214 | 0.664 |
| `yolov9m-640` on `openvino:npu` | 0.6 / 0.4 / 0.55 | 0.799 | 0.972 | 0.744/0.967 | 0.858/0.974 | 0.823/0.985 | 0.625 | 0.850 |

At 0.3 the free model emits 1357 boxes on 300 frames (391 true positives,
966 false positives). Person precision is 0.255. Raising the floor to the
stock 0.5 cuts that, and person precision is still 0.627 against 0.88 for
the YOLOv9-s builds. The 2026-10-23 production-floor captures of the same
YOLOv9 builds on this suite were 0.514 / 0.911 (320) and 0.613 / 0.929 (512).

Full pass alone, floor 0.3, recall: 0.467 (320), 0.597 (512), 0.533
(MobileDet), 0.776 (NPU). Animal recall on the full pass is 0.101 / 0.253 /
0.165 for the three Coral models and 0.747 for the NPU; the second pass is
what brings the Coral animal numbers up to ~0.63. That pass is already in
the `final` row.

### coco-val2017-v1 (full frame)

| Detector | Floor | Recall | Precision | person | vehicle | animal | small | median TP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `yolov9s-320-edgetpu` | 0.3 | 0.400 | 0.911 | 0.442/0.919 | 0.405/0.872 | 0.237/0.953 | 0.063 | 0.693 |
| `yolov9s-320-edgetpu` | 0.4 / 0.4 / 0.3 | 0.354 | 0.947 | 0.382/0.949 | 0.361/0.941 | 0.237/0.953 | 0.034 | 0.727 |
| `yolov9s-512-edgetpu` | 0.3 | 0.512 | 0.918 | 0.541/0.922 | 0.501/0.878 | 0.415/0.979 | 0.218 | 0.701 |
| `yolov9s-512-edgetpu` | 0.4 / 0.4 / 0.3 | 0.465 | 0.952 | 0.489/0.951 | 0.433/0.938 | 0.415/0.979 | 0.165 | 0.730 |
| `frigate-mobiledet-edgetpu` | 0.3 | 0.442 | 0.527 | 0.465/0.537 | 0.405/0.443 | 0.406/0.650 | 0.127 | 0.664 |
| `frigate-mobiledet-edgetpu` | 0.5 / 0.5 / 0.5 | 0.400 | 0.723 | 0.439/0.723 | 0.353/0.654 | 0.319/0.865 | 0.085 | 0.684 |
| `yolov9m-640` on `openvino:npu` | 0.6 / 0.4 / 0.55 | 0.528 | 0.964 | 0.511/0.968 | 0.571/0.942 | 0.532/0.984 | 0.242 | 0.827 |

The YOLOv9 production-floor rows match the 2026-10-23 captures on this suite
(0.354 / 0.947 and 0.465 / 0.952).

### Invoke latency (p50, ms)

`predict` is the invoke. `step` wraps preprocess and postprocess. PCIe units
agree; USB costs the bus transfer. 300 frames (realcam) and 400 (COCO) gave
the same picture.

| Model | pci predict / step | pci:1 predict / step | usb predict / step |
| --- | --- | --- | --- |
| `frigate-mobiledet-edgetpu` | 6.0 / 7.4 | 6.0 / 7.4 | 11.3 / 12.8 |
| `yolov9s-320-edgetpu` | 8.9 / 10.6 | 8.8 / 10.3 | 13.1 / 14.6 |
| `yolov9s-512-edgetpu` | 18.0 / 20.1 | 18.4 / 20.6 | 27.7 / 29.8 |

COCO on `edgetpu:pci` is the same invoke: 6.0, 8.6, 17.7 ms. The NPU
reference invoke is 31.4 ms (realcam) and 31.2 ms (COCO). Coral's published
9.1 ms for MobileDet on USB sits next to the 11.3 ms measured here (that
figure includes the output copy).

## Model, not a broken preprocess

The free plus catalog model, through our pipeline, on these Corals, does not beat
`yolov9s-512-edgetpu`. At the floors a stock import ships, it loses to
`yolov9s-320-edgetpu` on recall (realcam 0.458 against 0.516) and its
precision falls apart (0.650 against 0.909). At a shared 0.3 floor its
recall sits between the two YOLOv9 builds and its precision is 0.288,
because it emits confident false people and cars (person median score of a
true positive is 0.62, and hundreds of non-matching person boxes sit in the
same band). That is a noisier detector, not a detector whose boxes landed in
the wrong place.

A preprocess that swapped colour or skipped the int8 shift would not land
COCO recall at 0.44 with a median true-positive score of 0.66. Checked
against plus catalog's current Edge TPU plugin
(`plus-catalog/detectors/plugins/edgetpu_tfl.py` on `dev`):

- Input. The plugin receives a tensor that is already the model's width and
  height. For an int8 input it does `bitwise_xor(..., 128)`, which is the
  same bit pattern as our `(uint8 - 128)` int8 cast. Our pool feeds RGB
  uint8 NHWC and does not divide by 255; the quantisation is in the graph
  (`inference_pool.py`, the `edgetpu` branch of `_preprocess`). The catalog
  entry sets `preprocessMode: 'letterbox'`, so a non-square image is padded
  with (114, 114, 114) and the SSD decoder inverts that pad.
- plus catalog's own loop does not letterbox. It hands the plugin a region that
  has already been resized to the model square. Our realcam second pass is
  the same shape: the crop is square (`side` on the crop record), so
  letterbox adds no pad and the resize is a stretch, as plus catalog's is. The
  full pass is the difference: a 16:9 frame is letterboxed into the square.
  That is why animal recall on the full pass is ~0.10–0.25 and the second
  pass is what recovers it. The NPU runs that same second pass and is still
  at 0.799 against 0.653 for the best Coral model, so the region shape does
  not explain the gap that remains.
- SSD postprocess. plus catalog keeps scores at or above 0.4 and caps at 20
  boxes. Our `ssd.py` trusts the graph's count (N = 100 for this MobileDet)
  and the pool's confidence, which this run set to 0.3. The cap would not
  have changed the score: 1357 boxes on 300 frames is about 4.5 per frame,
  under 20. Class indices are the COCO-90 map (0 = person); truck stays
  truck and then maps to the vehicle macro, which is the same macro
  plus catalog's labelmap reaches by renaming truck to car.

The published 32.9% mAP is a different metric on a different COCO slice. It
is not a number our recall failed to reach, and it is not evidence the
pipeline threw the model's boxes away.

## Next step

Do not switch the Coral default to `frigate-mobiledet-edgetpu`. At the
floors we would ship it is a worse detector than the model those devices
already run, on both suites.

Do not start from a preprocess fix. The int8 input contract matches
plus catalog's, the boxes are where a 320 detector's boxes should be, and the
letterbox-versus-region difference is already covered by the second pass
that the `final` numbers include.

The community builds we run are already the ReLU6 full-int8 recipe
(`yolov9-s-relu6-best_320`, `yolov9-s-relu6-tpumax_512`), trained on COCO.
Another quantisation of that checkpoint will not close a 0.20 recall gap.
The step that can is that same recipe trained on the operator's frames,
compiled full-int8 for the Edge TPU, then measured on these two suites on a
Coral on `.50`.

The bar, on `realcam-v1` `final`, at the model's own floors: recall at least
**0.80** (the NPU's 0.799), precision at least **0.90** (the YOLOv9-s rows
are 0.91–0.93; MobileDet's 0.65 is the failure), and small-subject recall
above the 512 build's 0.31 and toward the NPU's 0.63. COCO is a secondary
check only. A camera-trained model is not required to beat the NPU's COCO
recall of 0.53.

The 14 plus catalog Edge TPU models are still unmeasured, and they are the
weights a plus catalog user on this account actually runs. Measuring them needs
a path that does not exist: a server-side move of a `camstack-local://` file
from the prod hub to the dev hub. If that path is added, the first two to
run are the base `yolov9s` 2026.1 (`be9c11b486ba0e2b8ea13338d4cc66ee`) and
the account mobiledet with 1932 verified images
(`42958636d17dd0cd4c05958b1086fce5`). They are not a substitute for the bar
above until they clear it.

Raw runs (not in git): `~/camstack-eval/{realcam-v1,coco-val2017-v1}/runs-plus-catalog/hub__edgetpu-*__f0.3.json`.

## plus catalog base models (2026-10-24, second run)

The seven base `edgetpu` models from the table above. Account-trained rows were not imported. Every one of the seven had an Edge TPU tflite; none was skipped.

`importPlusCatalogModel` on `.9`, `format: 'tflite'`, so the hub used its stored key. The key was not read. The files were left installed on `.9`:

| Base | Name | Id | Bytes |
| --- | --- | --- | --- |
| 2026.1 | yolov9s | `be9c11b486ba0e2b8ea13338d4cc66ee` | 8184544 |
| 2026.0 | yolov9s | `35877a6045227082ca72e73d6d34c72a` | 8184544 |
| 2026.1 | mobiledet | `e39924321228f76edd6b727c0cf2a4be` | 4846496 |
| 2026.0 | mobiledet | `c7b38453956cda87076baba4aca213e6` | 4842400 |
| 2025.3 | mobiledet | `e08864ec08832bd52c6037984ce72f1c` | 4842400 |
| 2025.2 | mobiledet | `e074d6405b3257c98d255cd2efc9d21f` | 4842400 |
| 2025.1 | mobiledet | `c241fae21de50ecf6c0f2a63769dcacd` | 4838304 |

Each file is `plus-catalog-<id>.tflite` under `.9`'s `/data/models`. Only those seven files were copied, to a temp dir on `.50`, then registered through `beginModelUpload` / `appendModelUpload` / `commitModelUpload` and `registerCustomModel` with the descriptor `listCustomModels` returned on `.9` (input size 320, the imported label list and class map, `defaultClassFloors` person/vehicle/animal 0.65, `preprocessMode: letterbox`). sha256 matched on `.9`, on the temp copy, and in `.50`'s `/data/models`. The temp copies were deleted. No other file left `.9`. No pipeline pin and no device weight was written on either hub.

The two yolov9s descriptors carry no `postprocessor`. Replayed that way, the step default `yolo` emitted zero-area `fox` boxes. The load line for `be9c11b4` was `outputs=2`, uint8, 320×320, which is the yolo-generic Edge TPU layout (`yolo-split-dfl`: one box tensor `[1, N, 64]` and one class tensor `[1, N, C]`). `.50`'s registry for those two ids now sets `postprocessor: 'yolo-split-dfl'`. Labels, floors, input size and class map are still the `.9` descriptor. `.9` was not edited. The `edgetpu:pci` benchmark slot had already loaded the unset decode, so `detection-pipeline` on `.50` was restarted once and the slot reloaded. The five mobiledet descriptors already say `postprocessor: 'ssd'`.

The call is the same runner as the first section (scripts/eval/run-device-suite.mjs (branch `eval-suites`, not merged), `eval-suites`), with unbound `minConfidencePerson/Vehicle/Animal = 0.3` and no model-binding sibling, so the import's 0.65 floors do not replace the call. The 0.65 rows drop boxes under those floors afterwards. The three Corals returned the same boxes on every model. Raw runs: `~/camstack-eval/{realcam-v1,coco-val2017-v1}/runs-plus-catalog-plus/`.

### realcam-v1, final

| Detector | Floor | Recall | Precision | person | vehicle | animal | small | median TP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Plus yolov9s 2026.1 | 0.3 | 0.635 | 0.862 | 0.543/0.847 | 0.724/0.887 | 0.709/0.824 | 0.429 | 0.862 |
| Plus yolov9s 2026.1 | 0.65 / 0.65 / 0.65 | 0.534 | 0.946 | 0.438/0.933 | 0.670/0.962 | 0.468/0.925 | 0.330 | 0.875 |
| Plus yolov9s 2026.0 | 0.3 | 0.632 | 0.891 | 0.552/0.875 | 0.720/0.908 | 0.658/0.881 | 0.411 | 0.852 |
| Plus yolov9s 2026.0 | 0.65 / 0.65 / 0.65 | 0.539 | 0.949 | 0.457/0.918 | 0.667/0.983 | 0.443/0.921 | 0.313 | 0.865 |
| Plus mobiledet 2026.1 | 0.3 | 0.279 | 0.256 | 0.536/0.429 | 0.000/0.000 | 0.165/0.053 | 0.089 | 0.734 |
| Plus mobiledet 2026.1 | 0.65 / 0.65 / 0.65 | 0.177 | 0.563 | 0.347/0.840 | 0.000/0.000 | 0.076/0.107 | 0.080 | 0.844 |
| Plus mobiledet 2026.0 | 0.3 | 0.275 | 0.335 | 0.533/0.533 | 0.004/0.019 | 0.139/0.065 | 0.134 | 0.785 |
| Plus mobiledet 2026.0 | 0.65 / 0.65 / 0.65 | 0.172 | 0.611 | 0.341/0.818 | 0.000/0.000 | 0.063/0.179 | 0.071 | 0.875 |
| Plus mobiledet 2025.3 | 0.3 | 0.265 | 0.285 | 0.521/0.517 | 0.000/0.000 | 0.114/0.042 | 0.143 | 0.758 |
| Plus mobiledet 2025.3 | 0.65 / 0.65 / 0.65 | 0.190 | 0.546 | 0.375/0.821 | 0.000/0.000 | 0.076/0.100 | 0.107 | 0.844 |
| Plus mobiledet 2025.2 | 0.3 | 0.279 | 0.253 | 0.555/0.451 | 0.000/0.000 | 0.089/0.027 | 0.116 | 0.766 |
| Plus mobiledet 2025.2 | 0.65 / 0.65 / 0.65 | 0.192 | 0.565 | 0.385/0.847 | 0.000/0.000 | 0.051/0.069 | 0.116 | 0.856 |
| Plus mobiledet 2025.1 | 0.3 | 0.251 | 0.292 | 0.495/0.536 | 0.000/0.000 | 0.101/0.040 | 0.098 | 0.769 |
| Plus mobiledet 2025.1 | 0.65 / 0.65 / 0.65 | 0.164 | 0.557 | 0.331/0.814 | 0.000/0.000 | 0.038/0.077 | 0.080 | 0.879 |
| `yolov9s-320-edgetpu` | 0.3 | 0.556 | 0.875 | 0.495/0.822 | 0.605/0.952 | 0.633/0.833 | 0.250 | 0.705 |
| `yolov9s-320-edgetpu` | 0.4 / 0.4 / 0.3 | 0.516 | 0.909 | 0.445/0.881 | 0.567/0.967 | 0.633/0.833 | 0.223 | 0.716 |
| `yolov9s-512-edgetpu` | 0.3 | 0.653 | 0.913 | 0.644/0.868 | 0.667/0.961 | 0.646/0.944 | 0.348 | 0.701 |
| `yolov9s-512-edgetpu` | 0.4 / 0.4 / 0.3 | 0.603 | 0.925 | 0.574/0.879 | 0.625/0.976 | 0.646/0.944 | 0.313 | 0.719 |
| `frigate-mobiledet-edgetpu` | 0.3 | 0.595 | 0.288 | 0.615/0.255 | 0.571/0.281 | 0.595/0.758 | 0.295 | 0.617 |
| `frigate-mobiledet-edgetpu` | 0.5 / 0.5 / 0.5 | 0.458 | 0.650 | 0.461/0.627 | 0.444/0.624 | 0.494/0.886 | 0.214 | 0.664 |
| `yolov9m-640` on `openvino:npu` | 0.6 / 0.4 / 0.55 | 0.799 | 0.972 | 0.744/0.967 | 0.858/0.974 | 0.823/0.985 | 0.625 | 0.850 |

Plus yolov9s at 0.3 sits just under `yolov9s-512-edgetpu` (recall 0.635 and 0.632 against 0.653) and ahead of `yolov9s-320-edgetpu`. At the floors the import ships, recall falls to 0.534 and 0.539. Precision is 0.946 and 0.949. Small-subject recall is 0.330 and 0.313. Median TP is the suite's p50 of matched scores.

The five Plus mobiledet rows are not a reading of those weights. `postprocess_ssd` names every class from the COCO-90 list (`label_for_class` in `ssd.py`) and never reads the label list on the descriptor. The imported map puts `car` at index 29; COCO-90 index 29 is a gap (`n/a`) and the box is dropped. Index 3 is `dog` on the Plus map and `motorcycle` on COCO-90, and the 2026.1 run's class histogram is 396 person, 114 cow, 94 cat, 75 motorcycle, 1 car. Person is index 0 on both maps, so that column is the one that lines up: at 0.3 it is 0.495–0.555, under the free MobileDet's 0.615. Vehicle and animal, and therefore the overall, are the COCO-90 names.

### coco-val2017-v1

| Detector | Floor | Recall | Precision | person | vehicle | animal | small | median TP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Plus yolov9s 2026.1 | 0.3 | 0.275 | 0.846 | 0.307/0.868 | 0.265/0.838 | 0.170/0.734 | 0.027 | 0.776 |
| Plus yolov9s 2026.1 | 0.65 / 0.65 / 0.65 | 0.208 | 0.951 | 0.239/0.957 | 0.195/0.941 | 0.111/0.927 | 0.008 | 0.823 |
| Plus yolov9s 2026.0 | 0.3 | 0.270 | 0.844 | 0.301/0.871 | 0.267/0.788 | 0.158/0.794 | 0.026 | 0.781 |
| Plus yolov9s 2026.0 | 0.65 / 0.65 / 0.65 | 0.204 | 0.948 | 0.238/0.960 | 0.193/0.931 | 0.091/0.886 | 0.009 | 0.827 |
| Plus mobiledet 2026.1 | 0.3 | 0.185 | 0.394 | 0.299/0.584 | 0.000/0.000 | 0.015/0.018 | 0.005 | 0.699 |
| Plus mobiledet 2026.1 | 0.65 / 0.65 / 0.65 | 0.115 | 0.686 | 0.187/0.862 | 0.000/0.000 | 0.003/0.017 | 0.000 | 0.809 |
| `yolov9s-512-edgetpu` | 0.3 | 0.512 | 0.918 | 0.541/0.922 | 0.501/0.878 | 0.415/0.979 | 0.218 | 0.701 |
| `yolov9s-512-edgetpu` | 0.4 / 0.4 / 0.3 | 0.465 | 0.952 | 0.489/0.951 | 0.433/0.938 | 0.415/0.979 | 0.165 | 0.730 |
| `yolov9m-640` on `openvino:npu` | 0.6 / 0.4 / 0.55 | 0.528 | 0.964 | 0.511/0.968 | 0.571/0.942 | 0.532/0.984 | 0.242 | 0.827 |

The other four Plus mobiledet releases match 2026.1 on this suite (recall 0.167–0.177 at 0.3, vehicle recall 0). Plus yolov9s COCO recall is about half of `yolov9s-512-edgetpu`. COCO stays the secondary check.

### Invoke latency (p50, ms, realcam)

| Model | pci predict / step | pci:1 predict / step | usb predict / step |
| --- | --- | --- | --- |
| Plus yolov9s 2026.1 | 9.6 / 11.7 | 9.6 / 11.7 | 14.4 / 16.4 |
| Plus yolov9s 2026.0 | 9.6 / 11.6 | 9.6 / 11.6 | 14.4 / 16.4 |
| Plus mobiledet 2026.1 | 5.6 / 7.6 | 5.6 / 7.6 | 9.5 / 11.5 |
| Plus mobiledet 2026.0 | 5.4 / 6.9 | 5.4 / 7.0 | 9.3 / 10.9 |
| Plus mobiledet 2025.3 | 5.5 / 7.2 | 5.5 / 7.2 | 9.3 / 10.9 |
| Plus mobiledet 2025.2 | 5.4 / 6.9 | 5.4 / 6.9 | 9.3 / 10.8 |
| Plus mobiledet 2025.1 | 5.4 / 6.9 | 5.3 / 6.9 | 9.2 / 10.7 |
| `frigate-mobiledet-edgetpu` | 6.0 / 7.4 | 6.0 / 7.4 | 11.3 / 12.8 |
| `yolov9s-320-edgetpu` | 8.9 / 10.6 | 8.8 / 10.3 | 13.1 / 14.6 |
| `yolov9s-512-edgetpu` | 18.0 / 20.1 | 18.4 / 20.6 | 27.7 / 29.8 |

Plus yolov9s on PCIe is about a millisecond slower than `yolov9s-320-edgetpu` and about half of `yolov9s-512-edgetpu`. Plus MobileDet invoke is in the same band as the free MobileDet. COCO invoke on `edgetpu:pci` is within 1 ms of these figures.

## Revised verdict

No plus catalog base model reaches the bar on `realcam-v1` `final` at the model's own floors: recall at least 0.80, precision at least 0.90, small-subject recall above 0.31.

The two base yolov9s models are the ones this run actually scored. At 0.65 / 0.65 / 0.65, 2026.1 is recall 0.534, precision 0.946, small 0.330; 2026.0 is 0.539, 0.949, 0.313. Precision and the small-subject mark clear. Recall does not: 0.53 is under `yolov9s-512-edgetpu` at its own floors (0.603) and far under the NPU's 0.799. At a shared 0.3 floor they are 0.635 and 0.632 against 0.653 for the 512 build, with precision 0.862 and 0.891 against 0.913. Do not switch the Coral default to either.

The five base MobileDet models do not answer the bar. The SSD decoder scores them on COCO-90, so a car the graph emits at the Plus index never becomes a vehicle. Until that decoder reads the imported label list, a MobileDet row in this table is not a reason to adopt or reject the weights.

Adopting a plus catalog base model as the Coral default, had one cleared the bar, would still need a licence these terms do not give. The Model License at `https://plus.frigate.video/terms-and-conditions/` (read 2026-10-24) is non-exclusive, non-transferable and non-sublicensable: download and use on camera systems the subscriber owns or operates, for their own purposes. It does not allow distributing the weights, hosting them for a third party, or deploying them on a customer's site. A default that ships inside CamStack, or a hub that hands the file to someone else's cameras, is the case the terms point at `sales@plus catalog.video`. The operator's own cameras are inside the licence they already hold. That is not a licence to make the file the product default. The weights stay on `.9` and `.50` as imported models, not in the catalog.
