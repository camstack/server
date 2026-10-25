---
id: D928
title: A benchmark on an exclusive device (Edge TPU) runs through the live pool
status: accepted
date: 2026-10-24
supersedes:
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/engine/benchmark-pools.ts
---

## Context

D910 gave every benchmark (a one-shot `runPipeline` image call, what
`benchmark.runPipelineTest` sends) a separate worker per device, so a cold
compile that kills its worker cannot take live detection down. An Edge TPU
cannot be opened by that second worker: libedgetpu holds a Coral exclusively
for the process that opened it. On the dev hub (1.2.619) every benchmark of a
Coral the cameras' pool already held failed, and the eval tooling had to force
its runs onto the live pool with `replay: true` (`EVAL_LIVE_POOL=1`).

The alternative was to keep the separate pool and let it fail: the only Coral
measurements then come from an idle node, which on a working hub never happens.

## Decision

A benchmark on a device whose backend is exclusive — today only `edgetpu` —
is served by that device's LIVE pool (`factoriesByDevice`, or the node-default
pool when the Coral is the node's engine), as one more request on its queue.
Every other backend (OpenVINO, CoreML, CUDA, ONNX, CPU) keeps the separate
D910 benchmark pool. The model-load history of such a run stays
`bench:<deviceKey>`, so a model the benchmark cannot load is not backed off on
the live device.

## Consequences

- A benchmark's model on a Coral is loaded into the cameras' pool. A model
  outside the co-compiled set may displace the live model from the TPU's cache
  until the next swap (D724) — the price of measuring at all.
- The live pool has no priority lane: a benchmark request queues under the
  same in-flight cap as live frames.
- A new exclusive backend is one entry in `EXCLUSIVE_BACKENDS`.

## Enforcement

`benchmark-never-loads-into-live-pool.spec.ts` (an `edgetpu:usb` benchmark
loads into the live pool and builds no benchmark pool; an `openvino:gpu` one
still builds its own) and `benchmark-pools.spec.ts`.
