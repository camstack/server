---
id: D910
title: An OpenVINO GPU/NPU model is compiled once in a child before the pool loads it, and a benchmark never loads into the live pool
status: accepted
date: 2026-10-22
supersedes:
applies-to:
  - packages/addon-pipeline/python/openvino_compile_probe.py
  - packages/addon-pipeline/python/inference_pool.py
  - packages/addon-pipeline/src/detection-pipeline/engine/benchmark-pools.ts
  - packages/addon-pipeline/src/detection-pipeline/provider.ts
---

## Context

On 2026-10-22 09:10 UTC the hub's `openvino:gpu` pool worker (Core Ultra 7
265K, Arrow Lake iGPU, OpenVINO 2025.4.1, IGC 2.11) died with SIGSEGV three
times in 15 s (`malloc(): unsorted double linked list corrupted`, then
`longjmp causes uninitialized stack frame`). Each death was a
`benchmark.runPipelineTest` loading `yolov9m-320-int8` into the LIVE worker;
fresh workers holding no model died on the same load. Every `openvino:gpu`
SIGSEGV of October falls inside a benchmark model load, the prod
`yolov9m-640-int8` included. Warm loads (cache blob present, 92-387 ms) never
crashed: the fault is the iGPU compiler, on a cold compile.

`compile_model` runs on the `ModelLoader` thread (D653) of the same process as
the predict threads, so a native crash is the whole worker, and the respawn
goes straight back into the same load. Each death cost camera 101 its
detection and clip embeddings until the respawn. Python cannot catch a
SIGSEGV; D742 solved the same shape for Core ML with a probe child.

Two causes, so two rules: the compiler can crash, and the likeliest compile to
be cold is a benchmark's, which was running inside the pool that serves
cameras.

## Decision

1. **A cold GPU/NPU compile happens in a child first.** Before the pool
   compiles a (model, device request, compile config) whose blob is not known
   to be on disk, `openvino_compile_probe.py` runs the pool's own `_load_model`
   in a throwaway interpreter: same PrePostProcessor, candidate list,
   properties and `CACHE_DIR`, so the pool then loads from the cache. A child
   killed by a signal refuses the model on that device with
   `reason: "native-load-crashed"` (the CoreML vocabulary,
   `OpenvinoLoadCrashed`), remembered in `.ov-cache/<stem>.<device>.ovprobe.json`
   keyed on the model files, the compile-relevant config, and the OpenVINO
   build; the worker survives. A Python failure, a start failure or the
   300 s bound is inconclusive and remembered nowhere: the in-process load runs
   as before. CPU-only loads are never probed.
2. **A benchmark never loads into the live pool.** A one-shot image call (no
   camera, no live frame, no replay) goes to a separate pool per device
   (`benchmark-pools.ts`), built on first use, reused by the next benchmark
   call so the timed runs still measure a warm model on the same device, and
   reclaimed after 5 min idle. It is outside `factoriesByDevice`: its death
   is not charged to the device's restart budget, and a model it could not
   load is tracked under `bench:<deviceKey>`, so it is not backed off or
   refused on the live device.

## Consequences

- The first load of each key costs one interpreter start and one cached load
  (about 1-2 s plus the compile itself, once); keys compiled before this change
  have no verdict and are probed once, warm.
- Wiping `.ov-cache` re-probes (the verdict is valid only while the blobs its
  probe wrote exist).
- A benchmark holds a second worker (RAM) for up to 5 min after its last call,
  and its first call pays a pool spawn plus a (cached) load.
- The capacity ramp and the synthetic bench send raw frames, so they still use
  the live pool; routing them is open.
- Memory: a probe child compiling a large model briefly adds its RSS to the
  hub next to the live worker.

## Enforcement

`test_openvino_compile_probe.py` (a real child that SIGSEGVs is `crashed`; a
crashed model never reaches `compile_model`; the reply carries
`native-load-crashed`), `benchmark-never-loads-into-live-pool.spec.ts` and
`engine/__tests__/benchmark-pools.spec.ts`.
