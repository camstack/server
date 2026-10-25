# INT8 re-calibration with the centred letterbox — measured, old vs new vs float

Measured 2026-10-08, offline, on a developer Mac. Nothing ran on the cluster:
the hub was only read (400 stored frames, GET requests only).

## Why

Until 2026-10-08, `convert_lib.quantize_openvino_int8` letterboxed its NNCF
calibration images **top-left** (`canvas[:nh, :nw]`). The inference pool
letterboxes **centred** (`inference_pool.letterbox_image`). The fix made
calibration centred, but every hosted OpenVINO INT8 IR had been calibrated
the old way. This run re-quantised all of them and measured old against new
before replacing anything.

## What was rebuilt

There are 21 hosted OpenVINO INT8 IRs. No classifier on the mirror has an
INT8 OpenVINO IR. The TFLite / Edge TPU INT8 models come from their own build
scripts, not from `convert_lib`, and are not affected.

| family | IRs | NNCF subset |
|---|---|---|
| YOLOv9 | `yolov9{t,s,m,c}-{320,640}-int8` | 300 |
| YOLO26 @640 | `yolo26{n,s,m,l,x}-int8` | 128 |
| YOLO26 reduced | `yolo26{n,s,m,l}-{320,256}-int8` | 128 |

**How they were rebuilt.** We ran `scripts/build-camstack-models.py
--formats openvino --reuse-onnx --calib-dir val2017` with the `convert_lib.py`
on main. `--reuse-onnx` is new in this change. It quantises the **hosted
ONNX** file of each model rather than re-exporting it from Ultralytics, so
the graph is exactly what the mirror serves, and the calibration is the only
thing that changes.

The settings match the originals:

- **Calibration data:** COCO val2017, the first N images in file-name order.
  Hub frames are for user-trained models, so none were used here.
- **Toolchain:** OpenVINO 2026.2.1 + NNCF 3.2.0, as each hosted IR records in
  its `rt_info`. The NNCF parameters are the defaults: `fast_bias_correction`,
  preset none, target ANY.

**Provenance check.** Quantising `yolov9m-640` with the old top-left
preprocessing on the same 300 images reproduces the hosted `.bin` **bit for
bit** (sha256 `b229989c…`). The hosted IRs are therefore exactly
"old convert_lib + COCO val2017 first N". Old vs new isolates the padding
placement: centred vs top-left, plus `int()` vs `round()` in the resized size.

## How it was measured

We used the checked-in harness, `scripts/eval/`. This change extends it:

- `OpenVinoDetector` runs an IR through the pool's own PrePostProcessor (uint8
  NHWC, /255 folded in), letterbox and YOLO decode. CPU, FP32, pool floor
  0.05, NMS 0.45.
- `load_coco` and `load_pseudo_gt` add two evaluation sets.
- AP50-95 is the COCO average over IoU 0.50:0.95.
- A paired bootstrap (`camstack_eval/bootstrap.py`) gives the confidence
  interval of each difference.
- `evaluate_variants.py` runs N variants of one model on one set, with a
  detection cache.

**Sets.** Neither overlaps the calibration images.

- **COCO:** val2017 images 301–800 in file-name order (500 images). This
  skips every calibration image, since calibration takes the first 300.
  Classes are mapped to person / vehicle / animal by `COCO_TO_MACRO`, and
  crowd boxes are "don't care". Positives: 1130 person, 438 vehicle,
  261 animal.
- **Hub:** 400 stored `keyFrameSmall` frames (960×540, clean, no overlay)
  from 26 cameras, 2026-10-01 → 10-08, 46 of them night/IR. The pseudo ground
  truth follows the 2026-10-07 method: YOLO26-X @1280 AND RT-DETR-X @640,
  combined by `camstack_eval/pseudo_gt.py` with default policy. Positives:
  392 person, 147 vehicle, 151 animal.

**Models.** Each model was run three ways: **old** (the hosted INT8 IR),
**new** (re-quantised centred) and **float**. Float is the catalog's base IR
of the same model: `-fp16.xml` for YOLOv9 and YOLO26 @640, the FP32 IR for
YOLO26 @320/@256, run at FP32 on the CPU. It shows how much accuracy INT8
costs.

**Floors.** P/R are reported at the model's **shipped** floors
(`OBJECT_DETECTION_CLASS_FLOORS`, D738/D739). A model with no row (the @256
builds, yolo26l/x) uses the globals 0.65 / 0.50 / 0.50.

**INT8 execution.** No AVX-VNNI CPU was available off-cluster. Real x86 INT8
kernels ran under Rosetta 2, using OpenVINO 2025.4.1 (x86_64; no 2026.x
x86_64 macOS wheel exists). The fleet pins `openvino>=2025,<2026`.

The last 12 models (marked ¹) instead ran as exact FP32 fake-quantisation on
native ARM: OpenVINO 2026.2.1 with `LP_TRANSFORMS_MODE=false`. Both old and
new of each model ran on the same path. The two paths were cross-checked on
`yolov9m-640`:

- emulated old vs Rosetta old: Δ mAP50-95 +0.002 [−0.004, +0.008];
- emulated new vs Rosetta new: within 0.002 as well.

Native ARM with the default low-precision transforms gives wrong output
(the "garbage on ARM CPU" of the 2026-10-07 note). That path was never used.

**Noise band and rule.** We define the noise band as the 95 % paired-bootstrap
interval of new − old (1000 resamples of the frames). An IR is **replaced**
only if none of 16 differences is a significant drop, meaning an interval
lying entirely below zero. The 16 are AP50 and AP50-95, for the mean and for
each of person, vehicle and animal, on both sets. Any significant drop keeps
the old IR. The rule leans towards the known artefact.

Latency was not measured. A re-quantisation changes only quantisation scales
and zero points: the graph and op types are identical, and the `.bin`
sizes match to the byte for 14 of 21 (the other 7 differ by 4–8 bytes).

## Result

**13 replaced, 8 kept.**

- **Replaced:** `yolov9s-320`, `yolov9m-320`, `yolov9s-640`, `yolov9t-320`,
  `yolo26n-320`, `yolo26n`, `yolo26m`, `yolo26l`, `yolo26x` and
  `yolo26{n,s,m,l}-256` (all `-int8`).
- **Kept:** `yolov9m-640`, `yolov9t-640`, `yolov9c-320`, `yolov9c-640`,
  `yolo26s`, `yolo26s-320`, `yolo26m-320` and `yolo26l-320` (all `-int8`).

