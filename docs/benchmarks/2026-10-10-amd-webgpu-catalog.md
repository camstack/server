# AMD WebGPU catalog sweep — 2026-10-10

covers:
  - packages/addon-pipeline/python/inference_pool.py
  - packages/addon-pipeline/src/detection-pipeline/registry/model-catalogs.ts
applies-to:
  - packages/addon-pipeline/python/inference_pool.py
last-verified: 2026-10-23

> **Re-measured 2026-10-23 (D845 in place).** The `amd-phoenix/amd-igpu`
> column of `detector-latency.json` now holds GPU numbers from
> `scripts/bench-detector-latency-column.mjs` (1 cold + 3 warm, median),
> with the agent container's `/dev/dri/renderD128` owned by `camstack`
> (probe: `render-node=ok`, `WebGpuExecutionProvider`, raw `session.run`
> p50 12.5 ms t-320 and 161 ms m-640, `gpu_busy_percent` 20-38 % during the
> run). Old to new p50 (ms): t-320 188 to 40, t-640 671 to 89, s-320 401 to
> 65, s-640 1434 to 125, m-320 1076 to 85, m-640 shed to 228 (no longer
> sheds). The 188 ms of 2026-10-10 was slower than the ONNX CPU column (24
> ms), which is how the software path shows in the table. The step figures
> include pool overhead (decode, IPC, postprocess) on a node with live
> cameras, hence above the raw session times.

> **Superseded for latency (2026-10-13).** Every number on this page was
> measured while the pool's WebGPU children could not open
> `/dev/dri/renderD128` (the entrypoint dropped the render group) and Dawn
> served them from a software path while still reporting
> `WebGpuExecutionProvider` — yolov9t-320 ran at 224 ms where the GPU does
> 13 ms. The load/compatibility matrix (which models load) still holds; the
> latencies, the "~1 fps" verdicts and the D823 premise do not. See
> [2026-10-13-phoenix-npu-and-igpu.md](2026-10-13-phoenix-npu-and-igpu.md)
> and D845.

Node: `agent-b` (Ryzen 7640HS, Radeon 760M gfx1103). Device:
`onnx:webgpu` (ORT WebGPU EP + RADV). Method: each model alone via
`benchmark.runPipelineTest` + `referenceImage=3-persons.jpg`, then
`nodes.restartAddon({ addonId: 'detection-pipeline' })` to recycle the pool
before the next model. Raw rows:
`scratchpad/amd-webgpu-catalog-results.json`.

## Verdict

| Question | Answer |
| --- | --- |
| Which catalog ONNX models **load and run alone** on WebGPU? | **All 32** probed (every OD yolo26/yolov9 variant with an onnx build, plus face/plate/package/classifiers/segmentation). |
| CLIP / SigLIP? | **No onnx build** — not offered on `onnx:webgpu`. |
| Audio (`yamnet-onnx`)? | Not probed (audio plane). |
| Full live tree (OD + crop children) on WebGPU? | **Yes after D823** — one OS process per WebGPU model (`webgpu_isolated.py`). Same-process multi-session still SIGSEGVs (EP/driver limit). |

## Multi-session: process isolation (D823)

Loading a second ONNX WebGPU session **in the same Python process** still
kills the worker (`signal=SIGSEGV`). Spike 2026-10-10: two OS processes with
one session each load and infer concurrently.

**Fix (pool):** `device=webgpu` never builds an ORT session in the pool
parent. Each WebGPU `ModelSlot` is a `WebGpuIsolatedSession` child. OpenVINO /
CoreML / classic ONNX stay in-process.

**Live verify (2026-10-10):** `yolo26n` + child `yunet-2023mar` on
`agent-b` / `onnx:webgpu`, two consecutive `runPipelineTest` without pool
recycle — `kind:frame`, 3 detections, no SIGSEGV
(`scratchpad/amd-webgpu-multisession-verify.mjs`).

### Availability

- **Root OD + crop children** on `onnx:webgpu`: supported (one child process
  per model; RAM scales with the tree).
- Prefer t/s @320 for latency (cold table below). `jumpDeviceKey` to CPU is
  optional, not required for multi-step trees.

## Cold single-run latency (first frame after pool recycle)

`inferMs` from `detections[0].debug.stepLatencyMs` when present. Rows with
`det=0` still returned `kind:frame` — for large m/l/c-640 the first call was
sometimes `shed: deadline-expired` after ~3 s (shader compile); treat those
cells as “loads, needs warm” not as a p50.

### Object detection

| modelId | inferMs (cold) | detections |
| --- | ---: | ---: |
| yolo26n | 580 | 3 |
| yolo26s | 1354 | 3 |
| yolo26m | — (shed) | 0 |
| yolo26l | — (shed) | 0 |
| yolo26n-seg | 812 | 3 |
| yolo26s-seg | 1783 | 3 |
| yolo26m-seg | — | 0 |
| yolo26n-320 | 278 | 3 |
| yolo26n-256 | 203 | 3 |
| yolo26s-320 | 441 | 3 |
| yolo26s-256 | 308 | 3 |
| yolo26m-320 | 1051 | 3 |
| yolo26m-256 | 704 | 3 |
| yolo26l-320 | 1280 | 3 |
| yolo26l-256 | 871 | 3 |
| yolov9t-320 | 273 | 3 |
| yolov9t-640 | 792 | 3 |
| yolov9s-320 | 488 | 3 |
| yolov9s-640 | 1559 | 3 |
| yolov9m-320 | 1541 | 3 |
| yolov9m-640 | — (shed) | 0 |
| yolov9c-320 | 1430 | 3 |
| yolov9c-640 | — (shed) | 0 |

### Other onnx steps (alone)

| stepId | modelId | inferMs (cold) |
| --- | --- | ---: |
| face-detection | yunet-2023mar | 754 |
| face-embedding | auraface-r100 | 1999 |
| plate-detection | yolox-tiny-plate | — |
| plate-ocr | cct-s-v2-global | 1001 |
| package-detection | rfdetr-package | — |
| animal-classifier | animal-classifier | 419 |
| bird-classifier | bird-classifier | 433 |
| vehicle-classifier | vehicle-type-v1 | 375 |
| segmentation | u2netp | — |

## Warm single-request p50 (yolov9, 2026-10-10)

Median of 3 warm runs after one cold (same recycle method). Written into
`detector-latency.json` → `amd-phoenix/amd-igpu` and `DETECTOR_PERF`.

| modelId | cold ms | warm p50 ms | fps (≈1000/p50) |
| --- | ---: | ---: | ---: |
| yolov9t-320 | 266 | 192 | 5 |
| yolov9t-640 | 760 | 660 | 2 |
| yolov9s-320 | 491 | 401 | 2 |
| yolov9s-640 | 1529 | 1410 | 1 |
| yolov9m-320 | 1264 | 1059 | 1 |
| yolov9m-640 | shed@3000 | shed@3000 | — |

Concurrent / capacity-ramp and the `x86-cpu` column remain open. Default OD
for `amd-igpu` is now `yolov9t-320` (was `yolov9m-320`).
