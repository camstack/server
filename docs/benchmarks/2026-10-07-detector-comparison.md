# Object detectors × hardware — measured comparison

Measured on 2026-10-07 on a live CamStack cluster: a hub with an Intel Core Ultra 7 265K (NPU "AI Boost", Intel iGPU, 20-core CPU, a Coral USB Edge TPU), an agent on an Intel N100 (UHD iGPU, 4 cores), a Mac mini M2 agent, and an M3 Pro laptop standing in for "Apple Silicon" where the Mac mini could not be measured.

## How it was measured

- **Frames**: 409 real frames from 28 cameras (960×540 scene frames of tracked objects plus 95 motion snapshots; 115 night/IR frames; mixed indoor, outdoor, parking).
- **Ground truth**: two large reference detectors (YOLO26-X at 1280 px and RT-DETR-X at 640 px) are run on every frame; an object counts when both agree (or one is very confident). Uncertain boxes are "don't care". This is a pseudo ground truth — good for ranking models and setting floors, not an absolute mAP.
- **Pipeline-identical decode**: every candidate runs through CamStack's own preprocessing (downscale to the model's content size, letterbox with grey padding) and its own YOLO/SSD decoder and NMS (pool floor 0.05, IoU 0.45). OpenVINO models are compiled exactly as the inference pool does (uint8 input with the /255 folded into the graph, `PERFORMANCE_HINT=LATENCY`, device-default precision).
- **Production reference**: `yolov9m-320-int8` with floors person 0.65 / vehicle 0.50 / animal 0.50 (the current default root).
- **Latency**: single-request p50 over 40 calls after warm-up on a fixed 960×540 frame (inference only: no decode, no IPC), plus throughput with 4 requests in flight for 2 s ("fps"). Runs were short and interleaved with live detection on the same accelerators.
- **Load during measurement**: hub load average ≈ 6 on 20 cores with 1–2 cameras detecting on the NPU/iGPU; N100 load average 6–19 on 4 cores (CI jobs were running) — **the N100 CPU column is pessimistic by roughly 2–4×** and its iGPU column is somewhat affected; M3 Pro load ≈ 6–9 on 12 cores (the YOLO26 Core ML cells marked ‡ were measured later the same day at load 7–29, see (e); the YOLOv9 Core ML cells marked § are the FP16 packages, measured after D743 at load 7–9, see (f)).

## (a) Latency matrix — p50 ms / fps (4 in flight)

INT8 rows are the OpenVINO INT8 IR. Plain rows are the catalog's base model: OpenVINO FP16 IR (YOLOv9) or FP32 IR (YOLO26) on NPU/iGPU, ONNX FP32 on CPU, Core ML on Apple. "4 thr" = OpenVINO/ONNX Runtime limited to 4 threads. ✗ = compiles and runs fast but produces no usable detections (see notes). For CPU and Apple single-request columns, fps = 1000 / p50.

| model | Hub NPU | Hub iGPU | Hub CPU (4 thr) | N100 iGPU | N100 CPU (4 thr, contended) | M3 Pro CoreML ALL | M3 Pro CoreML CPU | M3 Pro ONNX CPU | Coral USB |
|---|---|---|---|---|---|---|---|---|---|
| yolov9t-320 | 2.9 / 383 | 2.6 / 405 | 6.9 / 145 | 15.0 / 48 | 86.2 / 12 | 1.1 / 952 § | 7.5 / 133 § | 10.3 / 97 | — |
| yolov9t-320-int8 | 3.8 / 333 | 2.8 / 324 | 2.7 / 405 | 14.1 / 67 | 52.7 / 20 | — | — | — | — |
| yolov9t-640 | 7.4 / 139 | 6.5 / 157 | 23.0 / 44 | 38.5 / 26 | 322.1 / 3 | 3.0 / 333 § | 27.0 / 37 § | 39.5 / 25 | — |
| yolov9t-640-int8 | 7.5 / 144 | 5.6 / 185 | 8.8 / 124 | 33.1 / 33 | 205.6 / 5 | — | — | — | — |
| yolov9s-320 | 4.4 / 241 | 4.6 / 200 | 15.8 / 63 | 41.4 / 24 | 164.4 / 6 | 1.5 / 667 § | 13.7 / 73 § | 29.2 / 34 | — |
| yolov9s-320-int8 | 4.1 / 264 | 4.1 / 239 | 6.5 / 180 | 23.3 / 34 | 86.9 / 12 | — | — | — | — |
| yolov9s-640 | 12.7 / 82 | 15.2 / 69 | 58.2 / 17 | 127.4 / 8 | 341.3 / 3 | 5.1 / 196 § | 42.4 / 24 § | 98.4 / 10 | — |
| yolov9s-640-int8 | 10.7 / 99 | 10.5 / 99 | 20.1 / 52 | 92.9 / 11 | 185.3 / 5 | — | — | — | — |
| yolov9m-320 | 8.4 / 123 | 11.4 / 88 | 40.0 / 25 | 63.5 / 16 | 166.8 / 6 | 3.2 / 312 § | 27.2 / 37 § | 66.2 / 15 | — |
| yolov9m-320-int8 | 6.5 / 165 | 7.0 / 127 | 14.2 / 74 | 39.4 / 26 | 226.3 / 4 | — | — | — | — |
| yolov9m-640 | 29.5 / 32 | 40.0 / 25 | 155.8 / 6 | 215.5 / 5 | 663.5 / 2 | 10.2 / 98 § | 86.9 / 12 § | 252.7 / 4 | — |
| yolov9m-640-int8 | 19.5 / 52 | 23.5 / 44 | 52.4 / 19 | 139.1 / 7 | 324.4 / 3 | — | — | — | — |
| yolov9c-320 | 9.9 / 103 | 15.0 / 67 | 49.8 / 20 | 130.5 / 10 | 216.6 / 5 | 3.9 / 256 § | 28.7 / 35 § | 95.5 / 10 | — |
| yolov9c-320-int8 | 7.4 / 141 | 10.7 / 94 | 16.9 / 62 | 51.2 / 20 | 109.1 / 9 | — | — | — | — |
| yolov9c-640 | 35.8 / 27 | 53.7 / 19 | 199.5 / 5 | 263.4 / 4 | 851.9 / 1 | 12.1 / 83 § | 103.1 / 10 § | 327.7 / 3 | — |
| yolov9c-640-int8 | 24.2 / 41 | 36.4 / 28 | 66.2 / 15 | 188.9 / 5 | 458.6 / 2 | — | — | — | — |
| yolo26n-320 | 3.5 / 308 | 6.9 / 125 | 5.0 / 202 | 33.2 / 30 | 14.9 / 67 | 1.0 / 971 ‡ | 5.7 / 175 ‡ | 8.7 / 115 | — |
| yolo26n-320-int8 | 4.0 / 294 | 4.5 / 190 | 1.9 / 536 | 28.8 / 35 | 11.4 / 83 | — | — | — | — |
| yolo26n | 7.4 / 139 | 12.2 / 71 | 14.9 / 67 | 57.9 / 17 | 64.4 / 16 | 3.6 / 279 ‡ | 17.4 / 57 ‡ | 24.7 / 40 | — |
| yolo26n-int8 | 7.4 / 143 | 7.5 / 116 | 7.0 / 152 | 87.8 / 16 | 42.8 / 21 | — | — | — | — |
| yolo26s-320 | 5.4 / 193 | 10.4 / 82 | 12.3 / 81 | 69.3 / 18 | 174.2 / 6 | 1.9 / 526 ‡ | 10.8 / 92 ‡ | 21.4 / 47 | — |
| yolo26s-320-int8 | 4.6 / 243 | 5.7 / 150 | 4.7 / 217 | 34.4 / 28 | 98.3 / 14 | — | — | — | — |
| yolo26s | 13.1 / 77 | 24.6 / 36 ✗ no valid output | 44.7 / 22 | 104.1 / 10 ✗ no valid output | 840.6 / 1 | 5.7 / 176 ‡ | 33.0 / 30 ‡ | 73.0 / 14 | — |
| yolo26s-int8 | 10.2 / 100 | 11.8 / 75 | 17.0 / 60 | 129.9 / 10 | 436.2 / 2 | — | — | — | — |
| yolo26m-320 | 8.9 / 116 | 22.4 / 40 ✗ no valid output | 34.0 / 29 | 113.9 / 9 ✗ no valid output | 367.7 / 3 | 3.2 / 308 ‡ | 20.6 / 49 ‡ | 67.3 / 15 | — |
| yolo26m-320-int8 | 6.7 / 154 | 8.4 / 102 | 11.6 / 81 | 53.4 / 18 | 174.2 / 6 | — | — | — | — |
| yolo26m | 28.2 / 35 | 64.7 / 17 ✗ no valid output | 133.6 / 8 | 285.9 / 4 ✗ no valid output | 1698.0 / 1 | 12.4 / 81 ‡ | 74.7 / 13 ‡ | 221.0 / 5 | — |
| yolo26m-int8 | 19.7 / 49 | 23.1 / 39 | 44.4 / 23 | 142.7 / 7 | 817.6 / 1 | — | — | — | — |
| ssd-mobilenet-v2-coco-edgetpu | — | — | — | — | — | — | — | — | 10.5 / 95 |