Centring the calibration padding is **not an accuracy fix**. On most models,
new and old are equal within noise. On two it is clearly worse:

- `yolov9m-640` is worse by −0.035 (COCO) and −0.059 (hub) mAP50-95.
- `yolov9c-320` is worse by −0.021 (COCO) and −0.030 (hub).

The `yolov9m-640` loss is not calibration-sample luck. A centred calibration
on a disjoint COCO subset (images 4001–4300) is also worse by −0.031
[−0.039, −0.021]. Most of what the INT8 builds lose is localisation:
mAP50-95 falls far more than mAP50.

The fleet's live picks:

- **Hub NPU + iGPU, `yolov9m-640-int8`: kept.** The centred build is worse
  on every class's AP50-95, on both sets.
- **N100, `yolov9s-320-int8`: replaced.** It is within noise everywhere:
  COCO mAP50-95 +0.002 [−0.003, +0.007], hub −0.008 [−0.019, +0.004].
  The point estimates lean slightly negative on the hub frames and slightly
  positive on COCO.

**The bigger finding is the INT8 cost itself.** Against the float base, the
hosted INT8 IRs lose 0.03–0.17 mAP50-95 (YOLOv9) and 0.01–0.16 (YOLO26). The live `yolov9m-640` loses 0.07
on COCO and 0.12 on the hub, almost all of it in box precision: its mAP50
loses only 0.006–0.014. Mixed-precision quantisation would be the lever
here: keeping the YOLO box/DFL head in float through an NNCF `ignored_scope`.
That is a recipe change, measured separately before anything ships. Not
done here.

**Floors (D739).** We applied the D739 rule on the hub set: the root
`yolov9m-320-int8` at 0.65 / 0.50 / 0.50 sets the false-positive budget, and
each model gets the lowest 0.05-grid floor within it. Old and new got the
same floor or one 0.05–0.10 apart for every replaced model. The catalog
documents ±0.05–0.10 as the noise of a D739 floor, and none moved beyond it,
so **no floor changed**. `model-floors.json` and
`OBJECT_DETECTION_CLASS_FLOORS` are untouched.

## Mirror and catalog

- Hugging Face `camstack/camstack-models`:
  - Commit `ba4cfc0f9b26` copies the 13 old IRs (xml + bin) to
    `archive/2026-10-08-int8-topleft-calibration/<same path>`.
  - Commit `6389d708a5e9` replaces them in place.
  - Local backup of all 21 old IRs, with a sha256 manifest:
    `~/Documents/Git/camstack/int8-recal-backup/`.
- `packages/system/src/download/hosted-model-revisions.ts` was regenerated
  with `scripts/check-hosted-model-revisions.ts --write`; 13 revisions
  changed. Under D744 a node's copy is stale when its `.bin` sha256 differs
  from the revision, so nodes re-download those 13 once a release carries
  the table.
- Rollback for one model: copy its `archive/…` files back to the original
  path and regenerate the table.

## Reproduce

```bash
pip install -r scripts/eval/requirements.txt nncf==3.2.0 opencv-python-headless
# mirror ONNX placed under rebuilt/<folder>/onnx/
python scripts/build-camstack-models.py --variant camstack-yolov9s-320 \
  --formats openvino --reuse-onnx --out rebuilt --calib-dir val2017
python scripts/eval/evaluate_variants.py \
  --coco annotations/instances_val2017.json --images val2017 --skip 300 --limit 500 \
  --model old=<hosted>-int8.xml@320 --model new=rebuilt/.../camstack-yolov9s-320-int8.xml@320 \
  --model float=<hosted>-fp16.xml@320 --floors person=0.7,vehicle=0.45,animal=0.4 \
  --cache dets/yolov9s-320
```

The pseudo-GT step for the hub frames uses Ultralytics (YOLO26-X, RT-DETR-X)
outside the harness: the harness imports no AGPL code. The frames themselves
are operator data and are not in the repository.

¹ INT8 run as exact FP32 fake-quantisation (native ARM,
`LP_TRANSFORMS_MODE=false`); the rows without ¹ ran real x86 INT8 kernels.
Old and new of each model always ran on the same path.

## Means

