---
id: D845
title: A webgpu device is refused without an openable render node, and the plugin EP is registered once per process
status: accepted
date: 2026-10-13
applies-to:
  - packages/addon-pipeline/python/webgpu_isolated.py
  - Dockerfile
---

## Context

The AMD Proxmox agent (`agent-b`, Ryzen 7640HS / Radeon 760M) ran its
`onnx:webgpu` pool for a week at 192–1410 ms per YOLOv9 frame
(`docs/benchmarks/2026-10-10-amd-webgpu-catalog.md`), and every crop child
was jumped to CPU because a second session in one process SIGSEGVed (D823).
The operator read both as a weak iGPU that cannot hold concurrent sessions.

Measured on 2026-10-13 (`docs/benchmarks/2026-10-13-phoenix-npu-and-igpu.md`):

- Standalone, as root in the same container and venv, the same yolov9t-320
  runs at **12.7–13.5 ms** on the WebGPU EP; four processes serialise on the
  one GPU queue at 22/33/45 ms each with aggregate throughput flat at ~90 fps.
- Under the entrypoint's exact privilege drop (`gosu camstack:camstack`),
  `open('/dev/dri/renderD128')` is **EACCES**: Docker's `group_add` reaches
  only the root shell, `gosu` clears supplementary groups, and the entrypoint's
  device loop chowned `/dev/accel/accel*` and a path that does not exist
  (`/dev/accel/render*`) instead of `/dev/dri/render*`. The session still
  reports `providers=[WebGpuExecutionProvider, CPUExecutionProvider]`, runs at
  **223.6 ms** with `gpu_busy_percent` 0, and the ten live children of the
  pool were burning 220 % CPU with no `/dev/dri` fd. Dawn never says it is on a
  software adapter.
- The D823 crash is **not** a second session. `register_execution_provider_library`
  called twice for one name raises `EP library is already registered`, and the
  next `InferenceSession` on that EP segfaults in `_create_inference_session`.
  The loader caught the raise and continued. Registering once, three sessions
  load and run in one process (17.6 / 18.3 / 37.9 ms under one lock);
  unserialised concurrent `run()` on distinct sessions aborts the process.

## Decision

1. **The entrypoint owns every accelerator node for `camstack`**:
   `/dev/accel/accel*`, `/dev/dri/renderD*`, `/dev/dri/card*`. The container's
   `/dev` is its own tmpfs, so the chown never touches the host node.
2. **A `webgpu` device with no openable `/dev/dri/renderD*` is refused**
   (`WebGpuDeviceUnavailable`) before any session is built. The error names
   the process identity and the fix. A missing plugin or a missing Vulkan
   adapter still falls back to the CPU EP and says so in `providers` — those
   paths tell the truth; the render-node path is the one where ORT lies.
3. **The WebGPU plugin EP is registered at most once per process**
   (`_ensure_webgpu_ep_registered`, lock-guarded). D823's child-per-model
   layout stays, for crash isolation; its "second session crashes" context is
   superseded by this record.
4. WebGPU sessions get `intra_op_num_threads = 2`: measured no latency change
   between 1, 2 and 6 threads, and the default spun one thread per core in
   each of ten children on a six-core node.

## Consequences

- An AMD node whose render node is not reachable now shows a model-load
  error naming `uid/gid/groups` instead of a silent 15× slowdown.
- `jumpDeviceKey` to CPU for crop children on `onnx:webgpu` is no longer a
  workaround for a crash; it is an ordinary placement choice.
- The `amd-phoenix/amd-igpu` column of `detector-latency.json` was measured
  on the software path and must be re-measured with the harness after the
  image carrying this entrypoint is on the node.
- A future in-process layout (one Dawn device, one lock, no pickle IPC) is
  possible and measured; it is not adopted here because a Dawn abort would
  take every model with it.

## Enforcement

- `packages/addon-pipeline/python/test_webgpu_isolated.py` — `LoaderTests`
  (register once; the disarmed guard makes the second load a CPU fallback;
  refusal without a render node; bounded threads) and `RenderNodeProbeTests`.
- Live: on `agent-b` after the restart, `gpu_busy_percent` > 0 while the
  pool serves frames and the container's CPU share drops; both recorded in the
  benchmark page.