**Through the pipeline** (the benchmark addon's synthetic bench via the hub API, one cached frame, same model — includes the pool's preprocessing and, for a remote node, frame transfer):

| node / device | model | model time (predict) | per-call p50 | throughput |
|---|---|---|---|---|
| Mac mini M2, Core ML (`all` → GPU: the FP32 package, before D743), 1 camera live on it | yolov9m-320 | 16.5 ms | 18.4 ms | 47 fps (1 in flight), 70 fps (4 in flight) |
| Mac mini M2, Core ML FP16 (`all` → Neural Engine, after D743), 13 cameras live on it | yolov9m-320 | 3.8 ms | 5.7 ms | 159 fps (1 in flight), 298 fps (4 in flight) |
| Mac mini M2, Core ML FP16, same run | yolov9m-640 | 10.3 ms | 13.1 ms | 71 fps (1 in flight), 101 fps (4 in flight) |
| Mac mini M2, Core ML FP16, same run | yolov9s-640 | 5.5 ms | 8.2 ms | 111 fps (1 in flight), 224 fps (4 in flight) |
| Mac mini M2, Core ML FP16, same run | yolov9t-640 | 3.5 ms | 6.0 ms | 149 fps (1 in flight), 318 fps (4 in flight) |
| Hub NPU | yolov9m-320-int8 | 10.2 ms | 21.4 ms | 46 fps |
| Hub iGPU | yolov9m-320-int8 | 10.1 ms | 21.0 ms | 47 fps |
| N100 iGPU (remote agent) | yolov9m-320-int8 | 48.3 ms | 221 ms | 4 fps (frame shipped across the network per call) |

The FP32 row is the first run, when the Mac mini only had `yolov9m-320` downloaded. The FP16 rows are the evening run (benchmark addon synthetic bench through the pipeline pool, median of 3 passes, the Neural Engine shared with 13 live cameras, `yolov9m-640` / `s-640` / `t-640` downloaded for it). On the Neural Engine an M2 measured ≈1.0–1.2× the M3 Pro (measured), so the M3 Pro columns stand for both; `docs/benchmarks/detector-latency.json` carries the M2 cells measured and the rest as M3 Pro × 1.2.

Notes on the matrix:

- **YOLO26 base (FP32 IR) on Intel iGPU is broken for `yolo26s`, `yolo26m`, `yolo26m-320`** at the GPU's default FP16 inference precision — on both the Core Ultra iGPU and the N100: zero valid detections (`yolo26s`: 0 true / 146 false positives on the set; `yolo26m*`: NaN scores). Forcing FP32 precision fixes it (`yolo26s` on iGPU at f32: person P 0.996 / R 0.785, identical to CPU) at ~60 % more latency. `yolo26n` and `yolo26s-320` base are fine on the iGPU. All INT8 IRs are fine on the iGPU.
- **YOLO26 now compiles and runs on the Intel NPU** (OpenVINO 2025.4): the base FP32 IR on the NPU matches CPU accuracy exactly (`yolo26s` NPU: P 0.996 / R 0.788). The INT8 IRs on the NPU lose recall: `yolo26s-int8` R 0.58 on NPU vs 0.70 on CPU/iGPU; `yolo26m-int8` R 0.78 vs 0.83.
- **YOLOv9 INT8 on the NPU is equivalent to CPU** (production root: P/R/AP50 within ±0.02 across NPU, iGPU f16, iGPU f32, CPU f32).
- On the NPU, INT8 is only faster for the m/c tiers (e.g. `yolov9m-640`: 19.5 ms INT8 vs 29.5 ms FP16); for t/s the FP16 IR is as fast or faster.
- **x86 CPU: always prefer the OpenVINO INT8 IR** — 2.5–3× faster than ONNX FP32 at the same accuracy class. **ARM CPU: never use OpenVINO INT8 IRs** (on Apple M-series CPU they run 7–14× slower than ONNX FP32 and give garbage at the default FP16 precision); use ONNX/Core ML.
- **YOLO26 Core ML** (‡ cells): the reduced packages aborted at load until they were re-exported static (D742); measured afterwards, see (e). They run on the **Neural Engine**.
- **YOLOv9 Core ML** (§ cells): the packages were FP32 mlprograms (77 MB for `yolov9m-320`, the size of the ONNX), which the Neural Engine cannot run: `CPU_AND_NE` ran them at CPU speed and `ALL` put them on the GPU (`yolov9m-320` 9.1 ms, `yolov9m-640` 24.1 ms). They were re-exported FP16 and replaced in place (D743); the FP16 packages run on the Neural Engine, 2.5–5× faster, see (f). The Mac mini row above was measured with the FP32 package, on the GPU.
- Coral USB on the hub: 10.5 ms per frame (≈95 fps, one Coral), measured on the same 409 frames for accuracy.
- Compile time (first load; the NPU driver may have served some from its blob cache): NPU 0.1–1.7 s, Core Ultra iGPU 3–5 s, N100 iGPU 5–24 s per model.

