---
name: camstack-benchmark-detection
description: Measure detector latency for Auto tune (DETECTOR_PERF / docs/benchmarks/detector-latency.json) on a live node×device — warm median via runPipelineTest, apply into the JSON+TS tables locked by D745, and record the method. Use whenever filling or refreshing a hardwareClass/accelerator column (Intel NPU/iGPU, Apple ANE, AMD iGPU WebGPU, CPU), after a new accelerator ships, or when the operator asks for "detector latency table", "benchmark detection models", or "update DETECTOR_PERF". Not the node capacity ramp (Node benchmark / D791) and not offline accuracy (scripts/eval/).
---

# Benchmark detection latency (Auto tune column)

This skill fills **one column** of the static latency table Auto tune reads
([D745](../../../docs/decisions/adr-0745-best-settings-picks-one-detector-family-from-static-hardware-and-applies-only-the-confirmed-plan.md)):

| Artifact | Role |
| --- | --- |
| `docs/benchmarks/detector-latency.json` | Source of truth (columns + `_about`) |
| `packages/types/src/pipeline/auto-tune/detector-performance.ts` | `DETECTOR_PERF` — must equal the JSON |
| Spec | `packages/types/src/pipeline/auto-tune/__tests__/detector-performance.spec.ts` |

It is **not** the Admin "Node benchmark" capacity ramp
(`docs/architecture/benchmark.md`, D791). It is **not** the offline accuracy
harness (`scripts/eval/`). Those stay separate.

Long-form context: `docs/architecture/inference-devices.md`,
`docs/benchmarks/2026-10-07-detector-comparison.md` (how Intel/Apple were
first measured), AMD WebGPU catalog
`docs/benchmarks/2026-10-10-amd-webgpu-catalog.md`.

## 0. Workflow

1. **Identify the cell** — `hardwareClass` / `accelerator` / `nodeId` /
   `deviceKey` / model format (§1).
2. **Preflight the node** — device enabled+available; models downloadable (§2).
3. **Measure** with `scripts/bench-detector-latency-column.mjs` (§3).
4. **Apply** into JSON + `DETECTOR_PERF` together; run the lock spec (§4).
5. **Document** `_about`, sessions, inference docs if the platform is new (§5).
6. Paste the done-gate (§6).

## 1. Map node → column

| Live deviceKey | Typical hardwareClass | Accelerator cell | Format |
| --- | --- | --- | --- |
| `openvino:npu` | `intel-core-ultra` | `intel-npu` | `openvino` (prefer `-int8` rows when that IR exists) |
| `openvino:gpu` | `intel-core-ultra` / `intel-n-series` | `intel-igpu` | `openvino` |
| `onnx:webgpu` | `amd-phoenix` | `amd-igpu` | `onnx` |
| `coreml` / `coreml:ane` | `apple-m-base` / `apple-m-pro` | `apple-ane` | Core ML package |
| `cpu` | matching class | `x86-cpu` / `arm-cpu` | `onnx` |
| `openvino:cpu` | `amd-phoenix` (Zen4) etc. | `x86-cpu` (INT8 rows) | `openvino` |

Confirm with:

```bash
node scripts/hub/hub.mjs GET pipelineOrchestrator.getNodeInferenceDevices '{"nodeId":"<node>"}'
```

Both `available` and `enabled` must be true. CPU / `openvino:cpu` are often
opt-IN — enable only for the measurement window if the operator agrees, then
restore.

**Auto tune family (default models):** YOLOv9 `t|s|m` × `320|640` (plain ids
for the accelerator's native format; `-int8` only where that IR is what the
device runs). Do not put YOLO26 / classifiers into `DETECTOR_PERF` — the lock
spec refuses non-`yolov9[tsm]-(320|640)(-int8)?` ids.

## 2. Preflight

```bash
camstack login                   # cached session; the hub URL: scratchpad/.hub-url or CAMSTACK_HUB_URL
# Optional: download every model first via pipelineExecutor.downloadModel
```

Hub auth for the harness: same as `camstack-diagnose` — run
`camstack login <host>` once (as an admin); every tool uses that session. The hub
URL: `scratchpad/.hub-url` (gitignored) or `CAMSTACK_HUB_URL`. Never commit tokens.