| model | set | mAP50 old / new / float | mAP50-95 old / new / float | Δ mAP50 new−old [95% CI] | Δ mAP50-95 new−old [95% CI] |
|---|---|---|---|---|---|
| `yolov9m-640-int8` | COCO | 0.754 / 0.739 / 0.768 | 0.501 / 0.466 / 0.573 | -0.015 [-0.028, -0.003] | -0.035 [-0.043, -0.026] |
|  | hub | 0.893 / 0.878 / 0.899 | 0.628 / 0.569 / 0.744 | -0.015 [-0.031, -0.000] | -0.059 [-0.071, -0.046] |
| `yolov9s-320-int8` | COCO | 0.610 / 0.617 / 0.622 | 0.407 / 0.410 / 0.435 | +0.007 [+0.000, +0.013] | +0.002 [-0.003, +0.007] |
|  | hub | 0.672 / 0.660 / 0.696 | 0.426 / 0.417 / 0.466 | -0.011 [-0.024, +0.003] | -0.008 [-0.019, +0.004] |
| `yolov9m-320-int8` | COCO | 0.662 / 0.667 / 0.669 | 0.448 / 0.449 / 0.483 | +0.005 [-0.004, +0.014] | +0.001 [-0.005, +0.008] |
|  | hub | 0.758 / 0.771 / 0.776 | 0.504 / 0.509 / 0.558 | +0.013 [-0.001, +0.024] | +0.005 [-0.007, +0.016] |
| `yolov9s-640-int8` | COCO | 0.710 / 0.713 / 0.721 | 0.471 / 0.476 / 0.532 | +0.004 [-0.005, +0.012] | +0.005 [-0.001, +0.012] |
|  | hub | 0.836 / 0.844 / 0.857 | 0.576 / 0.580 / 0.677 | +0.008 [-0.005, +0.020] | +0.005 [-0.006, +0.013] |
| `yolov9t-320-int8` | COCO | 0.474 / 0.472 / 0.539 | 0.282 / 0.283 / 0.360 | -0.002 [-0.012, +0.006] | +0.001 [-0.004, +0.006] |
|  | hub | 0.375 / 0.379 / 0.480 | 0.188 / 0.195 / 0.288 | +0.004 [-0.008, +0.017] | +0.007 [-0.001, +0.014] |
| `yolov9t-640-int8` | COCO | 0.599 / 0.599 / 0.660 | 0.365 / 0.367 / 0.465 | -0.000 [-0.007, +0.006] | +0.002 [-0.002, +0.006] |
|  | hub | 0.696 / 0.704 / 0.791 | 0.406 / 0.407 / 0.577 | +0.008 [-0.005, +0.022] | +0.001 [-0.009, +0.010] |
| `yolov9c-320-int8` | COCO | 0.663 / 0.653 / 0.671 | 0.452 / 0.430 / 0.487 | -0.009 [-0.018, -0.001] | -0.021 [-0.028, -0.015] |
|  | hub | 0.782 / 0.777 / 0.806 | 0.533 / 0.503 / 0.595 | -0.004 [-0.021, +0.013] | -0.030 [-0.042, -0.016] |
| `yolov9c-640-int8` ¹ | COCO | 0.745 / 0.739 / 0.777 | 0.471 / 0.470 / 0.586 | -0.006 [-0.013, +0.002] | -0.001 [-0.006, +0.004] |
|  | hub | 0.906 / 0.902 / 0.921 | 0.593 / 0.593 / 0.778 | -0.004 [-0.014, +0.005] | +0.000 [-0.009, +0.010] |
| `yolo26n-320-int8` | COCO | 0.487 / 0.490 / 0.528 | 0.332 / 0.335 / 0.366 | +0.003 [-0.006, +0.010] | +0.002 [-0.003, +0.008] |
|  | hub | 0.451 / 0.453 / 0.474 | 0.281 / 0.279 / 0.309 | +0.002 [-0.014, +0.018] | -0.002 [-0.013, +0.010] |
| `yolo26s-320-int8` | COCO | 0.534 / 0.529 / 0.635 | 0.369 / 0.365 / 0.453 | -0.005 [-0.013, +0.001] | -0.004 [-0.010, +0.002] |
|  | hub | 0.571 / 0.579 / 0.750 | 0.383 / 0.386 / 0.545 | +0.008 [-0.006, +0.021] | +0.003 [-0.008, +0.013] |
| `yolo26m-320-int8` ¹ | COCO | 0.652 / 0.651 / 0.676 | 0.474 / 0.470 / 0.493 | -0.001 [-0.007, +0.004] | -0.004 [-0.009, +0.001] |
|  | hub | 0.791 / 0.789 / 0.822 | 0.579 / 0.570 / 0.621 | -0.001 [-0.013, +0.010] | -0.009 [-0.020, +0.003] |
| `yolo26l-320-int8` ¹ | COCO | 0.656 / 0.652 / 0.696 | 0.488 / 0.486 / 0.516 | -0.004 [-0.011, +0.003] | -0.002 [-0.008, +0.003] |
|  | hub | 0.807 / 0.790 / 0.840 | 0.606 / 0.587 / 0.631 | -0.017 [-0.031, -0.002] | -0.018 [-0.029, -0.008] |
| `yolo26n-int8` ¹ | COCO | 0.660 / 0.660 / 0.668 | 0.465 / 0.464 / 0.476 | +0.001 [-0.005, +0.006] | -0.001 [-0.005, +0.004] |
|  | hub | 0.748 / 0.749 / 0.782 | 0.544 / 0.543 / 0.581 | +0.002 [-0.011, +0.013] | -0.001 [-0.012, +0.008] |
| `yolo26s-int8` ¹ | COCO | 0.734 / 0.733 / 0.743 | 0.535 / 0.536 / 0.552 | -0.002 [-0.008, +0.006] | +0.001 [-0.004, +0.007] |
|  | hub | 0.866 / 0.877 / 0.903 | 0.695 / 0.688 / 0.746 | +0.011 [-0.003, +0.027] | -0.007 [-0.018, +0.004] |
| `yolo26m-int8` ¹ | COCO | 0.764 / 0.769 / 0.774 | 0.570 / 0.570 / 0.585 | +0.005 [-0.002, +0.013] | -0.000 [-0.006, +0.005] |
|  | hub | 0.916 / 0.916 / 0.934 | 0.760 / 0.766 / 0.805 | +0.000 [-0.011, +0.010] | +0.005 [-0.003, +0.013] |
| `yolo26l-int8` ¹ | COCO | 0.782 / 0.782 / 0.798 | 0.589 / 0.587 / 0.604 | +0.000 [-0.006, +0.006] | -0.002 [-0.006, +0.003] |
|  | hub | 0.923 / 0.929 / 0.950 | 0.782 / 0.785 / 0.822 | +0.006 [-0.005, +0.017] | +0.003 [-0.006, +0.013] |
| `yolo26n-256-int8` ¹ | COCO | 0.460 / 0.456 / 0.478 | 0.306 / 0.305 / 0.324 | -0.004 [-0.010, +0.003] | -0.001 [-0.005, +0.004] |
|  | hub | 0.336 / 0.344 / 0.345 | 0.185 / 0.192 / 0.201 | +0.008 [-0.004, +0.022] | +0.007 [-0.002, +0.016] |
| `yolo26s-256-int8` ¹ | COCO | 0.534 / 0.541 / 0.567 | 0.375 / 0.378 / 0.398 | +0.007 [+0.001, +0.013] | +0.003 [-0.001, +0.008] |
|  | hub | 0.554 / 0.544 / 0.587 | 0.368 / 0.364 / 0.409 | -0.010 [-0.024, +0.006] | -0.004 [-0.014, +0.008] |
| `yolo26m-256-int8` ¹ | COCO | 0.610 / 0.613 / 0.628 | 0.436 / 0.437 / 0.453 | +0.003 [-0.004, +0.009] | +0.001 [-0.004, +0.004] |
|  | hub | 0.696 / 0.706 / 0.728 | 0.491 / 0.495 / 0.532 | +0.010 [+0.001, +0.019] | +0.004 [-0.004, +0.012] |
| `yolo26l-256-int8` ¹ | COCO | 0.603 / 0.604 / 0.649 | 0.438 / 0.440 / 0.472 | +0.001 [-0.006, +0.008] | +0.002 [-0.003, +0.007] |
|  | hub | 0.728 / 0.730 / 0.771 | 0.529 / 0.532 / 0.569 | +0.002 [-0.008, +0.014] | +0.003 [-0.006, +0.013] |
| `yolo26x-int8` ¹ | COCO | 0.806 / 0.809 / 0.811 | 0.613 / 0.614 / 0.623 | +0.003 [-0.002, +0.009] | +0.000 [-0.004, +0.005] |
|  | hub | 0.965 / 0.963 / 0.965 | 0.831 / 0.831 / 0.860 | -0.002 [-0.008, +0.003] | -0.000 [-0.007, +0.007] |