## (b) Accuracy on the hub frame set

At the production floors (person 0.65, vehicle/animal 0.50). P = precision, R = recall against the pseudo ground truth (288 persons, 115 vehicles, 109 animals). AP50 is threshold-free. "small+med" = persons under 100 px tall in the 960×540 frame (48 of them). INT8 rows measured on x86 CPU (FP32 math), plain rows with ONNX FP32 — device numerics change these by ≤0.03 except where noted above.

| model | person P / R @0.65 | person AP50 | person R day / night | person R small+med (<100 px) | vehicle P / R @0.50 | vehicle AP50 | animal P / R @0.50 | animal AP50 |
|---|---|---|---|---|---|---|---|---|
| yolov9t-320 | 0.99 / 0.30 | 0.69 | 0.30 / 0.29 | 2/48 | 1.00 / 0.38 | 0.72 | 1.00 / 0.14 | 0.38 |
| yolov9t-320-int8 | 0.99 / 0.28 | 0.68 | 0.27 / 0.29 | 2/48 | 1.00 / 0.37 | 0.70 | 0.94 / 0.14 | 0.40 |
| yolov9t-640 | 0.98 / 0.65 | 0.84 | 0.70 / 0.45 | 18/48 | 0.98 / 0.54 | 0.83 | 0.94 / 0.59 | 0.86 |
| yolov9t-640-int8 | 0.98 / 0.61 | 0.82 | 0.66 / 0.42 | 15/48 | 0.97 / 0.57 | 0.81 | 0.87 / 0.54 | 0.85 |
| yolov9s-320 | 0.94 / 0.55 | 0.79 | 0.57 / 0.47 | 6/48 | 0.97 / 0.57 | 0.81 | 0.93 / 0.25 | 0.65 |
| yolov9s-320-int8 | 0.96 / 0.52 | 0.78 | 0.54 / 0.45 | 6/48 | 0.97 / 0.51 | 0.80 | 0.89 / 0.23 | 0.62 |
| yolov9s-640 | 0.97 / 0.78 | 0.91 | 0.81 / 0.71 | 23/48 | 0.99 / 0.80 | 0.89 | 0.94 / 0.70 | 0.87 |
| yolov9s-640-int8 | 0.98 / 0.75 | 0.90 | 0.77 / 0.69 | 18/48 | 0.99 / 0.77 | 0.89 | 0.93 / 0.64 | 0.89 |
| yolov9m-320 | 0.95 / 0.71 | 0.86 | 0.73 / 0.61 | 15/48 | 0.98 / 0.72 | 0.83 | 0.92 / 0.61 | 0.82 |
| yolov9m-320-int8 | 0.97 / 0.66 | 0.85 | 0.69 / 0.56 | 11/48 | 0.99 / 0.69 | 0.85 | 0.96 / 0.63 | 0.84 |
| yolov9m-640 | 0.98 / 0.82 | 0.94 | 0.85 / 0.74 | 27/48 | 1.00 / 0.87 | 0.95 | 0.96 / 0.87 | 0.93 |
| yolov9m-640-int8 | 0.99 / 0.81 | 0.92 | 0.84 / 0.69 | 24/48 | 1.00 / 0.83 | 0.95 | 0.95 / 0.85 | 0.92 |
| yolov9c-320 | 0.97 / 0.70 | 0.87 | 0.74 / 0.55 | 14/48 | 0.99 / 0.75 | 0.87 | 0.97 / 0.52 | 0.86 |
| yolov9c-320-int8 | 0.96 / 0.70 | 0.87 | 0.74 / 0.55 | 15/48 | 0.99 / 0.76 | 0.86 | 0.98 / 0.51 | 0.88 |
| yolov9c-640 | 0.99 / 0.84 | 0.94 | 0.87 / 0.74 | 29/48 | 0.99 / 0.85 | 0.92 | 0.98 / 0.80 | 0.97 |
| yolov9c-640-int8 | 0.99 / 0.83 | 0.93 | 0.87 / 0.71 | 28/48 | 1.00 / 0.84 | 0.91 | 0.99 / 0.81 | 0.96 |
| yolo26n-320 | 0.95 / 0.27 | 0.62 | 0.28 / 0.23 | 1/48 | 0.93 / 0.36 | 0.64 | 1.00 / 0.10 | 0.31 |
| yolo26n-320-int8 | 0.94 / 0.16 | 0.61 | 0.15 / 0.18 | 1/48 | 0.95 / 0.30 | 0.62 | 1.00 / 0.07 | 0.31 |
| yolo26n | 0.98 / 0.60 | 0.86 | 0.64 / 0.45 | 11/48 | 0.99 / 0.64 | 0.85 | 0.94 / 0.43 | 0.87 |
| yolo26n-int8 | 0.98 / 0.47 | 0.83 | 0.49 / 0.39 | 8/48 | 1.00 / 0.58 | 0.84 | 0.90 / 0.25 | 0.82 |
| yolo26s-320 | 0.98 / 0.61 | 0.88 | 0.65 / 0.45 | 8/48 | 0.99 / 0.66 | 0.84 | 0.96 / 0.40 | 0.73 |
| yolo26s-320-int8 | 0.99 / 0.48 | 0.84 | 0.54 / 0.26 | 8/48 | 0.95 / 0.63 | 0.83 | 0.98 / 0.37 | 0.74 |
| yolo26s | 1.00 / 0.78 | 0.95 | 0.81 / 0.68 | 23/48 | 0.99 / 0.77 | 0.91 | 0.99 / 0.75 | 0.96 |
| yolo26s-int8 | 1.00 / 0.70 | 0.92 | 0.74 / 0.55 | 18/48 | 0.99 / 0.76 | 0.91 | 0.98 / 0.56 | 0.93 |
| yolo26m-320 | 0.97 / 0.70 | 0.91 | 0.77 / 0.47 | 20/48 | 1.00 / 0.75 | 0.85 | 0.98 / 0.51 | 0.86 |
| yolo26m-320-int8 | 0.98 / 0.70 | 0.91 | 0.74 / 0.55 | 16/48 | 1.00 / 0.70 | 0.85 | 0.98 / 0.50 | 0.88 |
| yolo26m | 1.00 / 0.84 | 0.95 | 0.88 / 0.68 | 34/48 | 1.00 / 0.80 | 0.96 | 1.00 / 0.85 | 0.99 |
| yolo26m-int8 | 0.99 / 0.83 | 0.95 | 0.89 / 0.63 | 33/48 | 1.00 / 0.83 | 0.96 | 0.99 / 0.79 | 0.97 |
| ssd-mobilenet-v2-coco-edgetpu | 0.98 / 0.30 | 0.57 | 0.30 / 0.29 | 6/48 | 1.00 / 0.29 | 0.53 | 1.00 / 0.05 | 0.23 |

