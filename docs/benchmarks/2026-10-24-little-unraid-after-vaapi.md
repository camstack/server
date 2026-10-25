# agent-a after VAAPI decode — detector latency and a model recommendation (2026-10-24)

applies-to:
  - docs/benchmarks/detector-latency.json
  - packages/types/src/pipeline/auto-tune/detector-performance.ts
  - scripts/bench-detector-latency-column.mjs
last-verified: 2026-10-24

Question: hardware decode is on (image `intel-1.2.621`, OpenVINO 2025.4.1). The
live detector is `yolov9t-640-int8` with `maxSessions` 3, dropped there while
decode still competed for the CPU. What does `openvino:gpu` sustain now, and
which model should the node run?

Nothing in the node's settings was changed. The latency harness restarts
`detection-pipeline` between models (the benchmark pool, not the device pin).
After the run the pin was still `object-detection` = `yolov9t-640-int8`,
`maxSessions` 3, `cpu` disabled. There is no `openvino:npu` on this node, so
that column was not measured. `cpu` is present and disabled, so it was not
enabled for a measurement.

## 1. Before state (10:06:36–10:17:06 UTC, 22 samples, 30 s)

Read-only. Placement for the hour before the window: agent-a
`sessionsNow` 1 at the first read, `peakSessions` 3, observed share 0.23.
Effective share 19.8 % (`source: benchmark`, weights Mac 40 / hub 40 /
agent-a 20 / agent-b 1). That benchmark is `nb-mv2gn7vo`
(`openvino:gpu`, pool `numWorkers` 1, `concurrency` 1): `yolov9m-320-int8`
p50 53 ms, kMax 2; `yolov9s-320-int8` p50 34 ms, kMax 4. It does not contain
the live `yolov9t-640-int8`. D928 does not apply: OpenVINO keeps a separate
benchmark pool.

| | idle samples | one camera | two cameras |
| --- | --- | --- | --- |
| samples | 9 | 11 | 2 |
| container CPU | 6–9 % | 44–150 %, one sample 331 % (load 3.08) | both in the 44–150 % band |
| GPU | RC6 100 %, 0 MHz | requested ~700–750 MHz, RC6 32–48 %, package power ~0.7–1.5 W | same wake-up |

Engine-busy columns in `intel_gpu_top` stayed 0 on every 1 s slice, including
while frequency and RC6 showed the GPU awake. RAM available stayed 8.0–9.1 GB
of 15.8 GB; the container held ~3.5–3.7 GiB. The decode worker's lifetime
`%CPU` was ~21–27. `decodeHwaccel` reported `vaapi`.

Every attached camera was `always-on`, configured 10 fps. Delivered
`actualFps` on the 12 metric samples had median 7.0 (range 5.2–7.9).
`droppedFrames` was 0 on every sample. Node `avgInferenceTimeMs` while a
camera was active was usually 50–71 ms; camera 102 reached 149 ms.

`pipeline stats` over the same window (59 windows, 2 649 frames, model
`yolov9t-640-int8` on `openvino/gpu`): `dropped` summed to 0. Inference-avg
median was ~51–62 ms on the quiet cameras and 185–223 ms on 102 and 637.
A 20-minute slice ending just before the window (89 windows, 4 256 frames)
had the same shape: one camera in 65 of 77 ten-second buckets, two in 12,
`dropped` 0, frame-weighted inference 106 ms alone and 136 ms when two
cameras overlapped.

## 2. Warm median, `openvino:gpu`

Method: `scripts/bench-detector-latency-column.mjs`, format `openvino`,
`3-persons.jpg`, object-detection alone, 1 cold + 3 warm, p50 = median of
warm `inferMs`, fps = `round(1000 / p50)`. All four catalog INT8 models
compiled and returned 3 detections. The 2026-10-23 gate's GPU-compile SIGSEGV
on `yolov9s-640-int8` and `yolov9m-640-int8` did not reproduce.