## Per class


### Hub frames: P / R at the shipped floor, AP50, AP50-95 (old → new; float)

| model | class | floor | P old → new (float) | R old → new (float) | AP50 old → new (float) | AP50-95 old → new (float) |
|---|---|---|---|---|---|---|
| `yolov9m-640-int8` | person | 0.55 | 0.978 → 0.978 (0.970) | 0.801 → 0.791 (0.829) | 0.909 → 0.900 (0.921) | 0.685 → 0.626 (0.807) |
|  | vehicle | 0.40 | 0.976 → 0.951 (0.975) | 0.830 → 0.796 (0.803) | 0.895 → 0.870 (0.891) | 0.544 → 0.486 (0.634) |
|  | animal | 0.70 | 0.948 → 0.959 (0.949) | 0.609 → 0.616 (0.623) | 0.875 → 0.865 (0.886) | 0.656 → 0.594 (0.791) |
| `yolov9s-320-int8` | person | 0.70 | 0.964 → 0.982 (0.975) | 0.413 → 0.413 (0.500) | 0.759 → 0.763 (0.760) | 0.537 → 0.530 (0.571) |
|  | vehicle | 0.45 | 0.988 → 0.988 (0.968) | 0.565 → 0.544 (0.619) | 0.723 → 0.705 (0.721) | 0.418 → 0.410 (0.435) |
|  | animal | 0.40 | 0.896 → 0.872 (0.891) | 0.285 → 0.225 (0.325) | 0.533 → 0.513 (0.608) | 0.322 → 0.311 (0.392) |
| `yolov9m-320-int8` | person | 0.65 | 0.943 → 0.948 (0.941) | 0.635 → 0.653 (0.653) | 0.811 → 0.819 (0.822) | 0.600 → 0.604 (0.648) |
|  | vehicle | 0.40 | 0.960 → 0.941 (0.952) | 0.653 → 0.653 (0.673) | 0.766 → 0.775 (0.770) | 0.459 → 0.474 (0.503) |
|  | animal | 0.45 | 0.852 → 0.874 (0.894) | 0.649 → 0.642 (0.669) | 0.698 → 0.720 (0.734) | 0.452 → 0.449 (0.523) |
| `yolov9s-640-int8` | person | 0.50 | 0.962 → 0.959 (0.967) | 0.773 → 0.778 (0.816) | 0.877 → 0.888 (0.902) | 0.647 → 0.654 (0.748) |
|  | vehicle | 0.30 | 0.974 → 0.973 (0.951) | 0.776 → 0.748 (0.796) | 0.840 → 0.837 (0.846) | 0.521 → 0.523 (0.580) |
|  | animal | 0.55 | 0.875 → 0.882 (0.892) | 0.510 → 0.497 (0.550) | 0.791 → 0.807 (0.824) | 0.559 → 0.564 (0.703) |
| `yolov9t-320-int8` | person | 0.55 | 0.947 → 0.939 (0.939) | 0.227 → 0.235 (0.395) | 0.542 → 0.539 (0.649) | 0.314 → 0.316 (0.449) |
|  | vehicle | 0.40 | 0.769 → 0.780 (0.875) | 0.272 → 0.265 (0.333) | 0.419 → 0.424 (0.527) | 0.169 → 0.180 (0.252) |
|  | animal | 0.30 | 0.737 → 0.800 (0.706) | 0.093 → 0.079 (0.159) | 0.165 → 0.174 (0.263) | 0.081 → 0.089 (0.163) |
| `yolov9t-640-int8` | person | 0.60 | 0.995 → 0.995 (0.977) | 0.487 → 0.490 (0.638) | 0.753 → 0.772 (0.845) | 0.494 → 0.500 (0.656) |
|  | vehicle | 0.55 | 1.000 → 1.000 (1.000) | 0.395 → 0.429 (0.401) | 0.707 → 0.725 (0.734) | 0.377 → 0.392 (0.458) |
|  | animal | 0.55 | 0.962 → 0.885 (0.914) | 0.166 → 0.152 (0.424) | 0.628 → 0.615 (0.795) | 0.348 → 0.329 (0.616) |
| `yolov9c-320-int8` | person | 0.70 | 0.964 → 0.967 (0.950) | 0.615 → 0.594 (0.628) | 0.832 → 0.837 (0.846) | 0.613 → 0.593 (0.674) |
|  | vehicle | 0.50 | 0.970 → 0.980 (0.960) | 0.653 → 0.653 (0.646) | 0.788 → 0.773 (0.796) | 0.492 → 0.461 (0.523) |
|  | animal | 0.25 | 0.856 → 0.858 (0.885) | 0.669 → 0.642 (0.768) | 0.724 → 0.722 (0.777) | 0.493 → 0.455 (0.588) |
| `yolov9c-640-int8` | person | 0.45 | 0.979 → 0.977 (0.980) | 0.849 → 0.849 (0.890) | 0.936 → 0.932 (0.949) | 0.657 → 0.658 (0.829) |
|  | vehicle | 0.40 | 0.959 → 0.959 (0.984) | 0.803 → 0.789 (0.816) | 0.885 → 0.873 (0.902) | 0.519 → 0.509 (0.669) |
|  | animal | 0.30 | 0.929 → 0.929 (0.964) | 0.868 → 0.868 (0.887) | 0.898 → 0.900 (0.911) | 0.603 → 0.612 (0.836) |
| `yolo26n-320-int8` | person | 0.45 | 0.915 → 0.903 (0.843) | 0.357 → 0.355 (0.467) | 0.609 → 0.608 (0.631) | 0.408 → 0.405 (0.442) |
|  | vehicle | 0.55 | 0.966 → 0.966 (1.000) | 0.190 → 0.190 (0.231) | 0.495 → 0.500 (0.512) | 0.261 → 0.260 (0.284) |
|  | animal | 0.35 | 0.818 → 0.846 (0.739) | 0.060 → 0.073 (0.113) | 0.251 → 0.252 (0.280) | 0.172 → 0.173 (0.200) |
| `yolo26s-320-int8` | person | 0.50 | 0.966 → 0.967 (0.953) | 0.505 → 0.520 (0.673) | 0.737 → 0.745 (0.832) | 0.538 → 0.535 (0.659) |
|  | vehicle | 0.55 | 0.984 → 1.000 (1.000) | 0.429 → 0.435 (0.599) | 0.627 → 0.615 (0.752) | 0.379 → 0.373 (0.496) |
|  | animal | 0.45 | 0.778 → 0.818 (0.901) | 0.093 → 0.119 (0.424) | 0.348 → 0.375 (0.665) | 0.232 → 0.249 (0.481) |
| `yolo26m-320-int8` | person | 0.60 | 0.986 → 0.976 (0.980) | 0.735 → 0.730 (0.732) | 0.893 → 0.879 (0.885) | 0.694 → 0.679 (0.717) |
|  | vehicle | 0.40 | 0.756 → 0.807 (0.930) | 0.612 → 0.653 (0.633) | 0.728 → 0.741 (0.792) | 0.487 → 0.486 (0.543) |
|  | animal | 0.30 | 0.862 → 0.818 (0.803) | 0.662 → 0.656 (0.702) | 0.751 → 0.748 (0.788) | 0.556 → 0.545 (0.605) |
| `yolo26l-320-int8` | person | 0.65 | 0.926 → 0.932 (0.983) | 0.707 → 0.696 (0.724) | 0.851 → 0.842 (0.887) | 0.701 → 0.692 (0.731) |
|  | vehicle | 0.50 | 0.933 → 0.932 (0.962) | 0.667 → 0.653 (0.694) | 0.776 → 0.762 (0.809) | 0.517 → 0.506 (0.544) |
|  | animal | 0.50 | 0.902 → 0.899 (0.948) | 0.490 → 0.530 (0.609) | 0.793 → 0.766 (0.826) | 0.598 → 0.563 (0.617) |
| `yolo26n-int8` | person | 0.55 | 0.939 → 0.944 (0.941) | 0.548 → 0.520 (0.612) | 0.797 → 0.805 (0.831) | 0.622 → 0.627 (0.658) |
|  | vehicle | 0.30 | 0.959 → 1.000 (0.963) | 0.639 → 0.639 (0.707) | 0.776 → 0.775 (0.807) | 0.503 → 0.500 (0.534) |
|  | animal | 0.40 | 0.853 → 0.818 (0.863) | 0.384 → 0.358 (0.583) | 0.669 → 0.668 (0.708) | 0.506 → 0.501 (0.552) |
| `yolo26s-int8` | person | 0.40 | 0.949 → 0.963 (0.946) | 0.804 → 0.801 (0.847) | 0.900 → 0.901 (0.917) | 0.766 → 0.746 (0.805) |
|  | vehicle | 0.30 | 0.911 → 0.908 (0.917) | 0.762 → 0.810 (0.830) | 0.865 → 0.894 (0.907) | 0.607 → 0.616 (0.660) |
|  | animal | 0.40 | 0.919 → 0.946 (0.939) | 0.675 → 0.702 (0.715) | 0.831 → 0.836 (0.886) | 0.712 → 0.704 (0.774) |
| `yolo26m-int8` | person | 0.40 | 0.943 → 0.951 (0.975) | 0.885 → 0.883 (0.898) | 0.946 → 0.940 (0.952) | 0.807 → 0.813 (0.852) |
|  | vehicle | 0.35 | 0.847 → 0.846 (0.928) | 0.789 → 0.782 (0.789) | 0.894 → 0.892 (0.927) | 0.665 → 0.671 (0.701) |
|  | animal | 0.45 | 0.918 → 0.925 (0.955) | 0.815 → 0.821 (0.848) | 0.909 → 0.917 (0.923) | 0.809 → 0.813 (0.862) |
| `yolo26l-int8` | person | 0.65 | 0.920 → 0.951 (0.997) | 0.816 → 0.834 (0.837) | 0.936 → 0.944 (0.971) | 0.843 → 0.848 (0.879) |
|  | vehicle | 0.50 | 0.974 → 0.958 (0.991) | 0.769 → 0.769 (0.776) | 0.904 → 0.919 (0.923) | 0.666 → 0.674 (0.683) |
|  | animal | 0.50 | 0.919 → 0.912 (0.976) | 0.821 → 0.821 (0.808) | 0.930 → 0.925 (0.956) | 0.837 → 0.833 (0.904) |
| `yolo26n-256-int8` | person | 0.65 | 0.939 → 0.951 (0.942) | 0.117 → 0.148 (0.207) | 0.487 → 0.490 (0.513) | 0.312 → 0.314 (0.338) |
|  | vehicle | 0.50 | 0.955 → 1.000 (1.000) | 0.143 → 0.143 (0.156) | 0.429 → 0.432 (0.405) | 0.187 → 0.192 (0.178) |
|  | animal | 0.50 | – → – (1.000) | 0.000 → 0.000 (0.026) | 0.092 → 0.110 (0.118) | 0.056 → 0.070 (0.086) |
| `yolo26s-256-int8` | person | 0.65 | 0.982 → 0.964 (0.974) | 0.411 → 0.411 (0.482) | 0.699 → 0.700 (0.745) | 0.503 → 0.504 (0.554) |
|  | vehicle | 0.50 | 0.838 → 0.821 (0.871) | 0.456 → 0.469 (0.503) | 0.580 → 0.585 (0.614) | 0.332 → 0.348 (0.388) |
|  | animal | 0.50 | 0.917 → 0.765 (0.857) | 0.073 → 0.086 (0.119) | 0.383 → 0.347 (0.402) | 0.270 → 0.241 (0.284) |
| `yolo26m-256-int8` | person | 0.65 | 0.947 → 0.941 (0.964) | 0.594 → 0.612 (0.610) | 0.801 → 0.810 (0.837) | 0.605 → 0.604 (0.653) |
|  | vehicle | 0.50 | 0.956 → 0.945 (0.955) | 0.592 → 0.585 (0.571) | 0.695 → 0.705 (0.726) | 0.440 → 0.444 (0.474) |
|  | animal | 0.50 | 0.949 → 0.977 (0.932) | 0.245 → 0.278 (0.272) | 0.591 → 0.601 (0.622) | 0.428 → 0.436 (0.471) |
| `yolo26l-256-int8` | person | 0.65 | 0.902 → 0.913 (0.992) | 0.633 → 0.617 (0.638) | 0.785 → 0.791 (0.835) | 0.622 → 0.624 (0.665) |
|  | vehicle | 0.50 | 0.899 → 0.893 (0.959) | 0.605 → 0.626 (0.639) | 0.726 → 0.734 (0.758) | 0.464 → 0.473 (0.498) |
|  | animal | 0.50 | 0.881 → 0.877 (0.918) | 0.344 → 0.377 (0.444) | 0.673 → 0.666 (0.719) | 0.501 → 0.499 (0.546) |
| `yolo26x-int8` | person | 0.65 | 0.994 → 0.997 (0.994) | 0.862 → 0.867 (0.888) | 0.980 → 0.979 (0.983) | 0.889 → 0.890 (0.913) |
|  | vehicle | 0.50 | 1.000 → 0.991 (0.991) | 0.741 → 0.755 (0.755) | 0.943 → 0.946 (0.942) | 0.706 → 0.710 (0.721) |
|  | animal | 0.50 | 0.992 → 0.970 (0.992) | 0.861 → 0.868 (0.868) | 0.972 → 0.963 (0.969) | 0.899 → 0.893 (0.945) |