Reading the table:

- Input resolution matters more than tier. Every model gains 10–35 points of person recall going from 320 to 640, mostly on people under 100 px and at night. `yolov9m-640` finds 27 of 48 small/medium persons; `yolov9m-320` finds 15.
- At 320, the YOLO26 nano/small models miss most people at default floors (their scores run lower — see the floors below); YOLOv9 m/c and YOLO26 m are the strongest 320 choices.
- The best accuracy per millisecond on an Intel NPU is `yolo26s` (base IR) and `yolov9m-640-int8`; overall best are `yolo26m`, `yolov9c-640` and `yolov9m-640`.
- The Coral SSD MobileNet V2 finds under a third of the people and almost no animals.

## (c) Recommended per-model confidence floors

Each floor is the lowest confidence at which the model raises **no more false positives on this frame set than the current default root does at its floors** (5 person, 1 vehicle, 3 animal false positives on 409 frames), so switching model keeps the false-alert rate and changes only what is found. Values are the median over the devices measured for that model, rounded to 0.05, never below 0.25. In brackets: precision / recall at that floor. Package-type objects (bag, suitcase) were too rare in the set (7) to calibrate — keep 0.50.

Floors carry roughly ±0.05–0.10 of noise (false-positive counts are single digits). † marks a floor that hinges on a single high-confidence false positive — the next-lower value is shown in [`model-floors.json`](model-floors.json), and it is the one the catalog ships: `yolov9m-320` vehicle 0.50 (0.98 / 0.72), `yolov9s-320-int8` vehicle 0.45 (0.96 / 0.61). The public accuracy table is at the shipped floors, so those two cells read 0.72 and 0.61, not the 0.56 and 0.37 of the † floors below. Most animal false positives are people labelled "dog" or "cat" at high confidence, so animal floors are the least stable; 0.50 keeps animal precision at 0.93 or better for every 640 model except the tiny/nano INT8 builds.

| model | person floor (P / R) | vehicle floor (P / R) | animal floor (P / R) |
|---|---|---|---|
| yolov9t-320 | **0.55** (0.95 / 0.37) | **0.45** (0.98 / 0.43) | **0.30** (0.92 / 0.21) |
| yolov9t-320-int8 | **0.55** (0.94 / 0.35) | **0.40** (0.96 / 0.45) | **0.30** (0.83 / 0.23) |
| yolov9t-640 | **0.65** (0.98 / 0.65) | **0.50** (0.98 / 0.54) | **0.50** (0.94 / 0.59) |
| yolov9t-640-int8 | **0.60** (0.98 / 0.65) | **0.55** (0.98 / 0.55) | **0.55** (0.93 / 0.48) |
| yolov9s-320 | **0.70** (0.96 / 0.48) | **0.55** (0.97 / 0.54) | **0.40** (0.91 / 0.36) |
| yolov9s-320-int8 | **0.70** (0.97 / 0.44) | **0.70** (0.95 / 0.36) † | **0.40** (0.92 / 0.31) |
| yolov9s-640 | **0.70** (0.99 / 0.75) | **0.40** (0.99 / 0.83) | **0.60** (0.95 / 0.55) |
| yolov9s-640-int8 | **0.50** (0.96 / 0.82) | **0.30** (0.99 / 0.87) | **0.55** (0.94 / 0.55) |
| yolov9m-320 | **0.70** (0.98 / 0.65) | **0.75** (0.98 / 0.56) † | **0.55** (0.94 / 0.53) |
| yolov9m-320-int8 | **0.65** (0.97 / 0.68) | **0.40** (0.98 / 0.75) | **0.45** (0.96 / 0.66) |
| yolov9m-640 | **0.60** (0.98 / 0.85) | **0.40** (0.98 / 0.88) | **0.55** (0.96 / 0.82) |
| yolov9m-640-int8 | **0.55** (0.98 / 0.85) | **0.40** (1.00 / 0.88) | **0.70** (0.96 / 0.66) |
| yolov9c-320 | **0.70** (0.98 / 0.67) | **0.45** (0.97 / 0.77) | **0.45** (0.96 / 0.64) |
| yolov9c-320-int8 | **0.70** (0.97 / 0.67) | **0.50** (0.99 / 0.76) | **0.25** (0.97 / 0.77) |
| yolov9c-640 | **0.55** (0.98 / 0.88) | **0.45** (0.99 / 0.87) | **0.30** (0.97 / 0.94) |
| yolov9c-640-int8 | **0.45** (0.98 / 0.88) | **0.40** (1.00 / 0.86) | **0.30** (0.95 / 0.90) |
| yolo26n-320 | **0.60** (0.94 / 0.30) | **0.60** (0.97 / 0.27) | **0.40** (0.85 / 0.16) |
| yolo26n-320-int8 | **0.45** (0.94 / 0.32) | **0.55** (0.97 / 0.28) | **0.35** (0.83 / 0.14) |
| yolo26n | **0.65** (0.98 / 0.59) | **0.40** (0.99 / 0.71) | **0.50** (0.94 / 0.42) |
| yolo26n-int8 | **0.55** (0.96 / 0.55) | **0.30** (1.00 / 0.74) | **0.40** (0.94 / 0.43) |
| yolo26s-320 | **0.60** (0.97 / 0.65) | **0.45** (0.98 / 0.70) | **0.45** (0.94 / 0.48) |
| yolo26s-320-int8 | **0.50** (0.98 / 0.60) | **0.55** (0.97 / 0.60) | **0.45** (0.94 / 0.45) |
| yolo26s | **0.40** (0.98 / 0.88) | **0.45** (0.98 / 0.81) | **0.40** (0.96 / 0.88) |
| yolo26s-int8 | **0.40** (0.98 / 0.81) | **0.30** (0.98 / 0.83) | **0.40** (0.95 / 0.68) |
| yolo26m-320 | **0.70** (0.98 / 0.67) | **0.30** (0.99 / 0.82) | **0.40** (0.96 / 0.61) |
| yolo26m-320-int8 | **0.60** (0.97 / 0.72) | **0.40** (0.99 / 0.77) | **0.30** (0.95 / 0.71) |
| yolo26m | **0.40** (0.97 / 0.91) | **0.25** (0.99 / 0.91) | **0.30** (0.97 / 0.98) |
| yolo26m-int8 | **0.40** (0.98 / 0.88) | **0.35** (0.98 / 0.86) | **0.45** (0.97 / 0.88) |
| ssd-mobilenet-v2-coco-edgetpu | **0.60** (0.94 / 0.32) | **0.35** (0.97 / 0.31) | **0.40** (0.67 / 0.06) |

