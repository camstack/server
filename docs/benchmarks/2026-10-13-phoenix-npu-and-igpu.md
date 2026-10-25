# AMD Phoenix on Proxmox — NPU avenues and the iGPU path (2026-10-13)

covers:
  - packages/addon-pipeline/python/webgpu_isolated.py
  - packages/system/src/builtins/platform-probe/amd-npu.ts
applies-to:
  - packages/addon-pipeline/python/webgpu_isolated.py
last-verified: 2026-10-13

Node: CT201 `camstack-amd-agent` (192.0.2.136) on the PVE host, Ryzen 5
7640HS, Radeon 760M (gfx1103, RADV, Mesa 25.2.8), XDNA1 NPU `1022:1502`,
kernel `7.0.2-6-pve`, in-tree `amdxdna`, XRT 2.27 (`/opt/xilinx`), 6 vCPU,
8 GB. Dev hub: CT200 `camstack-hub-dev` (192.0.2.50). Decision record:
[D845](../decisions/adr-0845-a-webgpu-device-is-refused-without-an-openable-render-node-and-the-plugin-ep-is-registered-once-per-process.md).

Lab toolchains live in `/opt/npu-lab` on CT201 (`venv`: ORT 1.31.0 +
`onnxruntime-ep-webgpu` 0.4.0, IREE, ncnn/pnnx; `ironenv`: mlir-aie 1.4.4 +
Peano; `mlir-aie-src` at v1.4.4). CT201 snapshot before any of it:
`pre-npu-igpu-20261013`. The bench scripts (`igpu_bench.py`, `iso_bench.py`,
`pool_driver.py`, `dual3.py`) are in that directory; raw outputs under `/tmp`
of CT201 for the session.

**All numbers below were taken while the CI runners on the same host were
busy (host load 7–27).** They are consistent across repeats but not quiet-box
numbers; the Auto-tune column is NOT filled from them (§4).

## 1. NPU — four avenues, one verdict

| Avenue | Run | Verdict | Decisive evidence |
| --- | --- | --- | --- |
| (a) IREE + `iree-amd-aie` | not runnable | **no-go** | No releases, no wheels (README: build IREE from source with the plugin, pinned `xdna-driver` commit `20e1f74` ≠ the in-tree driver here); CI uploads only Actions artifacts, last green `ci-linux` 2026-06-02 (expired), last commit on `main` 2026-06-03 — dormant; e2e tests cover matmul/conv, no detector. A full LLVM+IREE build on 6 cores / 8 GB next to the CI runners is out of budget. |
| (b) mlir-aie / IRON | **ran** | toolchain **works**, detector **no** | `mlir_aie` 1.4.4 + `llvm-aie` nightly wheels install on Python 3.12; `programming_examples/basic/vector_scalar_add` built with Peano and **PASS**ed on `[0000:66:00.1] RyzenAI-npu1` through XRT 2.27 + in-tree `amdxdna` (needed `cmake ≥ 3.30` from pip). No ONNX front-end: `programming_examples/ml` holds hand-written conv2d/resnet/mobilenet kernels. A YOLO on this path is a kernel-authoring project, not an integration. |
| (c) Older Ryzen AI with Phoenix on Linux | not applicable | **no-go** | Release notes never list PHX/HPT for Linux in any version (1.5–1.8); Linux support starts at Strix. Confirms the 2026-10-10 fingerprint abort. |
| (d) Windows VM + NPU passthrough | not built | **feasible, ask first** | `66:00.1` (NPU) is alone in IOMMU group 25 (`66:00.0` dummy function in group 24), PVE 9.2.2, so `vfio-pci` passthrough of the NPU function is clean and the iGPU stays on the host. Ryzen AI on Windows supports Phoenix (CNN INT8). Needs: a Windows ISO + licence (operator), and a CamStack **Windows node** (none exists) — the NPU would serve nothing until that product exists. |

Value check: the NPU is ~10 TOPS INT8 for CNNs; after §2 the iGPU already
does yolov9t-320 in 13 ms and m-320 in 52 ms. **No `vitisai:npu` / `iree:npu`
device is added.**

## 2. iGPU — the "weak WebGPU" was a permission

### 2.1 The EP is fast; CamStack never reached the GPU

Standalone ORT WebGPU EP (lab venv, as root), warm p50 of `session.run`,
letterboxed `3-persons.jpg`:

| Model | WebGPU ms | CPU ORT ms | 10-10 CamStack table ms |
| --- | ---: | ---: | ---: |
| yolov9t-320 | **12.7** | 21.9 | 192 |
| yolov9t-640 | **31.5** | 114 | 660 |
| yolov9s-320 | **22.7** | 62 | 401 |
| yolov9s-640 | **63.6** | 297 | 1410 |
| yolov9m-320 | **52.2** | 195 | 1059 |
| yolov9m-640 | **169.6** | 101 | shed @3000 |
| yolo26n-320 | 15.1 | 14.1 | 278 (cold) |

Same script inside the agent container, same venv, as root: 13.5 ms. Through
the real `WebGpuIsolatedSession` child + pickle pipes: 18.0 ms (IPC ≈ 5 ms).
Through the real `inference_pool.py` over its wire protocol (as root):
`predictMs` 36 ms / `inferenceMs` 44 ms / wall 57 ms under CI load.

