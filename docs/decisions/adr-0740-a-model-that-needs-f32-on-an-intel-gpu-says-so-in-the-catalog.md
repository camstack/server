---
id: D740
title: A model that needs f32 on an Intel GPU says so in its catalog entry, and the pool applies it on the GPU only
status: accepted
date: 2026-10-07
supersedes:
applies-to:
  - packages/addon-pipeline/python/inference_pool.py
  - packages/addon-pipeline/src/detection-pipeline/registry/model-catalogs.ts
  - packages/addon-pipeline/src/detection-pipeline/engine/engine-factory.ts
---

## Context

The detector measurement of 2026-10-07 found that some YOLO26 base FP32
OpenVINO IRs give no valid output on an Intel GPU. This happened on both the
Core Ultra iGPU of the hub and the N100's UHD iGPU:

- `yolo26s` (640): 0 true and 146 false positives on 409 frames.
- `yolo26m` and `yolo26m-320`: NaN scores.

The same IRs are correct on the CPU and on the NPU. Forcing f32 on the GPU
fixes them: `yolo26s` on the iGPU at f32 reaches person P 0.996 / R 0.785,
identical to the CPU, at about 60% more latency. `yolo26n`, `yolo26n-320`
and `yolo26s-320` were measured correct at the GPU default. So were every
INT8 IR and every YOLOv9 IR.

The pool never set an inference precision. An Intel GPU runs an FP32 IR at
f16 by default, and nothing in the pool or the logs showed that the precision
was the cause. A detector that finds nothing looks the same as a quiet
camera.

The same run measured the NPU with OpenVINO 2025.4. Every YOLO26 IR now
compiles and runs there, and the catalog comments claiming "the NPU rejects
YOLO26" were stale. The base IRs match the CPU (`yolo26s` P 0.996 / R 0.788).
The INT8 IRs lose recall: `yolo26s-int8` 0.58 against 0.70 on CPU and iGPU,
`yolo26m-int8` 0.78 against 0.83.

## Decision

**The precision requirement is catalog data.** `ModelCatalogEntry.gpuInferencePrecision`
(`'f32' | 'f16'`) flows from the engine factory through
`PoolModelConfig.gpuInferencePrecision` to the wire key of the same name.
The Python pool turns it into `INFERENCE_PRECISION_HINT` only when all three
hold:

- the compile candidate is a GPU (`GPU`, `GPU.n`);
- the device lists the key in `SUPPORTED_PROPERTIES`;
- the value is one it knows.

A rejected property would make the failover loop push the model onto the
next device, so the pool never sends one the device does not list. The
compile line reports `inferencePrecision=`. A model that needs a precision
the GPU does not offer gets a WARNING. The pool never matches on model names.

**The f32 list is the measured failures, plus the same pattern where it is
unmeasured.** Measured: `yolo26s`, `yolo26m`, `yolo26m-320`. Unmeasured but
listed: tier m/l/x at any input, tier s at 640, and the seg builds of those
tiers. On the GPU, f32 costs latency, while f16 risks a detector that
silently finds nothing. The models measured correct are not listed, so they
keep full speed.

**YOLO26 is eligible on the NPU.** No placement or eligibility logic
excluded it. The claim lived only in comments and model descriptions, and
those are corrected. The INT8 descriptions now say they lose recall on the
NPU and that the base IR is the one to run there. The NPU default stays
`yolov9m-320-int8`. Changing a default is not part of this record.

## Consequences

- A camera an operator pins to `yolo26s`, `yolo26m` or `yolo26m-320` on an
  Intel iGPU starts detecting after `addon-pipeline` is deployed. Every
  listed model then runs about 60% slower on the GPU than it did while it was
  broken.
- OpenVINO's compiled-blob cache is keyed by the compile properties, so the
  f32 compile has its own cache entry and does not reuse a stale f16 blob.
- Nothing changes for any model in use on this hub. They are all YOLOv9 or
  INT8, and none is listed.
- The same measurement found that the YOLO26 Core ML packages abort at model
  load on an M3 Pro (macOS 26.2). That is not addressed here.

## Enforcement

- `python/test_inference_pool_ov_precision.py` checks that the hint is sent:
  - only for a GPU;
  - only when the model asks;
  - only when the device lists the key;
  - only for a known value.
- `engine/__tests__/gpu-inference-precision.spec.ts` checks:
  - the measured-broken and measured-correct entries;
  - that no INT8 or YOLOv9 entry is listed;
  - that every listed id is a catalog entry;
  - the pool config and the serialized wire key.
- Both were seen to fail with the fix disarmed.