## (d) Recommendations by hardware

Budget rule of thumb: a camera detecting at 10 fps needs about 10 inferences per second while something is moving. Use the "fps" column as the ceiling for one accelerator and keep 30–50 % headroom for bursts, enrichment models (faces, plates, embeddings) that share the same device, and several cameras moving at once.

### Intel with NPU (Core Ultra)

- **Default: `yolov9m-640-int8` on the NPU** when it fits the camera count — ~19 ms, ~50 fps, so 3–4 cameras detecting at 10 fps at once. Against `yolov9m-320-int8` it finds about 25 % more people (recall 0.80 vs 0.69 on the NPU, at the same false-alert rate 0.84 vs 0.66), twice as many small/medium people, and 11–16 points more recall at night. Floors: person 0.55, vehicle 0.40, animal 0.50–0.70.
- **Many cameras: `yolov9m-320-int8` on the NPU** (~6.5 ms, ~165 fps), floors 0.65 / 0.40 / 0.45.
- **Highest accuracy: `yolov9c-640-int8`** (~24 ms, ~41 fps) or **`yolo26m`** (base model, ~28 ms, ~35 fps).
- **Worth trying: `yolo26s` (base model) on the NPU** — ~13 ms, ~77 fps, with accuracy close to `yolov9m-640` (person AP50 0.95) and very few false positives (1 person false positive on the set). It needs its own floors (person 0.40, vehicle 0.45, animal 0.40); YOLO26 scores run lower than YOLOv9. Use the base model, not `yolo26s-int8`, on the NPU (the INT8 build loses recall there).
- **Second accelerator (iGPU)**: run INT8 models there — `yolov9m-320-int8` (~7 ms) or `yolov9m-640-int8` (~23 ms). **Do not put `yolo26s`, `yolo26m` or `yolo26m-320` base models on the iGPU** — they return no usable detections at the iGPU's default precision. Their `-int8` variants are fine.
- Keep the CPU for decoding and the rest of the system; the NPU and iGPU are each 2–3× faster than the CPU for these models.

### Intel iGPU only (N100 and similar)

- **Default: `yolov9m-320-int8` on the iGPU** — ~39 ms, ~25 fps: two cameras detecting at 10 fps. Floors 0.65 / 0.40 / 0.45.
- **More cameras: `yolov9t-640-int8`** (~33 ms, ~33 fps; recall 0.61, weaker at night) or **`yolov9s-320-int8`** (~23 ms, ~34 fps; recall 0.52). Raise the person floor to 0.60 / 0.70 respectively.
- **One or two cameras, accuracy first: `yolov9c-320-int8`** (~51 ms, ~20 fps; recall 0.70). The 640 models (`yolov9s-640-int8` 93 ms, `yolov9m-640-int8` 139 ms) are too slow for live detection on an N100.
- Avoid YOLO26 base models on the iGPU (see above); `yolo26s-320-int8` (~34 ms) works but finds fewer people than `yolov9m-320-int8`.
- The N100's CPU is not a useful detection device next to its iGPU.
- Expect the first start of each model to take 5–25 s while the iGPU compiles it.

### CPU only (x86: Intel or AMD)

- Use the **OpenVINO INT8** builds — they are 2.5–3× faster than ONNX on x86.
- **Desktop-class CPU (≈ 4 modern cores free): `yolov9s-640-int8`** (~20 ms at 4 threads, ~50 fps; recall 0.75) or **`yolo26s-int8`** (~17 ms; recall 0.70, floors 0.40 / 0.30 / 0.40).
- **Many cameras or a small CPU: `yolov9m-320-int8`** (~14 ms; recall 0.66) or **`yolo26n-int8`** (~7 ms; recall 0.47 at 0.65, 0.55 at its own floor 0.55).
- Low-power CPUs (N100 class) were 6–20× slower than the figures above in this test (under heavy load; expect at least 4× on an idle one); prefer their iGPU.
- ARM CPUs (Raspberry Pi, Ampere, Apple CPU cores): use ONNX builds, not OpenVINO INT8.

### Apple Silicon

- Run Core ML on "all compute units": every Core ML package now runs on the Neural Engine (the YOLOv9 ones since D743, see (f)) — 5–9× faster than Core ML on the CPU cores and 7–27× faster than ONNX.
- **Default: `yolo26s`** — 5.7 ms on an M3 Pro (≈175 fps), person R 0.88 / AP50 0.95 / 32 small people. `yolov9m-640` is as accurate (R 0.85, 32 small people) at 10.2 ms. Floors 0.40 / 0.45 / 0.40.
- **Highest accuracy: `yolo26m`** — 12.4 ms, person R 0.91, night R 0.79, 39 small people; `yolov9c-640` (12.1 ms, R 0.88, 35 small people) is close at the same speed. Floors 0.40 / 0.25 / 0.30.
- **Many cameras / older Mac: `yolo26m-320`** — 3.2 ms, person R 0.67 / AP50 0.91; `yolov9m-320` (the Mac default detector) is now also 3.2 ms, R 0.65 / AP50 0.86.
- M2 Mac mini: measured on the Neural Engine at ≈1.0–1.2× the M3 Pro (`yolov9m-320` 3.8 ms, `yolov9m-640` 10.3 ms predict, with 13 cameras live) — the M3 Pro recommendations hold for a base M2.

### Coral (USB Edge TPU)

- **`ssd-mobilenet-v2-coco-edgetpu`** runs ~10 ms per frame (≈95 fps per Coral) with almost no CPU, but finds under a third of the people the YOLO models find (recall 0.30, AP50 0.57) and almost no animals.
- Use it only to offload detection from a host that has nothing better (no NPU/iGPU, weak CPU) — for example a Raspberry Pi. Floors person 0.60, vehicle 0.35. On any Intel machine with an iGPU or NPU, the YOLO models above are both faster per camera and far more accurate.


---

## (e) YOLO26 Core ML on the M3 Pro (after D742)