| Model | cold ms | warm ms | p50 ms | fps | previous table p50 / fps |
| --- | --- | --- | --- | --- | --- |
| `yolov9t-640-int8` (live) | 124 | 55, 48, 50 | 50 | 20 | 33.1 / 33 |
| `yolov9s-640-int8` | 144 | 82, 81, 80 | 81 | 12 | 92.9 / 11 |
| `yolov9m-320-int8` | 121 | 61, 68, 66 | 66 | 15 | 39.4 / 26 |
| `yolov9m-640-int8` | 222 | 165, 163, 162 | 163 | 6 | 139.1 / 7 |

These four cells replace the 2026-10-07 transcription in
`intel-n-series/intel-igpu`. fps here is the single-request ceiling, which
matches the live pool (one worker, concurrency 1). The other cells in the
column were not re-measured. CPU-column latencies for the same ids are
206 / 185 / 226 / 324 ms, so these runs are the GPU.

## 3. Capacity and recall

Sessions use `capacitySessionsOf`: `floor(fps * (1 - headroom) / cameraFps)`.
"Observed" uses the measured median 7 fps. "Bar" uses the node-benchmark
camera rate of 10 fps. Headroom 0.4 is Auto tune's default.

Person recall is `docs/benchmarks/model-floors.json` (288 person boxes), the
number Auto tune reads. The 2026-10-23 operator-frame gate (134 boxes) did
not score `yolov9t-640-int8`; `yolov9m-320-int8` was 0.29 at its floors;
both 640 INT8 IRs did not load that day.

| Model | person recall | @7 fps, no headroom | @7 fps, headroom 0.4 | @10 fps, no headroom | @10 fps, headroom 0.4 |
| --- | --- | --- | --- | --- | --- |
| `yolov9t-640-int8` | 0.646 | 2 | 1 | 2 | 1 |
| `yolov9s-640-int8` | 0.823 | 1 | 1 | 1 | 0 |
| `yolov9m-320-int8` | 0.684 | 2 | 1 | 1 | 0 |
| `yolov9m-640-int8` | 0.847 | 0 | 0 | 0 | 0 |

`yolov9m-320-int8` buys 0.04 recall over the live model and loses throughput
(15 fps vs 20). `yolov9m-640-int8` has the best recall and cannot hold one
camera at the fps the cameras actually deliver (6 fps ceiling vs ~7 fps
delivered). Two cameras at 7 fps ask for ~14 fps, which only the live model
clears, and only with no headroom left.

## 4. Recommendation

Run `yolov9s-640-int8` with `maxSessions` 1.

Auto tune at its defaults (10 fps, headroom 0.4, at least one session) does
not say this. The refreshed `yolov9m-320-int8` cell no longer clears one
10 fps session, and the unrevised `yolov9t-640` cell (38.5 ms / 26 fps, same
person recall as the int8 twin) is the fastest cell that still does. That
cell was not re-measured today. The recommendation below uses the four cells
that were, and the fps the cameras actually delivered.

It is the only step up that still covers one camera at the measured 5–8 fps
(81 ms, 12 fps ceiling, person recall 0.823 against 0.646 today). The live
chain on a quiet camera already sits on the detector: `pipeline stats`
inference ~50 ms matches this harness's 50 ms for `yolov9t-640-int8`, so an
81 ms detector becomes an ~80 ms camera, still inside the 100 ms bar for one
stream. A second overlapping camera does not fit.

Risk: the hour before this run peaked at 3 sessions on the node, and the
window itself had two cameras at once with zero drops on the current model.
Those extra sessions will leave the node. The 19.8 % share still comes from
`nb-mv2gn7vo` (the 320 INT8 models, kMax 2 and 4), so the balancer can keep
offering this node about a fifth of sessions until that benchmark is replaced;
`maxSessions` 1 is what refuses the overflow. The 2026-10-23 GPU-compile
crash on this IR did not happen today, but a cold compile that dies the way
that gate recorded would refuse detection until the pin is put back.