### COCO val2017 holdout: P / R at the shipped floor, AP50, AP50-95 (old → new; float)

| model | class | floor | P old → new (float) | R old → new (float) | AP50 old → new (float) | AP50-95 old → new (float) |
|---|---|---|---|---|---|---|
| `yolov9m-640-int8` | person | 0.55 | 0.922 → 0.902 (0.917) | 0.587 → 0.579 (0.618) | 0.783 → 0.757 (0.796) | 0.512 → 0.472 (0.596) |
|  | vehicle | 0.40 | 0.864 → 0.857 (0.898) | 0.582 → 0.573 (0.600) | 0.719 → 0.708 (0.760) | 0.419 → 0.375 (0.496) |
|  | animal | 0.70 | 0.976 → 0.976 (0.982) | 0.621 → 0.621 (0.628) | 0.761 → 0.753 (0.749) | 0.572 → 0.551 (0.626) |
| `yolov9s-320-int8` | person | 0.70 | 0.970 → 0.972 (0.972) | 0.310 → 0.306 (0.338) | 0.632 → 0.636 (0.645) | 0.409 → 0.408 (0.433) |
|  | vehicle | 0.45 | 0.948 → 0.946 (0.924) | 0.333 → 0.322 (0.333) | 0.506 → 0.509 (0.520) | 0.290 → 0.292 (0.326) |
|  | animal | 0.40 | 0.936 → 0.936 (0.943) | 0.621 → 0.621 (0.628) | 0.692 → 0.705 (0.702) | 0.523 → 0.529 (0.546) |
| `yolov9m-320-int8` | person | 0.65 | 0.969 → 0.961 (0.964) | 0.414 → 0.415 (0.432) | 0.681 → 0.676 (0.687) | 0.452 → 0.447 (0.482) |
|  | vehicle | 0.40 | 0.920 → 0.933 (0.919) | 0.420 → 0.443 (0.443) | 0.572 → 0.582 (0.582) | 0.325 → 0.326 (0.366) |
|  | animal | 0.45 | 0.972 → 0.972 (0.966) | 0.663 → 0.674 (0.663) | 0.734 → 0.743 (0.737) | 0.567 → 0.575 (0.601) |
| `yolov9s-640-int8` | person | 0.50 | 0.938 → 0.939 (0.922) | 0.548 → 0.558 (0.597) | 0.754 → 0.751 (0.771) | 0.488 → 0.491 (0.565) |
|  | vehicle | 0.30 | 0.853 → 0.852 (0.836) | 0.543 → 0.553 (0.568) | 0.643 → 0.656 (0.670) | 0.371 → 0.376 (0.436) |
|  | animal | 0.55 | 0.960 → 0.960 (0.961) | 0.636 → 0.640 (0.655) | 0.732 → 0.733 (0.721) | 0.552 → 0.560 (0.595) |
| `yolov9t-320-int8` | person | 0.55 | 0.956 → 0.962 (0.965) | 0.268 → 0.267 (0.365) | 0.506 → 0.501 (0.588) | 0.285 → 0.290 (0.377) |
|  | vehicle | 0.40 | 0.896 → 0.912 (0.889) | 0.196 → 0.189 (0.256) | 0.323 → 0.335 (0.400) | 0.168 → 0.168 (0.234) |
|  | animal | 0.30 | 0.923 → 0.903 (0.938) | 0.506 → 0.502 (0.575) | 0.593 → 0.580 (0.629) | 0.394 → 0.393 (0.469) |
| `yolov9t-640-int8` | person | 0.60 | 0.958 → 0.960 (0.949) | 0.366 → 0.358 (0.443) | 0.659 → 0.660 (0.725) | 0.388 → 0.393 (0.503) |
|  | vehicle | 0.55 | 0.949 → 0.939 (0.936) | 0.215 → 0.212 (0.301) | 0.493 → 0.492 (0.573) | 0.255 → 0.259 (0.355) |
|  | animal | 0.55 | 0.969 → 0.962 (0.974) | 0.475 → 0.487 (0.579) | 0.644 → 0.645 (0.682) | 0.451 → 0.449 (0.538) |
| `yolov9c-320-int8` | person | 0.70 | 0.959 → 0.961 (0.961) | 0.396 → 0.388 (0.396) | 0.676 → 0.668 (0.694) | 0.449 → 0.433 (0.490) |
|  | vehicle | 0.50 | 0.964 → 0.958 (0.972) | 0.368 → 0.361 (0.395) | 0.578 → 0.562 (0.597) | 0.337 → 0.307 (0.372) |
|  | animal | 0.25 | 0.958 → 0.942 (0.948) | 0.697 → 0.690 (0.693) | 0.734 → 0.730 (0.722) | 0.569 → 0.549 (0.601) |
| `yolov9c-640-int8` | person | 0.45 | 0.862 → 0.859 (0.897) | 0.662 → 0.655 (0.679) | 0.774 → 0.762 (0.805) | 0.477 → 0.472 (0.603) |
|  | vehicle | 0.40 | 0.823 → 0.821 (0.906) | 0.626 → 0.607 (0.635) | 0.703 → 0.708 (0.758) | 0.376 → 0.383 (0.513) |
|  | animal | 0.30 | 0.900 → 0.882 (0.893) | 0.728 → 0.713 (0.732) | 0.757 → 0.747 (0.766) | 0.559 → 0.555 (0.642) |
| `yolo26n-320-int8` | person | 0.45 | 0.955 → 0.951 (0.951) | 0.304 → 0.290 (0.363) | 0.525 → 0.519 (0.556) | 0.340 → 0.337 (0.368) |
|  | vehicle | 0.55 | 0.953 → 0.982 (0.973) | 0.139 → 0.123 (0.164) | 0.357 → 0.359 (0.387) | 0.220 → 0.221 (0.245) |
|  | animal | 0.35 | 0.885 → 0.903 (0.918) | 0.529 → 0.498 (0.556) | 0.580 → 0.591 (0.640) | 0.438 → 0.446 (0.484) |
| `yolo26s-320-int8` | person | 0.50 | 0.937 → 0.949 (0.948) | 0.353 → 0.360 (0.439) | 0.582 → 0.580 (0.664) | 0.389 → 0.395 (0.455) |
|  | vehicle | 0.55 | 0.879 → 0.906 (0.967) | 0.215 → 0.199 (0.267) | 0.401 → 0.401 (0.523) | 0.257 → 0.251 (0.337) |
|  | animal | 0.45 | 0.895 → 0.865 (0.976) | 0.521 → 0.517 (0.632) | 0.620 → 0.605 (0.719) | 0.461 → 0.450 (0.566) |
| `yolo26m-320-int8` | person | 0.60 | 0.959 → 0.964 (0.958) | 0.430 → 0.428 (0.441) | 0.683 → 0.679 (0.705) | 0.491 → 0.488 (0.510) |
|  | vehicle | 0.40 | 0.884 → 0.872 (0.905) | 0.402 → 0.390 (0.416) | 0.558 → 0.557 (0.587) | 0.356 → 0.352 (0.372) |
|  | animal | 0.30 | 0.827 → 0.858 (0.922) | 0.678 → 0.670 (0.682) | 0.715 → 0.717 (0.735) | 0.576 → 0.571 (0.598) |
| `yolo26l-320-int8` | person | 0.65 | 0.907 → 0.922 (0.962) | 0.425 → 0.427 (0.423) | 0.692 → 0.688 (0.729) | 0.502 → 0.499 (0.529) |
|  | vehicle | 0.50 | 0.919 → 0.918 (0.953) | 0.361 → 0.358 (0.370) | 0.559 → 0.557 (0.610) | 0.377 → 0.376 (0.402) |
|  | animal | 0.50 | 0.881 → 0.866 (0.966) | 0.651 → 0.644 (0.663) | 0.716 → 0.711 (0.747) | 0.586 → 0.583 (0.618) |
| `yolo26n-int8` | person | 0.55 | 0.962 → 0.965 (0.937) | 0.406 → 0.386 (0.462) | 0.707 → 0.703 (0.714) | 0.481 → 0.480 (0.495) |
|  | vehicle | 0.30 | 0.899 → 0.882 (0.861) | 0.409 → 0.409 (0.454) | 0.578 → 0.584 (0.590) | 0.364 → 0.367 (0.376) |
|  | animal | 0.40 | 0.926 → 0.959 (0.932) | 0.625 → 0.621 (0.628) | 0.694 → 0.693 (0.700) | 0.551 → 0.546 (0.558) |
| `yolo26s-int8` | person | 0.40 | 0.894 → 0.899 (0.885) | 0.620 → 0.629 (0.673) | 0.780 → 0.784 (0.793) | 0.562 → 0.566 (0.585) |
|  | vehicle | 0.30 | 0.843 → 0.850 (0.837) | 0.541 → 0.555 (0.573) | 0.681 → 0.681 (0.695) | 0.444 → 0.444 (0.458) |
|  | animal | 0.40 | 0.919 → 0.921 (0.926) | 0.655 → 0.667 (0.667) | 0.742 → 0.733 (0.742) | 0.600 → 0.599 (0.612) |
| `yolo26m-int8` | person | 0.40 | 0.881 → 0.875 (0.898) | 0.679 → 0.681 (0.688) | 0.806 → 0.811 (0.814) | 0.604 → 0.602 (0.617) |
|  | vehicle | 0.35 | 0.839 → 0.849 (0.864) | 0.594 → 0.603 (0.607) | 0.717 → 0.732 (0.741) | 0.482 → 0.489 (0.506) |
|  | animal | 0.45 | 0.937 → 0.921 (0.937) | 0.682 → 0.674 (0.678) | 0.768 → 0.764 (0.766) | 0.625 → 0.618 (0.633) |
| `yolo26l-int8` | person | 0.65 | 0.888 → 0.908 (0.939) | 0.583 → 0.587 (0.567) | 0.803 → 0.811 (0.827) | 0.614 → 0.615 (0.631) |
|  | vehicle | 0.50 | 0.913 → 0.915 (0.947) | 0.525 → 0.543 (0.534) | 0.758 → 0.758 (0.769) | 0.514 → 0.512 (0.524) |
|  | animal | 0.50 | 0.919 → 0.923 (0.967) | 0.697 → 0.686 (0.670) | 0.786 → 0.779 (0.797) | 0.638 → 0.633 (0.657) |
| `yolo26n-256-int8` | person | 0.65 | 0.979 → 0.981 (0.965) | 0.165 → 0.181 (0.241) | 0.484 → 0.481 (0.501) | 0.306 → 0.306 (0.326) |
|  | vehicle | 0.50 | 0.962 → 0.918 (0.957) | 0.116 → 0.128 (0.153) | 0.320 → 0.314 (0.334) | 0.197 → 0.195 (0.211) |
|  | animal | 0.50 | 0.912 → 0.912 (0.947) | 0.356 → 0.398 (0.475) | 0.577 → 0.573 (0.600) | 0.415 → 0.415 (0.436) |
| `yolo26s-256-int8` | person | 0.65 | 0.979 → 0.983 (0.982) | 0.294 → 0.301 (0.336) | 0.573 → 0.586 (0.606) | 0.388 → 0.396 (0.411) |
|  | vehicle | 0.50 | 0.928 → 0.922 (0.943) | 0.205 → 0.215 (0.228) | 0.402 → 0.403 (0.437) | 0.251 → 0.252 (0.276) |
|  | animal | 0.50 | 0.951 → 0.960 (0.959) | 0.525 → 0.552 (0.533) | 0.628 → 0.633 (0.658) | 0.485 → 0.485 (0.505) |
| `yolo26m-256-int8` | person | 0.65 | 0.965 → 0.966 (0.964) | 0.361 → 0.375 (0.380) | 0.632 → 0.636 (0.653) | 0.445 → 0.446 (0.460) |
|  | vehicle | 0.50 | 0.947 → 0.920 (0.930) | 0.285 → 0.288 (0.301) | 0.496 → 0.503 (0.516) | 0.316 → 0.316 (0.329) |
|  | animal | 0.50 | 0.942 → 0.931 (0.988) | 0.617 → 0.621 (0.609) | 0.704 → 0.700 (0.716) | 0.547 → 0.548 (0.570) |
| `yolo26l-256-int8` | person | 0.65 | 0.874 → 0.886 (0.964) | 0.392 → 0.391 (0.402) | 0.620 → 0.624 (0.679) | 0.443 → 0.449 (0.482) |
|  | vehicle | 0.50 | 0.927 → 0.901 (0.980) | 0.317 → 0.331 (0.342) | 0.514 → 0.514 (0.546) | 0.329 → 0.325 (0.350) |
|  | animal | 0.50 | 0.820 → 0.821 (0.960) | 0.628 → 0.617 (0.644) | 0.675 → 0.674 (0.720) | 0.541 → 0.544 (0.583) |
| `yolo26x-int8` | person | 0.65 | 0.938 → 0.941 (0.944) | 0.594 → 0.593 (0.585) | 0.839 → 0.844 (0.845) | 0.643 → 0.645 (0.655) |
|  | vehicle | 0.50 | 0.907 → 0.910 (0.911) | 0.555 → 0.555 (0.562) | 0.774 → 0.777 (0.778) | 0.534 → 0.531 (0.540) |
|  | animal | 0.50 | 0.963 → 0.939 (0.973) | 0.690 → 0.705 (0.701) | 0.805 → 0.807 (0.809) | 0.663 → 0.665 (0.675) |