Measured 2026-10-07 afternoon, after the 8 reduced packages on HF `camstack/camstack-models` were re-exported static at their original paths. Packages downloaded fresh from HF; coremltools 8.3 (the pool's `requirements-coreml.txt` pins `<9`), macOS 26.2.

**Method** — identical to the original Apple column (`mac_lat.py`): `ct.models.MLModel(.mlpackage, compute_units=…)`, which is the pool's cache-miss load path (`_acquire_coreml_model`); `imageType` input fed a grey-114 PIL image of the model size; 5 warm-up + 40 timed `predict`; p50 / p95; fps = 1000 / p50 (the pool's Core ML executor is single-threaded). One model per process. Two full passes; each cell is the pass with the lower p50. **Machine load 7–29 on 12 cores** (other agents running) — the Neural Engine cells are stable across passes (±15 %); the CPU-only and ONNX cells vary by up to 1.6× and are pessimistic.

**Control**: `yolov9m-320` ALL 8.7 / 9.6 / 9.8 ms across passes (table: 9.1), `yolov9m-640` 24.1 / 24.4 / 24.7 / 29.8 (table: 24.1) — the existing Apple column is comparable and was not re-measured.

| model | CoreML ALL p50 / p95 ms | fps | CoreML CPU_AND_NE p50 | CoreML CPU_ONLY p50 | ONNX CPU p50 |
|---|---|---|---|---|---|
| yolov9m-320 (control) | 8.7 / 9.8 | 115 | 43.1 | 41.2 | 73.1 |
| yolov9m-640 (control) | 24.1 / 25.8 | 41 | 147.6 | 145.5 | 241.6 |
| yolo26n-256 | 0.8 / 1.0 | 1299 | 0.7 | 3.4 | 6.2 |
| yolo26n-320 | 1.0 / 1.4 | 971 | 0.9 | 5.7 | 9.8 |
| yolo26n | 3.6 / 4.4 | 279 | 3.3 | 17.4 | 28.4 |
| yolo26s-256 | 1.2 / 7.9 | 813 | 1.2 | 8.2 | 20.9 |
| yolo26s-320 | 1.9 / 2.4 | 526 | 2.0 | 10.8 | 28.0 |
| yolo26s | 5.7 / 6.4 | 176 | 5.7 | 33.0 | 81.1 |
| yolo26m-256 | 1.9 / 2.0 | 529 | 1.9 | 13.5 | 38.0 |
| yolo26m-320 | 3.2 / 3.5 | 308 | 3.2 | 20.6 | 58.3 |
| yolo26m | 12.4 / 14.2 | 81 | 12.6 | 74.7 | 222.8 |
| yolo26l-256 | 2.2 / 2.5 | 444 | 2.3 | 15.7 | 50.9 |
| yolo26l-320 | 3.9 / 4.3 | 255 | 3.9 | 28.0 | 83.3 |
| yolo26l | 14.9 / 16.4 | 67 | 14.8 | 79.4 | 285.4 |
| yolo26n-seg | 4.5 / 5.4 | 224 | 4.3 | 20.5 | 38.5 |
| yolo26s-seg | 8.0 / 11.5 | 125 | 7.3 | 44.9 | 130.8 |
| yolo26m-seg | 21.6 / 25.5 | 46 | 19.1 | 121.3 | 394.8 |

Every package loaded under `ALL`, `CPU_AND_NE` and `CPU_ONLY` with no abort (including the 640 ones the original run listed as aborting). `ALL` ≈ `CPU_AND_NE` for YOLO26 → it is on the ANE; for YOLOv9 `CPU_AND_NE` ≈ `CPU_ONLY` → it never is (FP32 packages; see the matrix notes).

**FP16 parity vs ONNX** (same model, production preprocess — `inference_pool._preprocess` with the Core ML runtime, PIL letterbox fed to `imageType` — and the production `postprocess_yolo` / `postprocess_yolo_seg`; detections ≥ 0.25 matched by class at IoU ≥ 0.5):

- 60 COCO val2017 images: YOLO26 n/s/m/l × 640/320/256 and seg n/s/m — 96–99.7 % of ONNX detections matched (lowest `yolo26n-256` 96.4 %), mean |Δscore| 0.009–0.018, mean IoU 0.990–0.993. `yolov9m-320/640`: 100 %, Δscore 0.0000 (FP32 on the GPU).
- The 409 hub frames (re-fetched read-only, deleted after the run): YOLO26 n/s/m × 320/640 — 95.7–97.9 % matched, Δscore 0.011–0.016.

**Accuracy on the hub set, Core ML vs the ONNX rows of (b)** (per-model floors from `model-floors.json`, taking the measured floor even where it is †; the ONNX rows were re-derived from the original detections and reproduced the public table exactly, except `yolov9m-320` vehicle R: 0.56 at the † floor 0.75, where the public table and the catalog use 0.50 and give 0.72 — both right for their threshold, see (c)):

| model | person P / R | AP50 | R day / night | small found | vehicle P / R | animal P / R |
|---|---|---|---|---|---|---|
| yolo26n-320 CoreML | 0.95 / 0.30 | 0.62 | 0.31 / 0.26 | 2 | 0.97 / 0.26 | 0.85 / 0.16 |
| yolo26n CoreML | 0.98 / 0.60 | 0.85 | 0.64 / 0.44 | 11 | 0.99 / 0.70 | 0.94 / 0.43 |
| yolo26s-320 CoreML | 0.97 / 0.66 | 0.88 | 0.69 / 0.53 | 10 | 0.99 / 0.70 | 0.94 / 0.47 |
| yolo26s CoreML | 0.98 / 0.88 | 0.94 | 0.91 / 0.74 | 33 | 0.98 / 0.80 | 0.96 / 0.88 |
| yolo26m-320 CoreML | 0.98 / 0.66 | 0.91 | 0.72 / 0.47 | 15 | 0.98 / 0.82 | 0.96 / 0.61 |
| yolo26m CoreML | 0.98 / 0.91 | 0.95 | 0.94 / 0.79 | 39 | 0.99 / 0.92 | 0.97 / 0.98 |
| yolov9m-320 / -640 CoreML | identical to ONNX | | | | | |

Every cell within 0.03 of its ONNX row (largest: `yolo26s-320` night R 0.53 vs 0.50, small people 10 vs 12) — noise at this set size. The floors in `model-floors.json` therefore hold for the Core ML builds.

## (f) YOLOv9 Core ML FP16 on the M3 Pro (after D743)

Measured 2026-10-07 evening, after the eight YOLOv9 packages on HF `camstack/camstack-models` were re-exported FP16 (`half=True`, Ultralytics 8.4.98, PyTorch 2.13.0, coremltools 9.0) and replaced at their original paths. Same method as (e) (`ct.models.MLModel(.mlpackage, compute_units=…)`, grey-114 image, 5 warm-up + 40 timed `predict`, one package per process, two passes, the lower p50 kept). Load 7–9 on 12 cores.

