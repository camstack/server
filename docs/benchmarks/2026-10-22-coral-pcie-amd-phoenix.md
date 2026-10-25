# Two PCIe Corals on AMD Phoenix (agent-b) — step latency (2026-10-22)

covers:
  - packages/addon-pipeline/python/edgetpu-install.sh
  - packages/addon-pipeline/python/postprocessors/yolo_split_dfl.py
applies-to:
  - scripts/bench-detector-latency-column.mjs
last-verified: 2026-10-22

Node: `agent-b` (CT201 on the AMD PVE host), hardwareClass `amd-phoenix`
(Ryzen 5 7640HS, Zen4), server 1.2.608, addon-pipeline 1.2.607. Two PCIe
Edge TPUs (`1ac1:089a`), probed as `coral.units = [{ bus: 'pci', count: 2 }]`,
device keys `edgetpu:pci` and `edgetpu:pci:1`. Runtime: ai-edge-litert 2.1.6,
the feranick libedgetpu std delegate (TF 2.17.1) and `libusb-1.0.so.0` in
`/data/deps/edgetpu/lib` (installed by `edgetpu-install.sh`).

## Enablement (D39)

Both units were enabled by hand (opt-in then, D39; default-on since D912): `pipelineOrchestrator.setAgentInferenceDevices`
for `agent-b` with `edgetpu:pci` and `edgetpu:pci:1` `{ enabled: true, weight: 1 }`
beside the unchanged `openvino:cpu` (`weight: 100`). The setter REPLACES the
node's whole `inferenceDevices` map — read `getAgentSettings` first and send
every key back. The pool logged, per unit:

```
[w0] EdgeTPU: preloaded /data/deps/edgetpu/lib/libusb-1.0.so.0
[w0] EdgeTPU: delegate bound to device 'pci:0'      (edgetpu:pci)
[w0] EdgeTPU: delegate bound to device 'pci:1'      (edgetpu:pci:1)
[w0] EdgeTPU: delegate loaded from /data/deps/edgetpu/lib/libedgetpu.so.1
```

At the time Auto tune left every `edgetpu:*` key alone (`coral-untouched`, removed by D912), so enabling
the units moved no camera; at weight 1 the share policy kept choosing
`openvino:cpu` (`inference device selection … chosen: openvino:cpu, reason:
share`). No Edge TPU error in the 10 minutes after enabling.

## Method

`scripts/bench-detector-latency-column.mjs` (skill
`camstack-benchmark-detection`), one model at a time:
`restartAddon(detection-pipeline)` → `rearmInferenceDevice` → 1 cold + 5 warm
`benchmark.runPipelineTest` (`plane: 'frame'`, the step alone, reference
`3-persons.jpg`); p50 = median of the warm step latency. The step latency is
end-to-end for the step — resize/preprocess, the hop to the Python LiteRT
worker, invoke, postprocess — not the bare Edge TPU invoke. It is the figure
comparable across devices. The `openvino:cpu` comparison ran on the same node
while it served its live cameras (pessimistic).

## Results (warm p50, ms)

| Model (step) | Input | `edgetpu:pci` | `edgetpu:pci:1` | `openvino:cpu` |
| --- | --- | --- | --- | --- |
| `ssd-mobilenet-v2-coco-edgetpu` (object-detection) | 300×300 | 16 | 14 | — (tflite only) |
| `bird-classifier` (bird-classifier) | 224×224 | 10 | 9 | 10 |
| `yunet-2023mar` (face-detection) | 640×640 | 22 | 29 | 14 |
| `yolox-tiny-plate` (plate-detection) | 640×640 | 61.8 | 60.7 | 22.7 |

Cold (first request after load): 30–77 ms. Every run returned the expected
detections (3 persons, 3 faces, 1 bird label, 0 plates on a plate-less image).

## What the numbers say

- The two units are interchangeable (differences are run-to-run noise).
- On a Zen4 node OpenVINO on the CPU matches or beats the Coral per
  request; the Coral's value here is taking the work OFF the CPU, not latency.
  `yolox-tiny-plate` at ~61 ms points at operations the Edge TPU compiler left
  on the CPU (a partially mapped graph), not at the TPU.
