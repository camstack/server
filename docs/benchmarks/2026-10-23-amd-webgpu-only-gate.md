# AMD Phoenix iGPU (WebGPU) as agent-b's only detector — quality and capacity gate (2026-10-23)

applies-to:
  - scripts/bench-detector-latency-column.mjs
last-verified: 2026-10-23

Question (operator): with the Corals out of primary detection, is `onnx:webgpu`
on `agent-b` (Radeon 760M, WebGPU, D823 isolated child per model) good
enough to be that node's ONLY detection device?

State at the time of measuring: on `agent-b` only `onnx:webgpu` was enabled
(`cpu`, `openvino:cpu`, `edgetpu:pci`, `edgetpu:pci:1`, `edgetpu:usb` disabled);
effective shares (`getEffectiveShares`, trigger `node-devices:agent-b`):
Mac 36 %, hub 37 %, agent-a 18 %, agent-b 9 %. Nothing was changed by
this measurement (no settings, pins, devices, no node benchmark, no pool recycle).

## 1. Quality — the 2026-10-22 gate set

Same frames and rules as the Coral gate
([2026-10-22-coral-pcie-amd-phoenix.md](2026-10-22-coral-pcie-amd-phoenix.md),
"Third run"): the retrain export, 91 frames from 18 cameras, 134 scored operator
boxes (61 person, 60 animal, 13 vehicle), frames downscaled to 1280 px long side,
one `benchmark.runPipelineTest` per frame (`plane: 'frame'`, object-detection
alone, node-pinned, `deviceKey: onnx:webgpu`), step floors lowered to 0.3 so one
run serves both thresholds. Greedy match by score, same macro class, IoU ≥ 0.5;
FP counted on the 56 complete frames. "Prod" = each model's `defaultClassFloors`
row. The scorer reproduces the 2026-10-22 reference within one box (Mac
`yolov9m-640`: 83 / 103 today vs 84 / 102 then).

| Detector (node / device) | step p50 ms | Recall prod | FP prod | Recall @0.3 | FP @0.3 | person @0.3 | vehicle @0.3 | animal @0.3 | small (<1 %) @0.3 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `yolov9m-640` Mac / `coreml:all` (reference) | 24 | 83 = 0.62 | 7 | 103 = 0.77 | 13 | 35/61 | 13/13 | 55/60 | 50/57 |
| `yolov9m-640-int8` hub / `openvino:gpu` (2026-10-22) | — | 71 = 0.53 | 5 | 104 = 0.78 | 11 | 37/61 | 13/13 | 54/60 | 50/57 |
| `yolov9m-640` agent-b / `onnx:webgpu` | 254 | 83 = 0.62 | 7 | 103 = 0.77 | 13 | 35/61 | 13/13 | 55/60 | 50/57 |
| `yolov9s-640` webgpu | 137 | 40 = 0.30 | 5 | 78 = 0.58 | 9 | 28/61 | 10/13 | 40/60 | 35/57 |
| `yolov9t-640` webgpu | 94 | 38 = 0.28 | 4 | 60 = 0.45 | 11 | 18/61 | 8/13 | 34/60 | 22/57 |
| `yolov9m-320` webgpu | 116 | 30 = 0.22 | 2 | 61 = 0.46 | 6 | 26/61 | 11/13 | 24/60 | 16/57 |
| `yolov9s-320` webgpu | 66 | 28 = 0.21 | 5 | 43 = 0.32 | 13 | 21/61 | 7/13 | 15/60 | 7/57 |
| `yolov9t-320` webgpu | 37 | 17 = 0.13 | 5 | 26 = 0.19 | 6 | 12/61 | 4/13 | 10/60 | 1/57 |

Per class at prod floors (person / vehicle / animal): Mac and webgpu
`yolov9m-640` 28/61, 12/13, 43/60; `yolov9s-640` 13, 8, 19; `yolov9s-320` 9, 6, 13.

- The WebGPU `yolov9m-640` is the reference model and gives the reference's
  answer: same detection count on 91/91 frames, scores differ by 0.006 on
  average (max 0.029, FP16 vs Core ML), identical recall and FP. Two separate
  computations (engine `python+onnx`, 254 ms, vs `python+coreml`, 24 ms).
- Every smaller model is far below: the best, `yolov9s-640`, keeps 0.30 / 0.58
  against 0.62 / 0.77. The 320 inputs lose the small subjects (7–16 of 57).
- Where it ran: during the runs the PVE host's `gpu_busy_percent` read 29–42 %
  (2–5 % idle) and fresh `webgpu_isolated.py` children appeared in CT201 per model.

## 2. Capacity — onnx:webgpu

Node benchmark (auto, 11:16 UTC today, `nb-mvkvkles`): `yolov9s-320` p50 64 /
p95 68 ms, **kMax 2** (load 4 fails: drops 5.5 %, e2e p95 101 ms). Its bar is one
frame interval at `fpsPerStream` 10 (`e2eP95MsMax = 100 ms`, drops ≤ 1 %); a
live session's `detectionFps` default is also 10. Earlier cells: `yolov9t-320`
and `yolov9m-320` kMax 0 (2026-10-10, before D845).

`yolov9m-640` was not put through the node benchmark: at 222 ms per request
alone it cannot meet a 100 ms bar at load 1, so the run could only report
kMax 0 while 6 sessions were live on the node. Instead, closed-loop throughput
with C concurrent `runPipelineTest` callers (12 gate frames, 40 s each,
node serving its live cameras):

| Model | C | fps (aggregate) | step p50 / p95 ms |
| --- | --- | --- | --- |
| `yolov9m-640` | 1 | 2.9 | 222 / 224 |
| `yolov9m-640` | 2 | 5.9 | 206 / 312 |
| `yolov9m-640` | 4 | 6.5 | 495 / 536 |
| `yolov9m-640` | 8 | 12.9 | 600 / 618 (GPU busy 93–94 %) |
| `yolov9s-640` | 4 | 12.6 | 127 / 207 |
| `yolov9s-320` | 4 | 13.6 | 59 / 84 |

(C = 16 for `yolov9m-640` returned half its replies with `predictMs` 0, not
real inference, so it is discarded.) The GPU saturates at about 13 frames/s of
`yolov9m-640`, at 0.6 s per frame: **about one 10 fps session**, and none within
the benchmark's 100 ms bar.

## Verdict

No WebGPU model is both near the reference and able to carry sessions. The
only model at the reference (`yolov9m-640`) gives ~1 session at 10 fps with
0.6 s latency (0 within the SLO); the ones that fit the SLO (`yolov9s-320`,
kMax 2) find a third of what the reference finds (0.21 vs 0.62 at prod floors).
**Not valid as the node's only primary detector**: agent-b should carry no
primary detection. Its 9 % share goes back to the hub, the Mac and agent-a
(about 41 / 40 / 20 % pro rata). In the hour before the measurement agent-b
had observed 27 % of session starts, 91 % of them on the Corals.

Raw (gitignored session scratchpad): `gate/r-webgpu-*.json`,
`gate/r-mac-yolov9m-640.json`, `gate/summary.json`, `gate/tput.jsonl`, scorer
`gate/analyze.py`, runner `gate/run.mjs`, throughput `gate/tput.mjs`.
