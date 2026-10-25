---
id: D745
title: Best settings picks one detector family from static hardware, and applies only the confirmed plan
status: accepted
date: 2026-10-07
supersedes:
applies-to:
  - packages/types/src/pipeline/auto-tune/**
  - packages/addon-pipeline-orchestrator/src/auto-tune/**
  - packages/addon-pipeline-orchestrator/src/attach-pipeline.ts
  - packages/addon-admin-ui/src/components/pipeline/tabs/ClusterAutoTuneTab.tsx
  - docs/benchmarks/detector-latency.json
---

## Context

The detector comparison of 2026-10-07 (`docs/benchmarks/2026-10-07-detector-comparison.md`)
measured every YOLOv9 / YOLO26 build on every accelerator class of the cluster
and calibrated per-model floors (D738–D741). The operator asked for a component
that sets the best settings for the whole cluster from those measurements:
models and thresholds only, with a confirmation, resetting every operator
override of those two things.

The default it replaces is `default-detection-model.ts`: one hand-written id
per accelerator class (`yolov9m-320-int8` on any Intel accelerator,
`yolov9m-320` on Apple), which cannot tell a Core Ultra NPU from an N100 iGPU
and ignores how many cameras a device carries.

Three things were found on the way:

- **A model pin on a single-device node was never read.** With one eligible
  device the balancer leaves the camera on the runner's default pool
  (`single-eligible-device`), and the attach read the provisioning of the empty
  key `''`, which no store writes. A model set for a Mac's `coreml:all` — and a
  camera override stored under it — silently never ran. Fixed separately
  (4101b6c3d): the default pool IS that device, so it provisions from it.
- **The existing node reset could not be reused.** `resetNodePipelineDefaults`
  drops `pipelineByAgent[node]` whole (step `enabled` flags included) and clears
  every per-camera detector setting, not only thresholds.
- **A single-device runner reports no per-device load**, so a per-device peak
  had to be read from the node-level count.

## Decision

Best settings recommends ONE family for the whole cluster — **YOLOv9**, tiers
t/s/m (no c: a few recall points for 25–50 % more latency) — so a score means
the same thing on every node. Per node it classifies the hardware from the
probe's static facts (`cpuModel`: Core Ultra, N-series, Apple base / Pro), never
from a benchmark; reads the measured latency of that class × accelerator
(`DETECTOR_PERF`, locked to `docs/benchmarks/detector-latency.json`) and the
person recall at the shipped floor (`DETECTOR_ACCURACY`, locked to
`model-floors.json`); and picks the most accurate model that fits every one of
the node's enabled accelerators with 40 % of each kept free (operator choice
30–50 %), within 0.02 recall preferring the faster. That is the data's own
step-down: m-640 → s-640-int8 before any 320. Demand is pinned cameras on their
device, always-on cameras on their standing node by weight share, and
on-motion cameras as the observed 24 h peak of concurrent sessions per device
(in memory, fed by every runner census); under 24 h of observation a fixed
estimate is used — a quarter of the on-motion cameras, at least two, spread over
the nodes then by weight — and the plan says so. A CPU fallback device gets its
own pick; a Coral is never touched (no YOLOv9 build), only warned about. An
offline node, a node without hardware facts or catalog, and an unmeasured
hardware class are skipped and named.

The apply writes only through the authorities that already own each value
(D62): the node pin `inferenceDevices[device].steps['object-detection'].modelId`;
the removal of every other in-scope step pin (embeddings excluded — changing one
forces a re-index) and of every model-bound key and its binding, at node level
and per camera (`stepOverridesByDevice[node]` and the wholesale
`pipelineByAgent[node]` snapshot, recursively, keeping `enabled`, `children`,
`jumpDeviceKey` and other settings — the attach provisions the node pin over the
snapshot, so stripping its pin makes the recommended model run); and the
removal of the model-bound thresholds in the detector's per-camera store
(`pipelineExecutor.clearModelBoundDeviceOverrides`). Threshold VALUES are never
written: removing the overrides lets each model's catalog defaults apply.
`stepToggles`, device enablement, pins, recording, notifications, zones and
rules are never touched. The plan is a dry run with a `planHash` over every
write; the apply recomputes it and answers `stale` with the fresh plan when the
hash differs, so exactly the confirmed diff is written. Models are downloaded to
their nodes before any write, and a failed download aborts with nothing written.
There is no undo — the operator chose confirmation only.

## Consequences

- A re-measurement replaces `detector-latency.json`, `model-floors.json` and
  `detector-performance.ts` together; the specs fail until they agree.
- The Apple M2 column is measured for m-320 / m-640 / s-640 / t-640 (M2 ≈ 1.0–1.2×
  the M3 Pro on the Neural Engine); its other cells are M3 Pro × 1.2 and carry
  `measured: false`, shown as "estimated" in the plan.
- The per-camera detector store is not node-scoped: clearing it reaches cameras
  that run on a skipped node; the plan warns.
- An N100 carrying two 10 fps cameras at once does not fit `yolov9m-320-int8`
  with 40 % kept free (26 fps × 0.6), so Best settings recommends a lighter model
  than today's default there. That is the data, not a bug — the operator sees it
  before applying.
- `default-detection-model.ts` stays the zero-config default; its "never 640"
  note concerns an automatic default, not an operator-confirmed pick.

## Enforcement

- `packages/types/src/pipeline/auto-tune/__tests__/recommend.spec.ts` — the
  operator's three nodes as fixtures; the tie rule, the one-model-per-node rule
  and the single-session fit each fail when removed.
- `.../detector-performance.spec.ts` — the tables equal the benchmark JSON.
- `packages/addon-pipeline/src/detection-pipeline/__tests__/detector-performance-catalog.spec.ts`
  — every id the table can pick is a catalog model with the right build.
- `packages/addon-pipeline-orchestrator/src/__tests__/auto-tune-plan-diff.spec.ts`
  — an allow-list over a deep diff of both blobs: only model pins and bound keys
  change (fails when the snapshot is dropped whole or settings are stripped).
- `.../auto-tune-service.spec.ts` — stale hash, failed download, offline
  node and concurrent apply each write nothing they should not.
- `.../attach-pipeline-single-device.spec.ts` — the single-device pin is read.