- None of these rows enters `DETECTOR_PERF` / `detector-latency.json`
  `columns`: that table is the YOLOv9 family only (D745, enforced by
  `detector-performance.spec.ts`), the catalog has no YOLOv9 Edge TPU build,
  and the recommender never picks for a Coral. The pointer lives in that
  file's `_about.coralPcie`.

Raw harness output (gitignored scratchpad): `coral-edgetpu-pci-*.json`,
`coral-pci0-od.json`, `ovcpu-*.json`.

## Second run: the Coral USB and YOLOv9-s for the Edge TPU (server 1.2.611)

The Coral USB moved from the hub to the same node (host udev rule 0666 for
`1a6e:089a` and `18d1:9302`, LXC 201 `lxc.cgroup2.devices.allow: c 189:* rwm`
plus a bind of `/dev/bus/usb`, the agent compose mounting `/dev/bus/usb` with
`device_cgroup_rules: ['c 189:* rmw']`). It enumerates as `1a6e:089a` and comes
back as `18d1:9302` on its first invoke; device key `edgetpu:usb`, enabled at
weight 1 like the PCIe units. The YOLOv9-s rows are the community builds
mirrored on `camstack-models` (`yolov9s-320-edgetpu`, `yolov9s-512-edgetpu`,
decoded by `yolo-split-dfl`). Same harness, 1 cold + 3 warm, pool recycled
between models, node serving its live cameras.

| Model (object-detection) | Input | `edgetpu:usb` | `edgetpu:pci` | `edgetpu:pci:1` | `openvino:cpu` |
| --- | --- | --- | --- | --- | --- |
| `yolov9s-320-edgetpu` | 320×320 | 32 | 29 | 23 | — (tflite only) |
| `yolov9s-512-edgetpu` | 512×512 | 67 | 62 | 54 | — (tflite only) |
| `ssd-mobilenet-v2-coco-edgetpu` | 300×300 | 20 | 18 | 14 | — (tflite only) |
| `yolov9s-320-int8` | 320×320 | — | — | — | 29 |
| `yolov9m-320-int8` | 320×320 | — | — | — | omitted: shed at the 3 s deadline on every run |

Cold: 42–118 ms. Every kept run found the 3 persons of the reference image.

- The USB stick costs 10–40 % over the PCIe units, the transfer over the bus.
- YOLOv9-s @320 on a Coral runs at the latency `yolov9s-320-int8` has on the
  Zen4 CPU, but off the CPU. The publisher quotes ~10 ms (320) / ~21 ms (512)
  for the bare invoke; the step figure here adds preprocessing, the hop to the
  Python worker and the pure-Python split-DFL decode, which is where the gap
  is to look first.
- `yolov9m-320-int8` on `openvino:cpu` hit the 3 s shed deadline on every run
  while the same pool served the node's live cameras; it is omitted, not
  measured.
- Not done: detections compared on the operator's own cameras (the reference
  image only says the decode is right). That comparison is the gate of the
  Coral training recipe (roadmap).

Raw harness output (gitignored scratchpad): `bench-edgetpu-usb.json`,
`bench-edgetpu-pci.json`, `bench-edgetpu-pci-1.json`, `bench-openvino-cpu.json`.

## Third run: detections on the operator's cameras, and the step split

The gate of the Coral training recipe (roadmap): do the community YOLOv9-s
Edge TPU builds hold against the detectors the cameras run today, on the
operator's own frames?

### Frames and method

The annotated retrain export (`camstack.retrain-export/v3`, layout `frames`):
**91 frames from 18 cameras**, 136 operator boxes (61 person, 60 animal,
13 vehicle, 2 package — not scored), 11 operator-marked model errors, 11
frames with no subject, 23 night/IR frames, 56 frames marked complete. It is
the set the operator collected for retraining, so it leans to hard cases:
read the recalls as relative, not as the fleet's miss rate. Frames were
downscaled to 1280 px on the long side (the hub refuses a larger
`runPipelineTest` body) and run one at a time through
`benchmark.runPipelineTest` (`plane: 'frame'`, the object-detection step
alone, floors lowered to 0.3 so one run serves every threshold). Matching is
greedy by score, same macro class, IoU ≥ 0.5. "Production floors" are each
model's `defaultClassFloors` (the edgetpu builds have none and run at the
global 0.65 / 0.50 / 0.50); false positives are counted on complete frames
only.