## Decision and D739 floors

| model | verdict | significant drops (set:class:metric Δ) | D739 floor old → new on the hub set (person / vehicle / animal) |
|---|---|---|---|
| `yolov9m-640-int8` | kept | coco:person:AP50 -0.026; coco:person:AP50-95 -0.040; coco:vehicle:AP50-95 -0.045; coco:animal:AP50-95 -0.021; coco:mean:AP50 -0.015; coco:mean:AP50-95 -0.035; hub:person:AP50-95 -0.058; hub:vehicle:AP50-95 -0.058; hub:animal:AP50-95 -0.062; hub:mean:AP50-95 -0.059 | 0.50→0.50 / 0.35→0.45 / 0.35→0.35 |
| `yolov9s-320-int8` | **replaced** | – | 0.50→0.50 / 0.35→0.35 / 0.35→0.35 |
| `yolov9m-320-int8` | **replaced** | – | 0.60→0.60 / 0.35→0.45 / 0.50→0.45 |
| `yolov9s-640-int8` | **replaced** | – | 0.50→0.50 / 0.35→0.35 / 0.40→0.35 |
| `yolov9t-320-int8` | **replaced** | – | 0.50→0.50 / 0.50→0.50 / 0.35→0.35 |
| `yolov9t-640-int8` | kept | hub:animal:AP50-95 -0.019 | 0.50→0.50 / 0.35→0.35 / 0.35→0.35 |
| `yolov9c-320-int8` | kept | coco:person:AP50-95 -0.015; coco:vehicle:AP50-95 -0.029; coco:animal:AP50-95 -0.020; coco:mean:AP50 -0.009; coco:mean:AP50-95 -0.021; hub:person:AP50-95 -0.020; hub:vehicle:AP50-95 -0.031; hub:animal:AP50-95 -0.038; hub:mean:AP50-95 -0.030 | 0.60→0.50 / 0.50→0.45 / 0.35→0.35 |
| `yolov9c-640-int8` | kept | coco:person:AP50 -0.013; coco:animal:AP50 -0.009 | 0.50→0.50 / 0.45→0.55 / 0.35→0.35 |
| `yolo26n-320-int8` | **replaced** | – | 0.50→0.50 / 0.35→0.35 / 0.35→0.35 |
| `yolo26s-320-int8` | kept | coco:animal:AP50 -0.014; coco:animal:AP50-95 -0.012 | 0.50→0.50 / 0.45→0.40 / 0.35→0.35 |
| `yolo26m-320-int8` | kept | hub:person:AP50 -0.014; hub:person:AP50-95 -0.015 | 0.55→0.50 / 0.60→0.60 / 0.35→0.35 |
| `yolo26l-320-int8` | kept | hub:vehicle:AP50 -0.013; hub:animal:AP50-95 -0.035; hub:mean:AP50 -0.017; hub:mean:AP50-95 -0.018 | 0.75→0.70 / 0.55→0.55 / 0.40→0.45 |
| `yolo26n-int8` | **replaced** | – | 0.55→0.50 / 0.35→0.35 / 0.35→0.35 |
| `yolo26s-int8` | kept | hub:person:AP50-95 -0.021 | 0.50→0.50 / 0.40→0.40 / 0.35→0.35 |
| `yolo26m-int8` | **replaced** | – | 0.55→0.50 / 0.55→0.50 / 0.45→0.45 |
| `yolo26l-int8` | **replaced** | – | 0.75→0.70 / 0.45→0.55 / 0.50→0.45 |
| `yolo26n-256-int8` | **replaced** | – | 0.50→0.50 / 0.35→0.35 / 0.35→0.35 |
| `yolo26s-256-int8` | **replaced** | – | 0.50→0.50 / 0.65→0.65 / 0.35→0.35 |
| `yolo26m-256-int8` | **replaced** | – | 0.65→0.65 / 0.50→0.55 / 0.35→0.35 |
| `yolo26l-256-int8` | **replaced** | – | 0.70→0.75 / 0.65→0.65 / 0.40→0.40 |
| `yolo26x-int8` | **replaced** | – | 0.50→0.50 / 0.50→0.45 / 0.35→0.35 |

