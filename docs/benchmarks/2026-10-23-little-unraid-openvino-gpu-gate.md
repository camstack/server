# agent-a (N100 iGPU, `openvino:gpu`) — quality and capacity per detector (2026-10-23)

applies-to:
  - scripts/bench-detector-latency-column.mjs
last-verified: 2026-10-23

Question (operator): agent-a carries ~20 % of production sessions on
`openvino:gpu` at a 320 input. Is that quality acceptable, and can the node
carry its share with a better model (`yolov9m-640-int8` as the hub runs,
`yolov9s-640-int8`, a 512 build)?

State while measuring (nothing was changed — no settings, pins, devices, model
choices, node benchmark or pool recycle): shares (`getEffectiveShares`,
source `benchmark`, trigger `node-offline:agent-b`) Mac 40 %, hub 40 %,
agent-a 20 %. agent-a devices: `openvino:gpu` enabled
(`defaultModelId` `yolov9m-320-int8`, **step override
`object-detection.modelId = yolov9s-320-int8`**), `cpu` disabled. The live
sessions run the override: agent logs show `rootModelId=yolov9s-320-int8`.
Live sessions on the node changed during the window (on-motion churn): 1
camera at the start (3830), then 637, then 2 (cortile, porch) at ~7–8 fps,
e2e p95 78 / 115 ms while the throughput sweep ran.

The catalog has no `yolov9m-512`; 512 exists only as the Coral build
`yolov9s-512-edgetpu`.

## 1. Quality — the 2026-10-22 gate set

Method, frames and scorer identical to
[2026-10-23-amd-webgpu-only-gate.md](2026-10-23-amd-webgpu-only-gate.md) §1:
91 operator frames (134 boxes: 61 person, 60 animal, 13 vehicle), one
node-pinned `benchmark.runPipelineTest` per frame (`plane: 'frame'`,
object-detection alone, floors lowered to 0.3), greedy IoU ≥ 0.5 same macro;
"prod" = the model's `defaultClassFloors` row. Engine `python+openvino` on every
agent-a frame.

| Detector (node / device) | step p50 ms | Recall prod | FP prod | Recall @0.3 | FP @0.3 | person prod / @0.3 | vehicle prod / @0.3 | animal prod / @0.3 | small @0.3 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `yolov9m-640` Mac / `coreml:all` (reference) | 24 | 83 = 0.62 | 7 | 103 = 0.77 | 13 | 28 / 35 | 12 / 13 | 43 / 55 | 50/57 |
| `yolov9m-640-int8` hub / `openvino:gpu` (rerun today) | 42 | 70 = 0.52 | 5 | 104 = 0.78 | 12 | 30 / 37 | 11 / 13 | 29 / 54 | 49/57 |
| **`yolov9s-320-int8` agent-a (LIVE today)** | 36 | 25 = 0.19 | 4 | 43 = 0.32 | 11 | 8 / 21 | 6 / 7 | 11 / 15 | 7/57 |
| `yolov9m-320-int8` agent-a (device default) | 85 | 39 = 0.29 | 2 | 56 = 0.42 | 7 | 15 / 26 | 8 / 10 | 16 / 20 | 14/57 |
| `yolov9s-640` (FP16 IR) agent-a | 220 | 40 = 0.30 | 5 | 76 = 0.57 | 9 | 13 / 28 | 8 / 10 | 19 / 38 | 34/57 |
| `yolov9m-640` (FP16 IR) agent-a | 338 | 83 = 0.62 | 8 | 103 = 0.77 | 12 | 28 / 35 | 12 / 13 | 43 / 55 | 50/57 |
| `yolov9m-640-int8` agent-a | — | does not load | | | | | | | |
| `yolov9s-640-int8` agent-a | — | does not load | | | | | | | |

- **Both YOLOv9 640 INT8 IRs crash the OpenVINO GPU compile on this N100**
  (OpenVINO 2025.4.1, GPU arch v12.4.0): the probe child dies by SIGSEGV
  (`*** longjmp causes uninitialized stack frame ***`), the verdict `crashed` is
  cached in `/data/models/.ov-cache/camstack-yolov9{m,s}-640-int8.GPU.ovprobe.json`,
  and every request is refused (`native-load-crashed`). Other 640-input models
  (yunet, yolox-tiny-plate) and the YOLOv9 320 INT8 / 640 FP16 IRs compile.
- The FP16 `yolov9m-640` on the N100 gives the reference's answer (83 / 103),
  at 14× the Mac's latency.
- The hub rerun reproduces its 2026-10-22 row within one box (70 vs 71).

## 2. Capacity — agent-a `openvino:gpu`

Node benchmark already on record (`nb-mv2gn7vo`, bar e2e p95 ≤ 100 ms, drops
≤ 1 % at 10 fps): `yolov9m-320-int8` p50 53 / p95 59 ms, **kMax 2** (load 4:
p95 162 ms, drops 40 %); `yolov9s-320-int8` p50 34 / p95 41 ms, **kMax 4**.
Not rerun: its results feed the `benchmark` share source.

Closed-loop throughput (`gate/tput.mjs`, 12 gate frames, 30 s per cell, live
sessions running alongside; agent CPU 190–385 % of 4 cores, GT at 750 MHz):

| Model | C=1 fps (p50/p95 ms) | C=2 | C=4 | C=8 | saturation fps | 10 fps sessions within bar |
| --- | --- | --- | --- | --- | --- | --- |
| `yolov9s-320-int8` | 5.3 (40/67) | 9.9 (33/65) | 14.2 (43/83) | 16.7 (60/122) | ~17 | 4 (benchmark) |
| `yolov9m-320-int8` | 5.4 (65/91) | 10.1 (70/108) | 12.9 (107/200) | 13.3 (226/385) | ~13 | 2 (benchmark) |
| `yolov9s-640` FP16 | 3.9 (126/151) | 7.0 (140/205) | 8.8 (281/431) | — | ~9 | 0 (p95 > 100 ms at C=1) |
| `yolov9m-640` FP16 | 2.5 (276/364) | 2.9 (533/604) | 2.9 (1186/1812) | — | ~3 | 0 (0.3 session at any latency) |

C=1 fps is bounded by the hub→agent round trip of a 1280 px test frame, not by
the GPU; the saturation column is the comparable number.

## Verdict

- The 320 quality is **not** close to the reference: the live
  `yolov9s-320-int8` finds 0.19 of the operator boxes at its floors (person
  8/61) against 0.62 (28/61); `yolov9m-320-int8` 0.29 (15/61). Both lose the
  small subjects (7–14 of 57 vs 50).
- No better model fits on this node: the 640 INT8 IRs do not compile on the
  N100 GPU, and the 640 FP16 IRs carry 0 sessions within the bar
  (`yolov9m-640` saturates at ~3 fps — under one 10 fps camera).
- Best available on agent-a: `yolov9m-320-int8` (the device's own
  default) at maxSessions 2 — +50 % recall over today's live model for half the
  sessions. Anything that needs reference quality belongs on the hub
  (`yolov9m-640-int8`) or the Mac (`yolov9m-640`).

Raw (gitignored session scratchpad): `lu/r-lu-*.json`,
`lu/r-hub-yolov9m-640-int8.json`, `lu/summary.json`, `lu/tput.jsonl`, scorer
`lu/analyze_lu.py` (the gate scorer plus the INT8 floor rows).