| Detector (node / device) | Recall, production floors | Recall, floor 0.3 | FP (complete), prod / 0.3 | Small subjects (< 1 % of frame), 0.3 |
| --- | --- | --- | --- | --- |
| `yolov9m-640-int8` (hub / `openvino:gpu`, the hub's detector) | 71/134 = 0.53 | 104/134 = 0.78 | 5 / 11 | 50/57 |
| `yolov9m-640` (Mac / `coreml:all`) | 84/134 = 0.63 | 102/134 = 0.76 | 7 / 14 | — |
| `yolov9m-320-int8` (agent-b / `openvino:cpu`) | 40/134 = 0.30 | 55/134 = 0.41 | 3 / 8 | — |
| `yolov9s-320-int8` (agent-b / `openvino:cpu`) | 25/134 = 0.19 | 45/134 = 0.34 | 4 / 12 | 7/57 |
| `yolov9s-512-edgetpu` (agent-b / `edgetpu:pci`) | 27/134 = 0.20 | 50/134 = 0.37 | 3 / 11 | 12/57 |
| `yolov9s-320-edgetpu` (agent-b / `edgetpu:pci`) | 16/134 = 0.12 | 29/134 = 0.22 | 3 / 11 | 2/57 |
| `ssd-mobilenet-v2-coco-edgetpu` (agent-b / `edgetpu:pci`) | 8/134 = 0.06 | 17/134 = 0.13 | 5 / 17 | — |

Per class at the 0.3 floor (recall; median score of the true positives):

| Detector | person | animal | vehicle |
| --- | --- | --- | --- |
| `yolov9m-640-int8` | 37/61 (0.74) | 54/60 (0.75) | 13/13 (0.83) |
| `yolov9m-320-int8` | 25/61 (0.69) | 21/60 (0.63) | 9/13 (0.78) |
| `yolov9s-512-edgetpu` | 21/61 (0.53) | 20/60 (0.48) | 9/13 (0.78) |
| `yolov9s-320-edgetpu` | 12/61 (0.61) | 8/60 (0.49) | 9/13 (0.57) |

Against the hub's detector as reference (floor 0.3), `yolov9s-512-edgetpu`
finds 59 of its 138 boxes (person 23/53, animal 26/68, vehicle 10/17) and
adds 18 it does not have; `yolov9s-320-edgetpu` finds 37.

- **The decode is right; the model finds less.** A Coral box that matches the
  reference detector has median IoU 0.90 with it (p25 0.81–0.83), the same
  as `yolov9s-320-int8` on the CPU. Five to seven boxes per run carry another
  class than the reference's (the first frame of the set: a person the
  operator boxed is a `cat` at 0.82 for the 320 build).
- **Small subjects are lost.** At 320² a 16:9 frame is 320×180 of content;
  2 of 57 subjects under 1 % of the frame survive (12 at 512², 50 for the
  640 model). Large subjects are lost too, though less: 13–14 of 30 against
  19.
- **The scores are lower.** The median true-positive score is 0.48–0.61
  against 0.63–0.83, so the global 0.65 person floor halves the Coral's
  recall; these builds would need their own `defaultClassFloors` row (about
  0.3–0.4) before any comparison at production settings is fair.
- **The 17 classes are not the limit.** Person, the vehicles and the animals
  we map are all in the community label set; `package` comes from its own
  step. What is missing is accuracy, not vocabulary.
- Night/IR (36 subjects): 25 for the 640 model, 21 for `yolov9m-320-int8`,
  17 for the 512 build, 10 for the 320 build.

### Where the step time goes (warm p50 over the 91 frames, ms)

From the pool's own fields (`preprocessMs`, `predictMs` = invoke + output
copy + vectorised dequant) and the step latency the runner measures around
the call:

| Model / device | preprocess | predict | pool total | step | rest |
| --- | --- | --- | --- | --- | --- |
| `yolov9s-320-edgetpu` / `edgetpu:pci` | 3.9 | 8.9 | 12.8 | 30 | 17.2 |
| `yolov9s-512-edgetpu` / `edgetpu:pci` | 4.7 | 17.9 | 22.7 | 56 | 33.3 |
| `ssd-mobilenet-v2-coco-edgetpu` / `edgetpu:pci` | 4.4 | 6.2 | 10.6 | 18 | 7.4 |
| `yolov9s-320-int8` / `openvino:cpu` | 4.2 | 9.3 | 13.6 | 21 | 7.4 |

- The invoke is the publisher's figure (8.9 vs ~10 ms, 17.9 vs ~21 ms): the
  `std` libedgetpu is not the gap.
- "rest" is the postprocess (outside `inferenceMs`) plus the hop and the
  runner. Where the postprocess is trivial or vectorised (SSD, the OpenVINO
  YOLO decode) it is a constant 7.4 ms; for the split-DFL builds it grows
  with the cell count — about 10 ms more at N = 2100 and 26 ms more at
  N = 5376. That is the pure-Python decode: walking the whole
  `[N, 64] + [N, 17]` float32 tensor as nested lists.
- `yolo_split_dfl.py` now decodes an ndarray with numpy (same operation
  order, same candidate order, the same NMS; the list path stays for a bare
  interpreter), held equal to the list path by
  `postprocessors/test_yolo_split_dfl_numpy.py` on every existing fixture
  plus dense random scenes. Offline, on a desktop core: 4.6 → 0.4 ms at
  320² and 12.1 → 0.5 ms at 512² for a frame with a few subjects. **Not
  deployed**: the step on the node should drop to roughly 20 ms (320) and
  30 ms (512), to be measured after the next addon-pipeline deploy.

### Gate verdict (roadmap item 9)

**Fail for `yolov9s-320-edgetpu`; marginal for `yolov9s-512-edgetpu`.** At a
common floor the 512 build sits just under `yolov9m-320-int8` on the CPU
(0.37 vs 0.41 recall, 11 vs 8 false positives), and at production floors
it loses (0.20 vs 0.30) until it gets its own floors. Neither is close to
the 640-input detectors the hub and the Mac run (0.76–0.78). The community
builds are therefore no replacement for the detector on these cameras; the
Coral's value stays offloading the CPU, and a recipe trained on the
operator's frames is the only route to a Coral root detector worth running
— its own acceptance bar has to be the 640 detector's recall on this export,
not the community build's.

Side finding: loading `yolov9m-320-int8` on the hub's `openvino:gpu` through
`runPipelineTest` killed the pool worker with SIGSEGV on every one of 91
calls (`PoolWorker[w0]: worker process exited (signal=SIGSEGV)`); the same
IR ran on `agent-b` / `openvino:cpu`. Not investigated.

Raw results (gitignored scratchpad): `coral-gate/r-*.json` (one per
detector), `coral-gate/summary-prod.json`, `coral-gate/summary-common.json`,
the scorer `coral-gate/analyze.py`.

### Region crop (upper bound), and the default it led to (D908)

Same frames and Coral, but one 320 / 512 crop centred on each subject instead
of the whole frame (an upper bound: a real region needs the subject found
first). Recall at floor 0.3 of 134 boxes, and small subjects (< 1 % of frame):

| Detector | full frame | region crop | small, full frame | small, crop |
| --- | --- | --- | --- | --- |
| `ssd-mobilenet-v2-coco-edgetpu` | 18 | 91 | 2 | 35 |
| `yolov9s-320-edgetpu` | 29 | 92 | 2 | 43 |
| `yolov9s-512-edgetpu` | 50 | 81 | 12 | 40 |

The YOLO builds are never worse than the SSD on the same TPU, so
`yolov9s-320-edgetpu` became the Coral default ([D908](../decisions/adr-0908-a-coral-runs-yolov9-s-320-by-default-it-beats-the-ssd-on-the-same-tpu.md)).