| model | FP16 `ALL` p50 / p95 ms | fps | FP16 `CPU_AND_NE` | FP16 `CPU_AND_GPU` | FP16 `CPU_ONLY` | FP32 `ALL` (old) | FP32 `CPU_AND_NE` (old) |
|---|---|---|---|---|---|---|---|
| yolov9t-320 | 1.1 / 1.2 | 952 | 1.0 | 4.9 | 7.5 | 5.1 | 10.6 |
| yolov9t-640 | 3.0 / 3.6 | 333 | 3.0 | 8.4 | 27.0 | 8.4 | 30.7 |
| yolov9s-320 | 1.5 / 1.9 | 667 | 1.5 | 6.2 | 13.7 | 7.8 | 21.2 |
| yolov9s-640 | 5.1 / 5.6 | 196 | 5.1 | 9.8 | 42.4 | 12.0 | 66.6 |
| yolov9m-320 | 3.2 / 3.5 | 312 | 3.1 | 8.9 | 27.2 | 9.0 | 40.9 |
| yolov9m-640 | 10.2 / 11.0 | 98 | 11.1 | 22.0 | 86.9 | 27.3 | 172.7 |
| yolov9c-320 | 3.9 / 4.1 | 256 | 3.9 | 8.7 | 28.7 | 10.0 | 55.2 |
| yolov9c-640 | 12.1 / 12.7 | 83 | 12.3 | 23.8 | 103.1 | 32.0 | 218.8 |

`ALL` ≈ `CPU_AND_NE`, and both are 2–5× faster than `CPU_AND_GPU`: the FP16 packages run on the Neural Engine with no op left behind (the DFL head included). FP32 `CPU_AND_GPU` was within noise of FP32 `ALL` on every model. Through the pool's own load path (`inference_pool._acquire_coreml_model`, device `all` → `ComputeUnit.ALL`, frame from `_preprocess`): `yolov9m-320` 3.0 ms after the compile, 3.2 ms on the cache HIT; `yolov9m-640` 10.3 / 11.9 ms. A batch-flexible FP16 export of `yolov9m-320` also ran on the Neural Engine (`ALL` 3.8 ms), so precision, not the static batch, was the blocker; the hosted packages stay static.

**FP16 parity vs the hosted ONNX** (production preprocess and `postprocess_yolo`, detections ≥ 0.25 matched by class at IoU ≥ 0.5):

- 60 COCO val2017 images: 98.7–99.7 % of ONNX detections matched, mean |Δscore| 0.003–0.007, mean IoU 0.991–0.994.
- The hub frames (408 of the 409 re-fetched read-only, one had expired; deleted after the run): 98.0–99.7 % matched, mean |Δscore| 0.006–0.010.