**WebGPU / AMD notes (D823):** each WebGPU model is one OS child
(`webgpu_isolated.py`). Multi-step trees are fine. Recycle the pool between
models so cold/warm are honest (`restartAddon(detection-pipeline)`). A model
that hits the ~3 s shed deadline even warm is **omitted** from the column
(record it under `failed` in the harness output) — do not invent a p50.

## 3. Measure (the harness)

```bash
node scripts/bench-detector-latency-column.mjs \
  --node <nodeId> \
  --device <deviceKey> \
  --column <hardwareClass>/<accelerator> \
  --format <onnx|openvino> \
  --out scratchpad/detector-latency-<hardwareClass>-<accelerator>.json
```

Defaults: Auto-tune YOLOv9 set, `object-detection`, `3-persons.jpg`, 3 warm
runs, pool recycle between models.

Per model the script:

1. ensures the format is downloaded;
2. `nodes.restartAddon({ addonId: 'detection-pipeline' })` + sleep + `rearmInferenceDevice`;
3. 1 cold + N warm `benchmark.runPipelineTest` (`plane: 'frame'`, alone);
4. `p50Ms` = median of warm `inferMs` (from `stepLatencyMs` / `stepTimings` /
   `predictMs` / `totalInferenceMs`);
5. `fps` = `round(1000 / p50Ms)` for single-request columns (OpenVINO
   multi-request fps from the 2026-10-07 comparison stays hand-transcribed —
   do not overwrite those cells with this harness unless you re-measure the
   4-in-flight method and say so in `_about`).

Raw JSON stays in `scratchpad/` (gitignored). Keep a pointer in
`detector-latency.json` `_about`.

## 4. Apply into the locked pair

1. Merge `cells` into `docs/benchmarks/detector-latency.json` under
   `"<hardwareClass>/<accelerator>"`. Set `measured: true` on the column when
   every kept cell was measured on the box. Update `_about` (date, method,
   omissions).
2. Mirror the same cells into
   `packages/types/src/pipeline/auto-tune/detector-performance.ts`
   (`DETECTOR_PERF[hardwareClass][accelerator]`).
3. Prove the lock:

```bash
npx vitest run packages/types/src/pipeline/auto-tune/__tests__/detector-performance.spec.ts
```

A change that touches only one of the two files is wrong — the spec fails
until they agree.

## 5. Documentation after a new / refreshed column

| Touch | When |
| --- | --- |
| `../planning/sessions/<YYYY-MM>.md` | always — append the current month file: node, device, which cells, omissions |
| `docs/architecture/inference-devices.md` | fleet table / AMD / new accelerator |
| `docs/benchmarks/2026-10-10-amd-webgpu-catalog.md` | AMD WebGPU availability / multi-session |
| `docs/design/2026-10-08-amd-phoenix-proxmox.md` | AMD platform leftovers |
| the planning board | clear "measured columns" leftovers when done |
| Comparison narrative (`2026-10-07-detector-comparison.md`) | only if you add a full matrix section; otherwise the JSON `_about` is enough |

English only under `docs/**`. No host IPs or tokens in committed prose.

## 6. Done-gate

```
BENCHMARK DETECTION DONE — <hardwareClass>/<accelerator> on <nodeId>
deviceKey:     <key>  format: <onnx|openvino|…>
models ok:     <list>   omitted: <list + reason>
raw:           scratchpad/detector-latency-….json
json+ts:       detector-latency.json + detector-performance.ts (equal)
vitest:        detector-performance.spec.ts green
docs:          <files> | none
```

## Trap list

- **`(data ?? [])` style emptiness** — an unanswered run is not a 0 ms cell;
  omit or fail the model.
- **Leaving a second model resident** — always recycle between models on
  WebGPU (and prefer recycle everywhere so cold is real).
- **Using Node-benchmark fps** for this table — different measurement; label
  it if you ever mix methods.
- **Enabling CPU globally** and forgetting to restore after a CPU-column
  measurement.
- **YOLO26 in DETECTOR_PERF** — Auto tune family is YOLOv9 only (D745).
