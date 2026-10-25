---
id: D818
title: INT8 keeps the YOLO Detect head in float — its decode for a DFL head, all of it for an end-to-end head
status: accepted
date: 2026-10-09
supersedes:
applies-to:
  - packages/addon-model-studio/python/convert_lib.py
  - scripts/build-camstack-models.py
---

## Context

The hosted OpenVINO INT8 YOLO IRs lost 0.03–0.17 mAP50-95 against their float
base (docs/benchmarks/2026-10-08-int8-recalibration.md). The fleet's live
`yolov9m-640-int8` lost 0.07 on COCO and 0.11 on the hub's own frames, while its
mAP50 lost only about 0.01. `convert_lib.quantize_openvino_int8` called
`nncf.quantize` with every default: preset PERFORMANCE, fast bias correction,
no ignored scope.

That put FakeQuantize on the Detect head's own arithmetic: the DFL softmax and
the box decode (`/model.22/Sub`, `Add_1`, `Sub_1`, `Div_1`). Box coordinates
landed on a 256-level grid before the stride multiply, 2.5–10 px per step at
640.

We tried the first thing the previous study suggested — re-calibrating with
the runtime's centred letterbox. It did not move the loss.
`quantize_with_accuracy_control` was unreliable:

- With output-NMSE ranking on `yolov9s-320`, it reverted backbone convs and
  left the drop at 0.020.
- With metric ranking on `yolov9s-320`, it did find the decode, after 75
  minutes, and ended below the fixed scope.
- With metric ranking on `yolov9m-640`, its ranking picked `/model.0` to
  `/model.2`, and the drop stayed at 0.12.

## Decision

For an Ultralytics detector, `quantize_openvino_int8` quantises with
`preset=MIXED`, `fast_bias_correction=False`, and an ignored scope over the
Detect head. The head is the module holding the graph's last `Sigmoid`, and
only if it also holds the box branch (`cv2.*` or `one2one_cv2.*`).

- **DFL head (YOLOv9):** only the head's own ops and the DFL stay float. The
  patterns are `/model.N/[^/]+$` and `/model.N/dfl/`. Its conv branches stay
  INT8.
- **End-to-end head (YOLO26, with `one2one_*` branches):** the whole head stays
  float, `/model.N/`.
- **No Ultralytics head:** the model keeps NNCF's defaults, as before. The
  recipe is unmeasured there.

This is the Ultralytics exporter's scope and preset, plus NNCF's YOLO26
example (full bias correction, the one2one head float).

## Consequences

**YOLOv9, every model:**

- INT8 is within noise of float on both evaluation sets.
- `yolov9m-640`: 0.503 → 0.571 mAP50-95 on COCO (float 0.573), 0.632 → 0.748
  on hub frames (float 0.744). On the real hub NPU it gains +0.070.
- The `.bin` size is unchanged.
- Latency on the NPU is unchanged.
- On the iGPU the float decode costs a near-fixed ~0.2–0.7 ms. For the small
  models that is 8–15 %. `yolov9s-320`'s own device, the N100 iGPU, measured
  +5.5 %.

**YOLO26:** INT8 recovers 0.007–0.037 mAP50-95. The float head adds 15–21 % to
the `.bin`, 0–6 % NPU latency and 2–22 % iGPU latency. The build script and the
benchmark list which IRs carry which recipe. Seven kept the old one, where the
iGPU cost exceeded 10 %.

**Where the recipe applies:** Model Studio's runtime `model-convert` uses the
same function, so user-trained YOLO models get the recipe too.

**NNCF prefix matching:** NNCF matches ignored-scope patterns with `re.match`,
which is a prefix match. An unanchored `/model.22/.*` therefore also keeps the
conv branches float. That costs about 11 % NPU latency on `yolov9m-640` and
buys little accuracy.

## Enforcement

`packages/addon-model-studio/python/__tests__/test_int8_recipe.py` pins three
things:

- the head detection;
- what each pattern does and does not match;
- the end-to-end rule.

A study IR and the build script's output were compared bit for bit (identical
`.bin`). Accuracy is checked by `scripts/eval/evaluate_variants.py`, re-run per
docs/benchmarks/2026-10-09-int8-recipe.md before any mirror replacement.
