---
title: Benchmark
last-verified: 2026-10-23
applies-to:
  - packages/addon-benchmark/**
  - packages/addon-pipeline-orchestrator/src/node-benchmark/**
  - packages/addon-pipeline/src/pipeline-runner/node-bench/**
  - packages/types/src/pipeline/node-benchmark/**
  - packages/types/src/capabilities/pipeline-runner.cap.ts
covers:
  - packages/addon-benchmark/**
  - packages/addon-pipeline-orchestrator/src/node-benchmark/**
  - packages/addon-pipeline/src/pipeline-runner/node-bench/**
  - packages/types/src/pipeline/node-benchmark/**
  - scripts/bench-clip/**
  - scripts/eval/**
---

# Benchmark

Benchmark answers **what one node can carry**, measured on the node itself,
and feeds that answer to Auto tune and the automatic shares (D791). The
Admin page (`@camstack/addon-benchmark`, **Detection → Benchmark**) has three
sections: **Node benchmark**, **Image** (one run of a step tree on one image)
and **Audio** (one classification of a reference sound) — D792.

It is not the folder `docs/benchmarks/*` (hand-run evaluation records).

The **static Auto-tune latency table** (`detector-latency.json` /
`DETECTOR_PERF`, D745) is a different measurement: single-request warm median
via `runPipelineTest`, one column at a time. Procedure:
skill `camstack-benchmark-detection` and
`scripts/bench-detector-latency-column.mjs`. A `runPipelineTest` call loads its
models into a benchmark pool of its own, never the live detection pool (D910,
[detection-execution.md](detection-execution.md)); the pool is kept between calls,
so the timed runs are warm and on the same device.

## Who owns what

| Part | Owner | Where |
| --- | --- | --- |
| Lifecycle, benchmark mode, results store | `pipeline-orchestrator` (hub) | `src/node-benchmark/` |
| The measurement | `pipeline-runner` on the measured node | `src/pipeline-runner/node-bench/` |
| Plan editor, status, results table | `addon-benchmark` page | `src/node-benchmark/` |
| Shapes and pure rules | `@camstack/types` | `src/pipeline/node-benchmark/` |

The orchestrator owns the run because entering benchmark mode is a
placement change, and only the owner of placement can promise to undo it.
The runner measures because frames must not cross a node per call (D9). The
page holds only the operator's draft.

## Lifecycle

```
start ─► preflight ─► manifest (persisted) ─► mode on ─► draining
      ─► measuring (runner polled every 3 s) ─► restoring ─► done | failed | aborted
```

- **One run cluster-wide.** `startNodeBenchmark` refuses while another is
  active (and on an offline node, an unknown device, or when the other
  nodes' capacity does not cover today's parallel sessions — that one is
  overridable).
- **Benchmark mode** (`NodeTopologyService.detectionEligibleNodes`,
  `readPipelinePin`): the node is not a candidate for any camera another node
  can serve, and a node pin naming it reads as "no pin" for that camera.
  Nothing stored changes. A camera whose only frame source is the node keeps
  it (never blind) and flags the run contaminated. A hub run is always
  contaminated. Device pins bind no node: they apply wherever the elected
  node offers the key.
- **Drain**: `rebalance({ onlyDeviceIds })` moves the cameras placed on or
  pinned to the node (a pinned assignment on the benchmark node is
  migratable; hysteresis never keeps a camera on a node it may not use). It
  repeats until the ledger shows none left, or refuses after 2 minutes.
- **Measure**: `pipelineRunner.startNodeBench` with `nodePin(node)`; polled
  with `getNodeBenchStatus`. A runner that forgets the run (restart) ends it
  as `runner-lost`; an offline node as `node-lost`; the budget as `deadline`.
- **Restore** (always, in a `finally`): mode off, the moved cameras
  re-placed (their pins apply again), finished cells stored, the run
  recorded, the manifest removed **last**.
- **Recovery**: the manifest (`pipeline-orchestrator:node-benchmark-mode`) is
  written before anything changes. At boot and on a 30 s reconcile, a
  manifest without a live run is restored at once and the run recorded
  `hub-restart`; the runner is told to stop, and also stops itself at the
  deadline. A live run 2 minutes past its deadline is forced out of the
  mode.

## Automatic runs ([D913](../decisions/adr-0913-balancing-is-automatic-a-new-device-is-measured-and-the-shares-follow-the-live-hardware.md))

The operator does not have to start a benchmark. `AutoBenchmarkScheduler`
(`node-benchmark/auto-benchmark.ts`) looks every minute, and at once when a
node's live device set changes: an **enabled, available, eligible** device
(`exclusion === null`) with **no usable result** gets a `device`-phase run
limited to it (one detector — Auto tune's pick — no pipeline phase, 20 min
budget), through the same `start` the operator uses, so the preflight, the
one-run lock and the restore all apply. Its completion already recomputes the
shares (`onResultsWritten` → `benchmark-results:<node>`).

- **One auto run at a time**, and none while any benchmark runs; one node per
  run, with all of its pending devices.
- **Busy node deferred**: a node carrying more than 2 cameras
  (`AUTO_BENCH_MAX_CAMERAS_ON_NODE`, ledger assignments plus running
  sessions) waits — a run moves them off and a camera with no other frame
  source would stay and spoil the numbers. The hub usually carries cameras, so
  it is measured when quiet or by hand. The preflight's own refusals
  (`insufficient-headroom`, `node-offline`, `unknown-device`) defer it too;
  `acceptInsufficientHeadroom` is never set.
- **Bounded**: a started run is retried no sooner than 15 min later
  (`AUTO_BENCH_RETRY_MS`), at most 3 times per device (`AUTO_BENCH_MAX_ATTEMPTS`).
  A refusal is not an attempt. The ledger (count + last attempt per node ×
  device) is persisted in the orchestrator's settings store under
  `autoBenchmarkAttempts` and restored before the first decision after a boot,
  so a respawn does not reset the budget or the spacing; a device that gains a
  usable result is forgotten. An unreadable ledger starts empty and says so.
- **"Usable result" is the automatic shares' own predicate**
  (`benchmarkedDevices` → `capacityForModel`): a fresh cell, `device` or
  `pipeline`, for the model the device runs NOW. A device whose only result
  is for another model, or is stale, is measured again (still bounded by the
  attempts), so an auto run can actually move a node to benchmark capacity.
- **Never** for a device the operator disabled, or one that is unplugged or
  excluded.
- Every decision is logged with `tags: { nodeId }` when it changes:
  `auto benchmark: start | wait | skip` with the reason, `started` with the run
  id. Skips for "has results" and "not eligible" are `debug`.

## The measurement

Frames are decoded **once** into RAM at 640×360: the bench clip
(`camstack-bench-v1`, one frame per second, 114 frames) when its pinned
sha256 matches, else the executor's reference images; the run says which.
Every dispatch takes the next frame, so content and detail-plane work vary.

- **Device** — per device × candidate detector, root only (`plane: 'frame'`,
  the live per-frame shape), on the open-loop pacer of the capacity ramp:
  streams 1, 2, 4, 6, 8, 12, 16, 24, 32 at the camera rate; a step passes
  while e2e p95 ≤ the frame interval, drops + sheds ≤ 1 %, no event-loop
  stall ≥ 250 ms, no error. `kMax` = last passing step; `fps` = completed
  frames per second there; p50/p95/p99 from the single stream.
- **Pipeline** — per device, its first candidate with the chosen detail steps
  (tree built on the node from its catalog, `plane: 'full'`), sessions 1, 2,
  3, 4, 6, 8, 10, 12, 16, same gate plus node CPU ≤ 85 % and free RAM ≥ 15 %.
  `stepsFired` names the steps that ran; a cell missing a requested step is
  not stored.

Nothing is emitted: the executor is called directly, so no track, event,
media or notification exists. Candidate models fetched for the run are
deleted afterwards unless the plan keeps them. Not measured: session decode,
motion, the hub tracker.

## Results and who reads them

`pipeline-orchestrator:node-benchmarks` holds one row per measured cell
(newest 500). A row is **fresh** when it is the newest for its cell
(node × device × phase × model [× steps]), younger than 30 days, and its
pool (runtime, workers, concurrency, batch mode) equals what the device runs
today; an unanswered pool never makes a row stale.

- **Auto tune** lays a node's fresh `device` cells over the hardware-class
  latency table (`recommendNode({ measured })`); each choice names its source
  (`node-benchmark` or `table`), and a node of unknown hardware is
  recommended from its measurements alone.
- **Automatic shares**: the default source is `benchmark` — each device sized
  by its freshest cell **for the model it runs now** (the one Auto tune pins
  there, `capacityForModel`): a `pipeline` cell's `maxSessions` first, else a
  `device` cell's `kMax` read as sessions one-to-one (both are "streams at
  the camera rate the hardware carried"; the device number is an upper bound,
  which is why a same-model pipeline cell always wins). A cell for another
  model is ignored and named once (`benchmark cell for another model
  ignored`, with the device key) — a failed load of a heavier build is not
  this build's capacity. A node with no usable cell falls back to `hardware`
  and says so. Writing or deleting a result recomputes the shares. Session
  caps stay advisory.

## Cap surface

`pipelineOrchestrator`: `getNodeBenchmarkPreflight`, `startNodeBenchmark`,
`getNodeBenchmarkStatus`, `abortNodeBenchmark`, `getNodeBenchmarkCandidates`,
`listNodeBenchmarkResults`, `deleteNodeBenchmarkResult`.
`pipelineRunner`: `startNodeBench`, `getNodeBenchStatus`, `abortNodeBench`.
All admin.

## The bench clip

`scripts/bench-clip/build-bench-clip.sh` builds `camstack-bench-v1` from
CC BY / CC0 / public-domain sources (MEVA, Wikimedia Commons) plus a
fictional plate drawn on a MEVA car; `NOTICE.md` is the attribution and
`bench-manifest.json` the segment list. The H.264 build is uploaded to the HF
dataset repo `camstack/camstack-bench-clips` and its sha256 pinned in
`node-bench/bench-frames.ts` (`BENCH_CLIP`).

## Operator deploy

The cap methods are a framework change: publish `@camstack/types`,
`@camstack/system` (force), the pipeline addon and the orchestrator, then
`camstack deploy packages/addon-benchmark`.

## Offline detector evaluation (`scripts/eval/`)

The benchmark addon measures models live, on the cluster. The accuracy side of
a model decision — "is this fine-tune better than what runs today, and at
which floors" — is measured offline by `scripts/eval/`, a Python harness
checked in for the cloud-training plan (P5). It replaces the scripts of the
2026-10-07 comparison, which lived in a session scratchpad and are lost.

- **Ground truth**: the hub's annotated export (`annotations.json` v2), only
  frames the operator marked complete. A pseudo ground truth from two teacher
  detectors (`camstack_eval/pseudo_gt.py`) follows the shape of the
  2026-10-07 rule; its thresholds are defaults chosen here, not that run's.
- **Pipeline-identical**: the letterbox and the YOLO decode are IMPORTED from
  `packages/addon-pipeline/python` (pool floor 0.05, NMS IoU 0.45), never
  re-implemented. ONNX Runtime CPU.
- **Metrics**: P/R at the floor, AP50, recall per camera, per day/night (the
  manifest's `lighting`, D785) and for small subjects (under 100/540 of the
  frame height), per macro class (`person`, `vehicle`, `animal`).
- **Floors**: the D739 rule (lowest floor within the baseline's false-positive
  budget at its shipped floor), plus a support threshold (default 20
  positives, else the baseline floor) and a ±0.15 clamp around the baseline.
- **Holdout**: whole cameras (`--holdout-cameras`) and/or a capture-time cut
  (`--since`), never random frames.

```bash
uv venv -p 3.12 .venv-eval && uv pip install -p .venv-eval -r scripts/eval/requirements.txt
.venv-eval/bin/python scripts/eval/evaluate.py --export set.tar \
  --baseline base.onnx --baseline-size 640 --baseline-model-id yolov9m-640-int8 \
  --candidate cand.onnx --candidate-size 106 --holdout-cameras 101,102 --out report.json
.venv-eval/bin/python -m pytest scripts/eval/tests
```

## Related

- D791 (node benchmark: mode, measurement, results), D792 (the page)
- D646 (a benchmark names its pool; no engine override)
- D755 (capacity shares, `NodeCapacitySource`), D745/D786 (Auto tune)
- Public user docs: `camstack/docs` → Tools → Benchmark
