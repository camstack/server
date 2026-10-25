---
id: D823
title: ONNX WebGPU holds one InferenceSession per OS process
status: accepted
date: 2026-10-10
applies-to:
  - packages/addon-pipeline/python/webgpu_isolated.py
  - packages/addon-pipeline/python/inference_pool.py
---

## Context

> **Amended by [D845](adr-0845-a-webgpu-device-is-refused-without-an-openable-render-node-and-the-plugin-ep-is-registered-once-per-process.md)
> (2026-10-13).** The crash below was a second
> `register_execution_provider_library` call, not a second session: registered
> once, several sessions load and run in one process (serialised). The
> child-per-model layout stays for crash isolation; the premise is corrected.

On `agent-b` (ORT WebGPU EP + RADV), loading a second `InferenceSession`
in the same Python process SIGSEGVs the worker (`signal=SIGSEGV`, exit -11).
Reproduced 2026-10-10: same-process yolo26n then yunet → death; two OS
processes with one session each → both load and infer concurrently.

OpenVINO and CoreML already keep many models in one process; Coral has its
own co-compiled-set rule (D724). Applying process isolation to every
backend would waste RAM for no gain. The limit is WebGPU/Dawn-specific.

`numWorkers > 1` on `SharedInferencePool` does not help: every worker loads
the full model set, so each process would still hold N WebGPU sessions.

## Decision

On `device=webgpu`, the pool parent never constructs an ORT WebGPU
`InferenceSession`. Each WebGPU model slot is an isolated child process
(`webgpu_isolated.py`) with exactly one session; predict/unload go over a
length-prefixed pickle channel on **dedicated pipe fds** (`pass_fds`) — never
stdin/stdout (ORT/Dawn logs on fd 1 corrupted large yolov9 replies). Framing
uses exact-length reads (pipe `read(n)` may return short). Other ONNX devices,
OpenVINO and CoreML stay in-process.

## Consequences

- A multi-step tree (OD + face/plate/…) on `onnx:webgpu` can load without
  SIGSEGV; RAM scales with the number of WebGPU models (one Python child each).
- CPU fallback inside the child (missing plugin / no adapter) still runs in
  that child — harmless, still isolated.
- Unload must `close()` the handle so children do not leak.

## Enforcement

- `packages/addon-pipeline/python/test_webgpu_isolated.py` — IPC framing and
  parent open/predict/close with a fake child.
- Live: `runPipelineTest` OD + face child on `agent-b` / `onnx:webgpu`
  must not SIGSEGV (catalog note in
  `docs/benchmarks/2026-10-10-amd-webgpu-catalog.md`).