**Accuracy on the hub set at the shipped floors**, 408 frames, ONNX → CoreML FP16 (this run's ONNX reproduced the original ONNX detections exactly):

| model | person P / R | AP50 | R day / night | small found | vehicle P / R | animal P / R |
|---|---|---|---|---|---|---|
| yolov9t-320 | 0.95 / 0.37 → 0.93 / 0.37 | 0.69 → 0.69 | 0.37 / 0.35 → same | 4 → 4 | 0.98 / 0.43 → 0.98 / 0.42 | 0.92 / 0.20 → 0.93 / 0.23 |
| yolov9t-640 | 0.98 / 0.64 → same | 0.84 → 0.84 | 0.70 / 0.45 → same | 18 → 18 | 0.98 / 0.54 → 0.98 / 0.56 | 0.94 / 0.58 → 0.95 / 0.57 |
| yolov9s-320 | 0.96 / 0.48 → 0.94 / 0.47 | 0.78 → 0.78 | 0.48 / 0.45 → 0.48 / 0.44 | 5 → 5 | 0.97 / 0.53 → 0.95 / 0.53 | 0.90 / 0.35 → same |
| yolov9s-640 | 0.99 / 0.75 → same | 0.91 → 0.91 | 0.78 / 0.66 → 0.77 / 0.65 | 17 → 17 | 0.99 / 0.82 → 0.99 / 0.84 | 0.95 / 0.55 → 0.95 / 0.56 |
| yolov9m-320 | 0.98 / 0.65 → same | 0.86 → 0.86 | 0.67 / 0.56 → same | 10 → 10 | 0.98 / 0.72 → 0.96 / 0.72 | 0.93 / 0.53 → 0.92 / 0.54 |
| yolov9m-640 | 0.98 / 0.85 → same | 0.94 → 0.94 | 0.88 / 0.76 → same | 32 → 32 | 0.98 / 0.88 → 1.00 / 0.88 | 0.96 / 0.81 → 0.96 / 0.82 |
| yolov9c-320 | 0.98 / 0.67 → same | 0.87 → 0.87 | 0.71 / 0.53 → same | 12 → 11 | 0.97 / 0.76 → 0.96 / 0.76 | 0.96 / 0.64 → 0.95 / 0.66 |
| yolov9c-640 | 0.98 / 0.87 → same | 0.94 → 0.94 | 0.91 / 0.76 → same | 35 → 35 | 0.99 / 0.87 → same | 0.97 / 0.94 → same |

Every cell is within 0.03 of the ONNX row; precision moves by at most one false positive. The floors in `model-floors.json` hold for the FP16 Core ML builds.

# Internal appendix (not for the public page)

## A1. `yolov9m-640` vs the production root (`yolov9m-320-int8`)

Same 409 frames, same pseudo-GT, production preprocessing/decode. Production floors unless stated. Full tables: `d1_accuracy.txt`; calibration: `calib_d1.json`.

| run | person P / R / AP50 | person R day / night | person small+med | vehicle P / R / AP50 | animal P / R / AP50 | NPU p50 / fps4 |
|---|---|---|---|---|---|---|
| prod `yolov9m-320-int8` @NPU | 0.961 / 0.688 / 0.847 | 0.717 / 0.581 | 12/48 | 1.000 / 0.713 / 0.841 | 0.958 / 0.633 / 0.848 | 6.5 ms / 165 |
| prod `yolov9m-320-int8` @CPU f32 | 0.974 / 0.660 / 0.845 | 0.686 / 0.565 | 11/48 | 0.988 / 0.687 / 0.849 | 0.958 / 0.633 / 0.842 | — |
| `yolov9m-640` ONNX fp32 | 0.983 / 0.823 / 0.941 | 0.845 / 0.742 | 27/48 | 1.000 / 0.870 / 0.953 | 0.960 / 0.872 / 0.928 | — |
| `yolov9m-640` fp16 IR @NPU (catalog base) | 0.983 / 0.819 / 0.941 | 0.841 / 0.742 | 26/48 | 1.000 / 0.870 / 0.953 | 0.960 / 0.872 / 0.928 | 29.5 ms / 32 |
| `yolov9m-640-int8` @CPU f32 | 0.987 / 0.809 / 0.924 | 0.841 / 0.694 | 24/48 | 1.000 / 0.835 / 0.953 | 0.949 / 0.853 / 0.917 | — |
| `yolov9m-640-int8` @NPU | 0.983 / 0.799 / 0.932 | 0.827 / 0.694 | 23/48 | 1.000 / 0.843 / 0.952 | 0.959 / 0.853 / 0.919 | 19.5 ms / 52 |
| `yolov9m-640-int8` @iGPU | 0.987 / 0.806 / 0.933 | 0.836 / 0.694 | 24/48 | 1.000 / 0.835 / 0.953 | 0.931 / 0.862 / 0.902 | 23.5 ms / 44 (iGPU) |

Calibration (floor giving the production root's false-positive count: 5 person / 1 vehicle / 3 animal):

| run | person floor → P / R | vehicle floor → P / R | animal floor → P / R |
|---|---|---|---|
| prod root @NPU (sanity: should land on its own floors) | 0.675 → 0.98 / 0.66 | 0.425 → 0.99 / 0.75 | 0.45 → 0.96 / 0.66 |
| `yolov9m-640-int8` @NPU | 0.575 → 0.98 / 0.84 | 0.425 → 1.00 / 0.86 | 0.70 → 0.96 / 0.66 |
| `yolov9m-640-int8` @iGPU | 0.575 → 0.98 / 0.84 | 0.375 → 0.99 / 0.89 | 0.75 → 0.95 / 0.57 |
| `yolov9m-640-int8` @CPU | 0.50 → 0.98 / 0.86 | 0.325 → 0.99 / 0.88 | 0.60 → 0.97 / 0.80 |
| `yolov9m-640` fp32 / fp16@NPU | 0.625 → 0.98 / 0.84 | 0.425 → 1.00 / 0.88 | 0.575 → 0.97 / 0.82 |

Recommended for `yolov9m-640-int8`: person 0.55, vehicle 0.40, animal 0.50 (P≈0.95, R≈0.85; the strict 3-FP animal budget gives 0.70 / R 0.66 because the extra animal FPs are people labelled dog/cat). Cost: 3× the NPU time per frame (19.5 vs 6.5 ms; 52 vs 165 fps).

## A2. Hub GPU health check

- Device pools (read-only API): hub `openvino:npu` and `openvino:gpu` both enabled, weight 50/50, default model `yolov9m-320-int8`; hub `edgetpu:usb` available but disabled; agent-a `openvino:gpu` enabled (same default); Mac mini `coreml:all` (`yolov9m-320`). No device reported unhealthy (`getInferenceDeviceHealth`).
- Which cameras use the hub iGPU: in the last ~8.4 h of orchestrator logs (Loki), 733 detection sessions dispatched by the orchestrator: **357 on `openvino:gpu`**, 355 on `openvino:npu`, 21 on `coreml:all`. Every hub camera alternates between NPU and iGPU (e.g. kitchen 123 GPU / 121 NPU, porch 33/38, retro casa 43/30, cortile 24/13, studio 20/11/21 CoreML).
- Do iGPU sessions produce detections? Sessions in which a subject was seen: **13 % on iGPU vs 13 % on NPU** (47/357 vs 45/355). Tracks born during the sessions: 60 on iGPU sessions (23 person, 5 vehicle, 32 animal) vs 46 on NPU sessions; median 14.5 observations per track on both.
- Direct test on the hub container (production IR copied to /tmp, compiled exactly like the pool, all 409 frames): iGPU default precision is **f16**. Against CPU f32, matched-score |Δ| median 0.012 (p95 0.08) — the same spread as iGPU f32 (0.009 / 0.06) and the NPU (0.013 / 0.10), i.e. normal INT8 kernel noise. Accuracy: person P/R iGPU-f16 0.975 / 0.684, iGPU-f32 0.965 / 0.674, NPU 0.961 / 0.688, CPU 0.974 / 0.660. Latency 7.1 ms (f16) vs 8.8 ms (f32).
- Same check on the agent-a N100 iGPU (f16 default): person P/R 0.980 / 0.681, score |Δ| median 0.012 — healthy.
- API synthetic bench (`pipeline-runner` `startSyntheticBench`, inference mode, not saved to history): hub NPU predict 10.2 ms / 46 fps per-call; hub iGPU 10.1 ms / 47 fps; N100 iGPU 48 ms predict, 221 ms per call (remote frame transfer).
- **Verdict: hub-iGPU detection with the production root is healthy.** The fp16-garbage effect seen on the Mac's ARM CPU does not occur on Intel iGPU/NPU for YOLOv9 INT8.
- **But**: the catalog's YOLO26 base FP32 IRs `yolo26s`, `yolo26m`, `yolo26m-320` (and probably `yolo26l*`, not tested) produce no valid output on any Intel iGPU at default precision; the pool never sets `INFERENCE_PRECISION_HINT`, so selecting one of these on `openvino:gpu` gives a blind camera. Options: force `f32` for those IRs on GPU (+60 % latency), or offer only their `-int8` variants on GPU.
- Catalog text says YOLO26 is rejected by the NPU; with OpenVINO 2025.4 all YOLO26 IRs compiled and the base IRs are exact on the NPU (INT8 IRs lose 5–12 points of recall there).

## A3. What was skipped and why

- `yolo26l*`, `yolo26x*` (legacy/heavy; not realistic roots at camera rates), the 256-px YOLO26 variants (strictly worse than 320), `*-fp16` YOLO26 legacy IRs, and the `yolo26*-seg` builds (detection identical to the plain model plus masks).
- Mac mini: only `yolov9m-320` (the only detector downloaded there; benching others would have downloaded them onto the node). M3 Pro used for the Apple Silicon matrix.
- YOLO26 Core ML: measured after D742, see (e). Accuracy on the hub set was measured for n/s/m at 320/640 only; `l`, `-256` and `-seg` have speed and COCO parity only.
- plus catalog / MobileDet / EfficientDet Coral entries: no longer in the catalog (only `ssd-mobilenet-v2-coco-edgetpu`). `frigate-yolonas-s-320.onnx` exists on the hub's model dir but is not a catalog entry.
- Accuracy for YOLOv9 FP16 IRs was measured only for `yolov9m-640` on the NPU (identical to ONNX FP32); other FP16 IRs are assumed equal to their ONNX rows.

## A4. Files

- The per-model floors with precision and recall: [`docs/benchmarks/model-floors.json`](model-floors.json), which the catalog's floor table is held equal to (D739).
- The YOLOv9 latency per hardware class × accelerator: [`docs/benchmarks/detector-latency.json`](detector-latency.json), which the Auto tune recommender's table is held equal to (D745).
- The raw detections, latency logs and measurement scripts were kept in the session scratchpad and are not in the repository.