Under the entrypoint's exact drop (`gosu camstack:camstack`):
`open('/dev/dri/renderD128')` → **EACCES**; the same bench still reports
`providers=[WebGpuExecutionProvider, CPUExecutionProvider]` and runs at
**223.6 ms** with `gpu_busy_percent` 0. The live pool's ten children had
`Groups:` empty, no `/dev/dri` fd, one at 219 % CPU with 173 CPU-minutes, GPU
busy 0 % — the whole 10-10 table was this path. Forcing `VK_ICD_FILENAMES` to
llvmpipe makes Dawn refuse ("No supported adapters") and fall back to the CPU
EP at 27 ms, so the 224 ms path is not llvmpipe either; it is whatever Dawn
does with a radeon ICD whose node it cannot open. Dawn never reports it.

### 2.2 Concurrency

- K processes, one session each, yolov9t-320 (30 iterations each):

  | K | per-process p50 ms | aggregate fps | gpu_busy mean / max |
  | ---: | ---: | ---: | --- |
  | 1 | 12.7 | 79 | 8 / 19 |
  | 2 | 22.4 / 22.6 | 89 | 28 / 52 |
  | 3 | 33.3 × 3 | 90 | 49 / 71 |
  | 4 | 44.7 × 4 | 90 | 63 / 82 |

  One GPU queue: perfectly serial, no crash, no degradation beyond the
  serialisation. VRAM 122 MB per session (UMA, 4 GB).
- Two sessions in ONE process (the D823 crash): reproduced with ORT 1.31 /
  EP 0.4.0 — **only** when `register_execution_provider_library` is called
  again (it raises `EP library is already registered`; the next session then
  segfaults in `_create_inference_session`). Registering once: same model
  twice, different models, run-then-create, delete-then-create — all fine.
  CamStack's loader re-registered per session and swallowed the raise.
- Three sessions in one process, `run()` from three threads: **abort**
  unserialised; **17.6 / 18.3 / 37.9 ms** (t, t, s) under one lock.
- EP options (`enableGraphCapture`, `validationMode=disabled`,
  `preferredLayout=NHWC`, `storageBufferCacheMode=bucket`,
  `powerPreference`): no change (12.9–13.7 ms). `intra_op_num_threads`
  1 / 2 / 6: 14.2 ms each. fp16 via `onnxconverter-common`: the converted
  graph fails to load (`Resize` cast mismatch, also with `op_block_list`) —
  not pursued.

### 2.3 Alternative GPU runtimes on gfx1103 (measured, not adopted)

| Path | yolov9t-320 | Note |
| --- | ---: | --- |
| IREE `vulkan` (`iree-import-onnx` → `--iree-vulkan-target=rdna3`) | **9.4 ms** | Prebuilt wheels; one new runtime + model format; multi-module in-process by design. Worth a spike if the iGPU ever becomes the bottleneck. |
| ncnn Vulkan (pnnx) | converted (param/bin) | Not timed; same cost class as IREE. |
| ORT MIGraphX / ROCm | — | gfx1103 unsupported; `HSA_OVERRIDE_GFX_VERSION=11.0.0` would need `/dev/kfd` in CT201 (present on the host, not passed) and multi-GB userspace. Not attempted. |
| OpenVINO GPU | — | Intel-only plugin; no-go by construction. |

### 2.4 What changed (D845) and the live before/after

1. `Dockerfile` entrypoint owns `/dev/dri/renderD*` and `/dev/dri/card*`
   for `camstack` (the loop named `/dev/accel/render*`, a non-path).
2. `webgpu_isolated.py`: register the plugin EP once per process; refuse a
   `webgpu` device with no openable render node (`WebGpuDeviceUnavailable`,
   names uid/gid/groups); `intra_op_num_threads = 2`.
3. Tests: `test_webgpu_isolated.py` `LoaderTests` / `RenderNodeProbeTests`
   (13 pass; the register-once test goes red with the guard disarmed).

Applied on CT201 by hand (entrypoint is bind-mounted from
`/opt/camstack/docker-entrypoint.sh`; the loader copied into
`/data/addons/@camstack/addon-pipeline/python/`, originals kept as
`*.bak-20261013`) and the container restarted:

| | before | after |
| --- | --- | --- |
| `/dev/dri/renderD128` in the container | `root:993` | `camstack:camstack` |
| container CPU (live cameras) | 475–568 % | 17–21 % |
| container RAM | 4.6–4.8 GB | 3.3–3.6 GB |
| `gpu_busy_percent`, 60 s with sessions | 0 / 0 | mean 26.6, max 52 |
| busiest WebGPU child | 219 % CPU | ≤ 3 % CPU |

The addon change still needs a real `camstack deploy … -n agent-b` and
the entrypoint fix an `amd-*` image build; the hand patch is what is running.

## 3. GPU section summary

| Question | Answer |
| --- | --- |
| Is the 760M weak? | No. 2–5× faster than ORT CPU at every yolov9 size; the pool never reached it. |
| Multiple concurrent sessions? | Yes: N processes serialise on the queue with flat aggregate throughput; in one process they work when registered once and run under one lock. |
| Bottleneck now | CPU-side dispatch (13 ms for t-320 is mostly Dawn/CPU; GPU busy 8 %); larger models are GPU-bound (m-640 at 60–89 % busy). |

## 4. What stays open

- **Re-measure `amd-phoenix/amd-igpu`** (`detector-latency.json`,
  `DETECTOR_PERF`) with `scripts/bench-detector-latency-column.mjs` once the
  image carrying the entrypoint fix runs on the node — the current cells are
  the software path. Needs a dev-hub (.50) session or admin token, which this
  session did not have.
- `amd-phoenix/x86-cpu` (OpenVINO INT8) is unaffected.
- IREE-Vulkan as a runtime: a spike, only if needed.
