#!/usr/bin/env python3
"""Async inference pool — request_id multiplexed, per-runtime concurrency.

Per-runtime ML backends (coreml / openvino / onnx):
  - asyncio main loop reads requests from stdin; inference is dispatched
    onto a runtime-specific executor so the reader never blocks.
  - Each request carries a 32-bit id; responses are tagged with the same
    id so the Node side can keep N requests in flight concurrently.
  - Runtime executors:
      CoreML   → ThreadPoolExecutor(1) — ANE is single-context; one
                 Python thread is enough, and avoids GIL thrashing.
      OpenVINO → ThreadPoolExecutor(OPTIMAL_NUMBER_OF_INFER_REQUESTS),
                 each worker checking out an InferRequest from a fixed
                 per-model pool (created once, post-compile), with the model
                 compiled on ONE explicit device under the LATENCY hint (no
                 AUTO — its CPU->GPU handover invalidated in-flight requests).
      ONNX     → ThreadPoolExecutor(N) — N independent InferenceSessions
                 where N = concurrency setting; each session pinned to
                 its own worker thread.
  - Optional raw-frame path skips JPEG decode when the caller already
    has a decoded RGB/BGR/GRAY buffer (e.g. the stream-broker decoder
    cap output).

Startup protocol (Node → Python, v2):
  1. [4B total_len][4B req_id=0][1B msg_type=0x00][JSON config]
     config = {"runtime": ..., "models": [...], "concurrency": N?}
  2. Python responds with [4B total_len][4B req_id=0][JSON ready status].

Runtime protocol:
  Request:  [4B total_len][4B req_id][1B msg_type][payload]
  Response: [4B total_len][4B req_id][JSON payload]

  msg_type:
    0x00 — command      payload = JSON
    0x01 — infer_jpeg   payload = [1B model_idx][JPEG bytes]
    0x02 — infer_raw    payload = [1B model_idx][4B width][4B height]
                                  [1B fmt 0=RGB,1=BGR,2=GRAY][pixels]

Wire-protocol versioning (D350): the startup config may declare
`protocolVersion`; the effective wire version is `min(PROTOCOL_VERSION,
declared)` and the ready reply reports this worker's own PROTOCOL_VERSION so
the Node side can negotiate the same minimum. At v2, every SHEDDABLE request
(infer_jpeg / infer_raw / infer_batch / infer_cached) prefixes its payload
with the request's ABSOLUTE deadline — [8B epoch-ms uint64 LE] — and this
worker checks it immediately before predict, answering
`{"dropped": true, "shedReason": "deadline-expired"}` instead of executing
work whose caller has already abandoned it (the 2026-09-04 storm: 4h15m of
the accelerator at 100% on replies discarded as `unknown request id`).
Commands and model loads NEVER carry a deadline at any version — a shed
command desynchronizes model state. A host that declares nothing is an OLD
host and gets byte-identical v1 behaviour; skew in either direction is the
NORMAL state during a rolling deploy.

Commands: load, unload, replace, reconfigure, status, uncache_frame, mem_stats.
`load`/`replace` compile on their own thread under a hard bound and never block
the loop; a load past the bound answers `reason: "compile-timeout"` and poisons
the worker (D653, see `ModelLoader`).
"""
from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import gc
import io
import json
import os
import platform
import re
import shutil
import struct
import sys
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

import numpy as np
from PIL import Image

import pool_platform
from postprocessors import POSTPROCESSORS

# ---------------------------------------------------------------------------
# Wire protocol constants
# ---------------------------------------------------------------------------

MSG_COMMAND = 0x00
MSG_INFER_JPEG = 0x01
MSG_INFER_RAW = 0x02
# MSG_INFER_BATCH — N raw items packed into a single IPC frame.
# Wire format:
#   [1B model_idx][1B count][N × item]
# Each item:
#   [4B width][4B height][1B fmt][4B size][size bytes raw]
# Response payload:
#   {"results": [<single-detect dict>, ...]}  (same length as count)
# Each item is dispatched concurrently via asyncio.gather so the
# predict pool's existing parallelism applies; the saving over N
# separate calls is one IPC round-trip per item collapsed to one,
# with batch=4 semantics for fair benchmarking.
MSG_INFER_BATCH = 0x03
MSG_CACHE_FRAME = 0x04
MSG_INFER_CACHED = 0x05

RAW_FMT_RGB = 0x00
RAW_FMT_BGR = 0x01
RAW_FMT_GRAY = 0x02

# ---------------------------------------------------------------------------
# Wire-protocol versioning + the deadline on the wire (D350)
# ---------------------------------------------------------------------------

# Highest wire version THIS worker implements. Reported in the ready reply;
# the effective version per connection is min() of both sides' declarations,
# so a worker and a host at different versions (normal during a rolling
# deploy) always agree on the layout.
PROTOCOL_VERSION = 2

# Opcodes that may carry (and be shed by) a deadline. Mirrors
# SHEDDABLE_MSG_TYPES in shared-inference-pool.ts — commands and cacheFrame
# are absent on BOTH sides: a shed command desynchronizes model state, a shed
# cacheFrame strands the inferCached that follows it.
SHEDDABLE_MSG_TYPES = frozenset({MSG_INFER_JPEG, MSG_INFER_RAW, MSG_INFER_BATCH, MSG_INFER_CACHED})

# Bytes of the absolute-deadline prefix a v2 sheddable payload carries.
DEADLINE_PREFIX_LEN = 8

# Sampling stride for the deadline-expired shed stderr line. Under a storm
# this fires at frame rate; one line per shed buried every other signal the
# last time a shed path logged unsampled (45 741 rows/hour, 2026-08-01). The
# counter (PoolCounters.shed_deadline_expired) keeps the exact total.
DEADLINE_SHED_LOG_EVERY = 500


def _negotiate_wire_version(config: dict) -> int:
    """Effective wire version for this connection: min(ours, host declared).

    No declaration (an OLD host) or a garbage value negotiates v1 — the
    byte-identical historical layout. Pure; unit-tested.
    """
    try:
        declared = int(config.get("protocolVersion", 1) or 1)
    except (TypeError, ValueError):
        declared = 1
    return max(1, min(PROTOCOL_VERSION, declared))


def _split_deadline(msg_type: int, payload: bytes, wire_version: int) -> "tuple[int, bytes]":
    """Split a request payload into (deadline_ms, rest) by the NEGOTIATED
    version. v1, and every non-sheddable opcode at any version, passes the
    payload through untouched with deadline 0 (= no deadline, never sheds).
    Raises ValueError on a v2 sheddable payload too short to carry its
    prefix. Pure; unit-tested.
    """
    if wire_version < 2 or msg_type not in SHEDDABLE_MSG_TYPES:
        return 0, payload
    if len(payload) < DEADLINE_PREFIX_LEN:
        raise ValueError(
            f"truncated deadline prefix on msg_type={msg_type} "
            f"({len(payload)} bytes, need {DEADLINE_PREFIX_LEN})"
        )
    (deadline_ms,) = struct.unpack("<Q", payload[:DEADLINE_PREFIX_LEN])
    return deadline_ms, payload[DEADLINE_PREFIX_LEN:]


def _deadline_expired(deadline_ms: int, now_ms: float) -> bool:
    """0 means "no deadline" and never expires (v1 host / unstamped)."""
    return deadline_ms > 0 and now_ms > deadline_ms


def _dropped_deadline_payload() -> dict:
    """The shed reply for an expired request — same shape the TS side already
    recognises as flow control (`poolResultToEngineOutput`)."""
    return {
        "kind": "detections",
        "detections": [],
        "inferenceMs": 0,
        "dropped": True,
        "shedReason": "deadline-expired",
    }


def _log_deadline_shed(total: int, model_idx: int, late_ms: float) -> None:
    """Sampled stderr line for a deadline shed — first occurrence and every
    DEADLINE_SHED_LOG_EVERY-th, carrying the running total so nothing is
    lost, only repeated. A branch that drops work silently is how the
    2026-09-04 collapse produced not one line in four hours."""
    if total != 1 and total % DEADLINE_SHED_LOG_EVERY != 0:
        return
    sys.stderr.write(
        f"deadline-expired shed: model {model_idx}, {late_ms:.0f}ms past deadline "
        f"(total {total}, sampled every {DEADLINE_SHED_LOG_EVERY})\n"
    )
    sys.stderr.flush()


# ---------------------------------------------------------------------------
# Preprocessing (unchanged from v1 — same shapes/math, moved into helpers)
# ---------------------------------------------------------------------------


def letterbox_image(img: Image.Image, size: int) -> tuple[Image.Image, float, tuple[int, int]]:
    """Resize with letterbox padding; returns (PIL canvas, scale, (padX, padY)).

    Stays in uint8 PIL space — no float conversion. Used by the imageType
    fast path where CoreML's predict() accepts a PIL Image directly and
    handles the BGR/normalize/CVPixelBuffer dance internally.
    """
    w, h = img.size
    scale = size / max(w, h)
    new_w = int(w * scale)
    new_h = int(h * scale)
    pad_x = (size - new_w) // 2
    pad_y = (size - new_h) // 2
    if w == size and h == size:
        # Already at target size — skip resize + paste + alloc entirely.
        return img, 1.0, (0, 0)
    # A frameRef view already arrives at the model's content dimensions
    # (e.g. 320x180 for a 16:9 YOLO-320 input). Add only the square padding;
    # repeating the same-size geometric resize wastes CPU and can blur pixels.
    resized = img if (w, h) == (new_w, new_h) else img.resize((new_w, new_h), Image.BILINEAR)
    canvas = Image.new("RGB", (size, size), (114, 114, 114))
    canvas.paste(resized, (pad_x, pad_y))
    return canvas, scale, (pad_x, pad_y)


def letterbox(img: Image.Image, size: int) -> tuple[np.ndarray, float, tuple[int, int]]:
    """Resize with letterbox padding; returns (array[0..1] HWC float32, scale, (padX, padY)).

    Used by multiArrayType inputs where the model expects a normalized
    float tensor. Does the uint8→float32/255 conversion exactly once.
    """
    canvas, scale, pad = letterbox_image(img, size)
    arr = np.array(canvas, dtype=np.float32) / 255.0
    return arr, scale, pad


def resize_image(img: Image.Image, width: int, height: int) -> np.ndarray:
    resized = img.resize((width, height), Image.BILINEAR)
    return np.array(resized, dtype=np.float32) / 255.0


def decode_jpeg(jpeg: bytes) -> Image.Image:
    return Image.open(io.BytesIO(jpeg)).convert("RGB")


def wrap_raw(raw: bytes, width: int, height: int, fmt: int) -> Image.Image:
    """Zero-copy (via PIL frombuffer) wrap of a raw frame buffer."""
    if fmt == RAW_FMT_GRAY:
        img = Image.frombuffer("L", (width, height), raw, "raw", "L", 0, 1)
        return img.convert("RGB")
    mode = "BGR" if fmt == RAW_FMT_BGR else "RGB"
    img = Image.frombuffer("RGB", (width, height), raw, "raw", mode, 0, 1)
    return img


# ---------------------------------------------------------------------------
# Model slot + runtime-specific loading
# ---------------------------------------------------------------------------


@dataclass
class ModelSlot:
    model: Any = None
    config: dict = field(default_factory=dict)
    loaded: bool = False
    predict_fn: Optional[Callable[[dict], dict]] = None
    # Atomic snapshot of model.spec input names; used by both single
    # and batched predict paths to filter input_dicts against the
    # CURRENTLY-loaded model. Defends against the race where an in-
    # flight preprocess holds a reference to the previously-loaded
    # model's `_input_names` and adds keys (iouThreshold,
    # confidenceThreshold) that the new model rejects.
    input_names: frozenset = field(default_factory=frozenset)


_runtime: str = ""
_runtime_lib: Any = None
# Max OPTIMAL_NUMBER_OF_INFER_REQUESTS across loaded OpenVINO models — used
# to size the predict pool so the per-model InferRequest pool is actually fed.
_ov_optimal_reqs: int = 0
# Default OpenVINO predict-pool size when models load lazily (so we can't yet
# query the device's optimal request count). ≈ measured optimal on Intel
# CPU/iGPU/NPU (4-5). Threads idle-block on infer, so over-provisioning is cheap.
OV_DEFAULT_CONCURRENCY: int = 4
# Floor for the InferRequest / predict-pool size when the device DOES answer.
# Under PERFORMANCE_HINT=LATENCY an Intel iGPU typically reports 1-2: one
# execution stream, and the extra requests buy pipelining the LATENCY hint is
# not asking for. Two rather than one so a second frame can be preprocessed
# while the first infers, without paying for four.
OV_MIN_CONCURRENCY: int = 2


def _ov_request_count(optimal: int) -> int:
    """How many InferRequests to create up front.

    ONE function because two call sites must agree: the per-model request pool
    in `_load_model` and the predict-pool worker count in `_run`. They used to
    compute it separately with the same expression, and the expression was
    `max(optimal, OV_DEFAULT_CONCURRENCY)` — a FLOOR of four, not the fallback
    its own comment described. On this hub that meant every model held four
    GPU-resident InferRequests forever, per pool, while the device was asking
    for one or two and `intel_gpu_top` showed the GPU 92% idle. Creating a
    VAAPI device for an HEVC decode then failed with ENOMEM.

    `optimal <= 0` means the device could not be asked — models load lazily,
    the property is missing — and UNKNOWN is not SMALL: that case keeps the
    old default rather than guessing low.
    """
    if optimal <= 0:
        return OV_DEFAULT_CONCURRENCY
    return max(optimal, OV_MIN_CONCURRENCY)
# OpenVINO device decision. AUTO is NEVER used: the AUTO plugin runs inference
# on a CPU "helper" while the GPU JIT-compiles, then hands the model over to the
# GPU mid-flight. InferRequests created during that window bind to the
# CPU-helper's Result ports; after handover the served model's ports diverge and
# req.infer() raises "Cannot find tensor for port opset1::Result score_8" (proven
# live on the N100 iGPU). Compiling ONE explicit device removes the handover
# entirely. We resolve an ordered candidate list (NPU > GPU > CPU) and compile the
# first that succeeds, with CPU as the guaranteed floor.
#
# OpenVINO PERFORMANCE_HINT is LATENCY: one deterministic execution stream. The
# THROUGHPUT hint multiplied memory and lengthened tail latency (an N100
# OOM-freeze factor, see the ov_config note in _load_model); its env switch and
# the never-enabled AsyncInferQueue path were removed on 2026-10-06.
_OV_PERF_HINT: str = "LATENCY"

# OpenVINO COMPILATION thread pool (CAMSTACK_OV_COMPILATION_THREADS, default 4).
#
# OpenVINO sizes the pool that COMPILES a model to the machine's core count, per
# compile, and TBB never retires those workers — they live as long as the
# process. A container cgroup counts THREADS, not processes, so every compile
# permanently spends `nproc` of the cgroup's pid budget.
#
# Measured on the hub (20 cores) 2026-09-18, READ-ONLY, before this bound:
#   pids.current 991 / pids.max 2048 (22 fork refusals in 45 minutes earlier).
#   The detection pool (pid 1183) held 214 threads 17 minutes after boot — the
#   single largest thread holder in the container, 3x the next one (ffmpeg, 80).
#   Thread start times cluster EXACTLY on its compile timestamps: 167 threads in
#   a 4s boot burst (~8 models), then 47 more in a 2-model burst ten minutes
#   later. 23 threads per compile on a 20-core box. ~10 models are resident.
# Expected after: ~4 threads per compile, i.e. ~40 instead of ~214 in that pool.
#
# Four, not one: the cold-compile storm (~25s for the full model set on an N100
# iGPU) is where frames pile up, so the bound keeps some parallelism. It costs
# nothing at inference time — COMPILATION_NUM_THREADS is not
# INFERENCE_NUM_THREADS, which is deliberately left at OpenVINO's default (see
# `_ov_compilation_properties`). 0 disables the bound entirely.
try:
    OV_COMPILATION_NUM_THREADS: int = int(
        os.environ.get("CAMSTACK_OV_COMPILATION_THREADS", "4")
    )
except ValueError:
    OV_COMPILATION_NUM_THREADS = 4


def _ov_supported_properties(core: Any, device: str) -> list[str]:
    """SUPPORTED_PROPERTIES for `device`, or [] when the device cannot be asked.

    A probe that FAILS knows nothing, and unknown is not "supported": the caller
    then sends no extra property and compiles exactly as it always did.
    """
    try:
        return [str(p) for p in core.get_property(device, "SUPPORTED_PROPERTIES")]
    except Exception:
        return []


def _ov_compilation_properties(supported: Any, threads: int) -> dict:
    """The compile-time properties that BOUND OpenVINO's compilation pool.

    Only `COMPILATION_NUM_THREADS`, and only for a device that lists it. A
    plugin REJECTS a property it does not support and the rejection surfaces as
    a compile exception — which the failover loop in `_load_model` would read as
    "this device cannot run the model" and quietly land a GPU model on the CPU.
    Absent beats rejected.

    INFERENCE_NUM_THREADS is deliberately NOT set here. Under PERFORMANCE_HINT
    =LATENCY the compiled model runs one stream, and the CPU device is this
    pool's guaranteed fallback floor — capping its inference threads would trade
    a pid saving we have not measured for a latency regression on exactly the
    nodes that have no accelerator. The compilation pool is pure overhead; the
    inference pool is the work.
    """
    if threads <= 0 or "COMPILATION_NUM_THREADS" not in set(supported):
        return {}
    return {"COMPILATION_NUM_THREADS": threads}


# Inference precisions a catalog entry may require on an OpenVINO GPU.
_OV_GPU_PRECISIONS = ("f32", "f16")


def _ov_precision_properties(config: dict, device: str, supported: Any) -> dict:
    """The INFERENCE_PRECISION_HINT a model's catalog entry requires on a GPU.

    An Intel GPU runs an FP32 IR at f16 by default. Some IRs do not survive
    that: on 2026-10-07 the YOLO26 base IRs `yolo26s`, `yolo26m` and
    `yolo26m-320` returned no valid detection on the Core Ultra iGPU and the
    N100 (0 true / 146 false positives, or NaN scores) and matched the CPU at
    f32. The entry says so (`gpuInferencePrecision`, threaded as config key
    `gpuInferencePrecision`) — never a model-name match.

    GPU only: the NPU and CPU already compute these IRs correctly. And only for
    a device that lists the key — a rejected property would make the failover
    loop push the model onto the next device.
    """
    precision = config.get("gpuInferencePrecision")
    if precision not in _OV_GPU_PRECISIONS:
        return {}
    if not str(device).upper().startswith("GPU"):
        return {}
    if "INFERENCE_PRECISION_HINT" not in set(supported):
        return {}
    return {"INFERENCE_PRECISION_HINT": precision}


def _resolve_ov_devices(available: list[str], full_names: dict[str, str]) -> list[str]:
    """Ordered EXPLICIT device candidates for compile-time failover (NPU>GPU>CPU).

    Never returns an AUTO/AUTO:.. mode (see the module comment above). `available`
    is `core.available_devices`; `full_names` maps each device to its
    FULL_DEVICE_NAME (missing entries = the probe failed, left unclassified). A
    GPU is only accepted when its FULL_DEVICE_NAME probed successfully (this is
    also how an Intel iGPU vs an NVIDIA dGPU is told apart downstream). Ordering:
    NPU(s) -> GPU(s) -> CPU (always last). The compile loop tries each in order
    and stops at the first that compiles; CPU is the guaranteed fallback.
    """
    npus: list[str] = []
    gpus: list[str] = []
    for device in available:
        full_device_name = full_names.get(device)
        if "NPU" in device:
            npus.append(device)
        elif "GPU" in device and full_device_name is not None:
            gpus.append(device)
    ordered: list[str] = [*npus, *gpus]
    if "CPU" in available and "CPU" not in ordered:
        ordered.append("CPU")
    if not ordered:
        ordered = ["CPU"]
    return ordered


# ONNX Runtime execution-provider names used by _resolve_onnx_providers.
ONNX_CUDA_EP = "CUDAExecutionProvider"
ONNX_COREML_EP = "CoreMLExecutionProvider"
ONNX_CPU_EP = "CPUExecutionProvider"


def _resolve_onnx_providers(
    device: str,
    plat: str,
    machine: str,
    available: list[str],
    cuda_device_id: int = 0,
) -> list:
    """Ordered ONNX Runtime providers — hardware first, CPU always last.

    Ordering for the AUTO/default case:

      darwin                    -> CoreMLExecutionProvider
      linux/win on x86_64/AMD64 -> ("CUDAExecutionProvider", {"device_id": N})
      always                    -> CPUExecutionProvider appended LAST

    Deliberate adaptations for camstack:
      - an operator device pin is honored: "cuda"/"coreml" put that EP first
        (CPU still last as fallback); "cpu" compiles CPU only.
      - "webgpu" is NOT handled here — it uses an isolated child process
        (`WebGpuIsolatedSession` / webgpu_isolated.py; D823).
      - hardware entries not present in `available`
        (ort.get_available_providers()) are dropped — camstack ships the
        plain `onnxruntime` wheel on most nodes, and requesting an EP the
        build lacks raises at session creation instead of falling back.
      - platform match uses startswith so a substring test on "win" never
        wrongly matches "darwin".
    """
    dev = (device or "").strip().lower()
    ordered: list = []
    if dev == "cuda":
        ordered.append((ONNX_CUDA_EP, {"device_id": cuda_device_id}))
    elif dev == "coreml":
        ordered.append(ONNX_COREML_EP)
    elif dev in ("cpu", "webgpu"):
        # webgpu uses the plugin path; if we fall through here it must be CPU only.
        pass
    else:
        # AUTO/default — platform-driven ordering.
        if plat == "darwin":
            ordered.append(ONNX_COREML_EP)
        if plat.startswith(("linux", "win")) and machine in ("x86_64", "AMD64"):
            ordered.append((ONNX_CUDA_EP, {"device_id": cuda_device_id}))
    providers: list = [
        p for p in ordered
        if (p[0] if isinstance(p, tuple) else p) in available
    ]
    providers.append(ONNX_CPU_EP)
    return providers


# WebGPU: one ORT session per OS process (Dawn/Vulkan SIGSEGVs on a second
# session in-process — agent-b 2026-10-10). Implementation lives in
# webgpu_isolated.py; the pool parent never holds a WebGPU session itself.
from webgpu_isolated import WebGpuIsolatedSession  # noqa: E402


# ---------------------------------------------------------------------------
# CoreML persistent compiled-model cache
# ---------------------------------------------------------------------------
# Known macOS behavior: the OS-level compiled-model cache is NOT reused across
# process restarts — every
# `ct.models.MLModel(.mlpackage)` load RECOMPILES the model, and the stale OS
# cache is only cleared on reboot. camstack loads the .mlpackage on every pool
# spawn, so each spawn paid the full recompile. Fix: after the first compile,
# copy the compiled `.mlmodelc` (get_compiled_model_path() returns a TEMP dir
# that dies with the MLModel object) into a persistent `.coreml-cache` dir next
# to the model (mirrors the OpenVINO `.ov-cache` convention); subsequent spawns
# load it via `ct.models.CompiledMLModel(...)` — no recompile. A stamp file
# fingerprinting the source model invalidates the cache when the model changes.
# HARD RULE: every failure in this machinery falls back to the plain
# `ct.models.MLModel(path)` load — exactly the pre-cache behavior.

# ---------------------------------------------------------------------------
# Compile-cache lock — one worker compiles a model, the rest wait and HIT
# ---------------------------------------------------------------------------
#
# A pool is several python PROCESSES. They start together, all miss the
# compiled-model cache because nobody has written it yet, all pay the compile,
# and then all try to replace the same directory. Measured on the operator's
# Mac on 2026-09-19 over three hours: **59 cache HITs, 55 MISSes, 5 persist
# failures** — half the loads recompiling a model that was already on disk.
#
# The failures name a path INSIDE the bundle:
#
#   CoreML: could not persist compiled-model cache
#   ([Errno 2] No such file or directory: '.../yolov9m-320.mlmodelc/weights')
#
# which is `_persist_coreml_compiled` removing the old cache while another
# worker swaps its own copy into the same place: `rmtree` walks a directory and
# a child ceases to exist under it.
#
# So this lock is not belt-and-braces. It is what turns N compiles of one model
# into one, and what makes "replace the cache" single-writer.
#
# It is deliberately NOT fatal in any direction: an unusable lock directory, a
# platform without `flock`, or a holder that died mid-compile all end the same
# way — the caller compiles without the cache, which is exactly what it did
# before the cache existed. A cache is an optimisation, and an optimisation
# that can refuse to serve a camera is worse than every miss it prevents.

# How long a waiter gives the compiling worker before compiling itself.
COMPILE_CACHE_LOCK_TIMEOUT_SEC = 180.0
_COMPILE_CACHE_LOCK_POLL_SEC = 0.05


@contextlib.contextmanager
def compile_cache_lock(
    cache_root: str,
    stem: str,
    timeout_sec: float = COMPILE_CACHE_LOCK_TIMEOUT_SEC,
):
    """Hold the per-MODEL compile lock, or yield False having failed to.

    Per model, not per cache: compiling the detector must not serialise behind
    the embedder, which is a different file and a different compile.
    """
    handle = None
    held = False
    try:
        os.makedirs(cache_root, exist_ok=True)
        handle = open(os.path.join(cache_root, f"{stem}.lock"), "a+")
        deadline = time.monotonic() + max(0.0, timeout_sec)
        while True:
            try:
                if pool_platform.try_lock_exclusive(handle.fileno()):
                    held = True
                    break
                if time.monotonic() >= deadline:
                    break
                time.sleep(_COMPILE_CACHE_LOCK_POLL_SEC)
            except OSError:
                if time.monotonic() >= deadline:
                    break
                time.sleep(_COMPILE_CACHE_LOCK_POLL_SEC)
    except (OSError, AttributeError, NameError):
        held = False
    try:
        yield held
    finally:
        if handle is not None:
            try:
                if held:
                    pool_platform.unlock(handle.fileno())
            except OSError:
                pass
            try:
                handle.close()
            except OSError:
                pass


COREML_CACHE_DIR_NAME = ".coreml-cache"
COREML_CACHE_STAMP_VERSION = 1


def _coreml_cache_paths(model_path: str) -> tuple[str, str]:
    """(compiled .mlmodelc cache dir, stamp file) for a source model path.

    The cache lives in a dot-dir next to the model file — same convention as
    the OpenVINO `.ov-cache` — so it ships/wipes with the models dir.
    """
    models_dir = os.path.dirname(os.path.abspath(model_path))
    stem = os.path.splitext(os.path.basename(model_path))[0]
    cache_root = os.path.join(models_dir, COREML_CACHE_DIR_NAME)
    return (
        os.path.join(cache_root, stem + ".mlmodelc"),
        os.path.join(cache_root, stem + ".stamp.json"),
    )


def _coreml_model_fingerprint(model_path: str) -> dict:
    """Cheap source-model fingerprint — file count + total size + max mtime.

    Works for both a plain file (.mlmodel) and a .mlpackage DIRECTORY (the
    normal case), whose top-level mtime alone would not reflect content edits.
    JSON-serializable so it round-trips through the stamp file unchanged.

    The package's top-level `Manifest.json` counts by size only, never by
    mtime: coremltools rewrites it (same bytes) on EVERY open of the package —
    `MLModel` and `utils.load_spec` alike (measured, coremltools 8.3, macOS
    26.2). The cache HIT path calls `load_spec`, so keyed on that mtime every
    HIT invalidated the stamp for the next spawn: HIT, MISS, HIT, MISS. A
    re-download rewrites the model and weights files too, so it still shows.
    """
    if not os.path.isdir(model_path):
        st = os.stat(model_path)
        return {"kind": "file", "files": 1, "size": st.st_size, "mtimeNs": st.st_mtime_ns}
    total_size = 0
    latest_mtime = 0
    file_count = 0
    manifest = os.path.join(model_path, "Manifest.json")
    for root, _dirs, files in os.walk(model_path):
        for name in files:
            file_path = os.path.join(root, name)
            st = os.stat(file_path)
            total_size += st.st_size
            file_count += 1
            if file_path == manifest:
                continue
            if st.st_mtime_ns > latest_mtime:
                latest_mtime = st.st_mtime_ns
    return {"kind": "dir", "files": file_count, "size": total_size, "mtimeNs": latest_mtime}


def _coreml_stamp_matches(stamp: Any, fingerprint: dict) -> bool:
    """Pure decision: does a parsed stamp validate the cached compile?"""
    return (
        isinstance(stamp, dict)
        and stamp.get("version") == COREML_CACHE_STAMP_VERSION
        and stamp.get("fingerprint") == fingerprint
    )


def _persist_coreml_compiled(
    compiled_src: str, cache_path: str, stamp_path: str, fingerprint: dict,
) -> None:
    """Copy coremltools' TEMP compiled dir into the persistent cache path.

    Crash-safe ordering: copy into a tmp sibling on the SAME filesystem, then
    `os.replace` into place, and write the stamp LAST — a stamp file only ever
    exists for a fully-moved `.mlmodelc`, so a crash mid-copy can never
    produce a half-written cache that validates. Raises on failure — the
    caller logs and continues WITHOUT a cache (model already loaded fine).
    """
    cache_root = os.path.dirname(cache_path)
    os.makedirs(cache_root, exist_ok=True)
    tmp_dir = f"{cache_path}.tmp-{os.getpid()}"
    if os.path.exists(tmp_dir):
        shutil.rmtree(tmp_dir)
    try:
        shutil.copytree(compiled_src, tmp_dir)
        # Drop any stale previous cache: its stamp first (so nothing validates
        # the old dir), then the dir itself — POSIX rename cannot replace a
        # non-empty directory.
        # Both removals tolerate "already gone". `compile_cache_lock` makes a
        # concurrent swap rare, not impossible — a worker killed between taking
        # the lock and the replace leaves precisely this state — and a previous
        # cache that has ALREADY disappeared is the outcome we wanted anyway.
        # Not tolerating it is what produced five
        # `[Errno 2] ... .mlmodelc/weights` failures in three hours.
        try:
            os.remove(stamp_path)
        except FileNotFoundError:
            pass
        shutil.rmtree(cache_path, ignore_errors=True)
        os.replace(tmp_dir, cache_path)
    except BaseException:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise
    stamp_tmp = f"{stamp_path}.tmp-{os.getpid()}"
    try:
        with open(stamp_tmp, "w", encoding="utf-8") as fh:
            json.dump({"version": COREML_CACHE_STAMP_VERSION, "fingerprint": fingerprint}, fh)
        os.replace(stamp_tmp, stamp_path)
    except BaseException:
        try:
            os.remove(stamp_tmp)
        except OSError:
            pass
        raise


def _try_coreml_cache_hit(
    ct: Any, path: str, compute_units: Any,
) -> tuple[Any, Any] | None:
    """(model, spec) from the persistent cache, or None for "compile it".

    Separate from the compile because it is asked TWICE: once before queueing
    for the compile lock, and again once the lock is held — the second ask is
    what turns every waiter's miss into a hit.

    `CompiledMLModel` has no `get_spec()`, so the spec is read straight from
    the source .mlpackage with `ct.utils.load_spec` (cheap — parses the
    protobuf, does not compile). Any failure answers None, which is the
    pre-cache behaviour exactly.
    """
    try:
        cache_path, stamp_path = _coreml_cache_paths(path)
        fingerprint = _coreml_model_fingerprint(path)
        stamp: Any = None
        if os.path.isfile(stamp_path):
            with open(stamp_path, "r", encoding="utf-8") as fh:
                stamp = json.load(fh)
        if _coreml_stamp_matches(stamp, fingerprint) and os.path.isdir(cache_path):
            spec = ct.utils.load_spec(path)
            model = ct.models.CompiledMLModel(cache_path, compute_units)
            sys.stderr.write(f"CoreML: compiled-model cache HIT {cache_path}\n")
            sys.stderr.flush()
            return model, spec
    except Exception as exc:
        sys.stderr.write(
            f"CoreML: compiled-model cache lookup failed ({exc}); "
            f"falling back to plain compile of {os.path.basename(path)}\n"
        )
        sys.stderr.flush()
    return None


def _acquire_coreml_model(ct: Any, path: str, compute_units: Any) -> tuple[Any, Any]:
    """Return (model, spec) for the CoreML branch via the persistent cache.

    Cache HIT  → `CompiledMLModel(cache)`, no recompile (`_try_coreml_cache_hit`).
    Cache MISS → take the per-model compile lock, ask AGAIN (the winner may
                 have finished while we queued), then `MLModel(path)` — the
                 pre-cache behaviour — and persist it for the next spawn.
    LOCK LOST  → compile anyway, serve the model, write nothing.
    ANY failure in the cache machinery → the plain MLModel path, exactly as
    before this cache existed. Never raises differently from pre-cache code.
    """
    hit = _try_coreml_cache_hit(ct, path, compute_units)
    if hit is not None:
        return hit

    # A MISS here is not yet a compile. The pool starts its workers together,
    # so every one of them arrives at this line at the same instant with the
    # same answer — measured 55 misses against 59 hits on the Mac, which is
    # not a cold cache, it is N workers each compiling what the others are
    # compiling. One of them takes the lock; the rest wait and then find the
    # HIT the winner just wrote.
    cache_root = os.path.dirname(_coreml_cache_paths(path)[0])
    stem = os.path.splitext(os.path.basename(path))[0]
    with compile_cache_lock(cache_root, stem) as held:
        if held:
            hit = _try_coreml_cache_hit(ct, path, compute_units)
            if hit is not None:
                return hit

        model = ct.models.MLModel(path, compute_units=compute_units)
        spec = model.get_spec()

        # Only the lock HOLDER writes the cache. A worker that compiled
        # because it could not get the lock has a perfectly good model and no
        # business replacing a directory somebody else owns — that swap is the
        # race, and skipping it costs nothing: the holder is writing the same
        # bytes.
        if not held:
            sys.stderr.write(
                f"CoreML: compiled without the cache lock — compiled "
                f"{os.path.basename(path)} and left the cache to its holder\n"
            )
            sys.stderr.flush()
            return model, spec

        try:
            cache_path, stamp_path = _coreml_cache_paths(path)
            fingerprint = _coreml_model_fingerprint(path)
            compiled_src = model.get_compiled_model_path()
            _persist_coreml_compiled(compiled_src, cache_path, stamp_path, fingerprint)
            sys.stderr.write(
                f"CoreML: compiled-model cache MISS — compiled and persisted {cache_path}\n"
            )
            sys.stderr.flush()
        except Exception as exc:
            sys.stderr.write(
                f"CoreML: could not persist compiled-model cache ({exc}); "
                f"continuing without cache\n"
            )
            sys.stderr.flush()
        return model, spec


def _init_runtime(runtime: str, device: str = "") -> None:
    global _runtime, _runtime_lib
    _runtime = runtime
    if runtime == "coreml":
        import coremltools as ct
        _runtime_lib = ct
    elif runtime == "openvino":
        # `openvino.runtime` is deprecated (removed in a future OpenVINO release);
        # `Core` is exported from the top-level `openvino` namespace.
        from openvino import Core
        _runtime_lib = Core()
    elif runtime == "onnxruntime":
        import onnxruntime as ort
        _runtime_lib = ort
    elif runtime == "edgetpu":
        # Coral USB Edge TPU via LiteRT (ai-edge-litert) + the libedgetpu delegate.
        # The delegate is created ONCE here and shared across all model slots (the
        # USB device is a single hardware context). See docs: the delegate's TF
        # version MUST match the interpreter — feranick libedgetpu tf2.17.1 pairs
        # with ai-edge-litert 2.1.6. Staged by the deps downloader beside the
        # edgetpu requirements (`requirements-edgetpu.txt`), or edgetpu-install.sh.
        import threading
        from ai_edge_litert.interpreter import Interpreter, load_delegate
        from edgetpu_device import edgetpu_library_path
        lib_path = edgetpu_library_path(os.environ, sys.platform)
        # Multiple Corals (USB and/or PCIe) coexist and run concurrently, one
        # pool each. libedgetpu addresses a unit by device string; the TS side
        # sends the explicit ordinal ("usb:0", "usb:1", "pci:0", "pci:1") as the
        # pool `device`. Omitted ⇒ the library default (first Edge TPU of any
        # bus); an unknown string is refused (`edgetpu_delegate_options`).
        from edgetpu_device import edgetpu_delegate_options, preload_libusb
        dev = (device or "").strip()
        opts = edgetpu_delegate_options(dev)
        # The std delegate links libusb even for a PCIe Coral; an image without
        # the system package loads the installer's copy beside the delegate.
        try:
            libusb = preload_libusb(os.path.dirname(lib_path))
            if libusb is not None:
                sys.stderr.write(f"EdgeTPU: preloaded {libusb}\n")
        except OSError as e:
            sys.stderr.write(
                f"EdgeTPU: could not preload libusb beside the delegate ({e}); "
                f"relying on the system library\n"
            )
        # The Coral is a SINGLE-CONTEXT USB device: only ONE process may hold the
        # libedgetpu delegate at a time. When a prior pool (e.g. a previous runner
        # generation, or a just-disposed device pool) is still releasing the USB,
        # a fresh load_delegate fails transiently. Retry with backoff instead of
        # hard-failing the whole pool — the device frees within a second or two of
        # the old holder exiting. (A genuinely-held device still fails after the
        # retries, with the real libedgetpu error surfaced.)
        import time as _time
        last_err = None
        delegate = None
        for attempt in range(6):
            try:
                delegate = load_delegate(lib_path, opts) if opts else load_delegate(lib_path)
                break
            except Exception as e:  # noqa: BLE001 — surface the real error after retries
                last_err = e
                sys.stderr.write(
                    f"EdgeTPU: delegate load attempt {attempt + 1}/6 failed "
                    f"(device={dev or 'usb'}): {e}\n"
                )
                sys.stderr.flush()
                _time.sleep(0.75 * (attempt + 1))
        if delegate is None:
            raise ValueError(
                f"EdgeTPU: delegate not available after 6 attempts on device "
                f"'{dev or 'usb'}' — the Coral is held by another process or "
                f"absent. Last error: {last_err}"
            )
        sys.stderr.write(f"EdgeTPU: delegate bound to device '{dev or 'usb'}'\n")
        _runtime_lib = {
            "Interpreter": Interpreter,
            "delegate": delegate,
            # invoke() on one interpreter is not re-entrant, and the EdgeTPU is a
            # single-context device — serialise all predicts through one lock.
            "lock": threading.Lock(),
        }
        sys.stderr.write(f"EdgeTPU: delegate loaded from {lib_path}\n")
        sys.stderr.flush()
    else:
        raise ValueError(f"Unknown runtime: {runtime}")


# ---------------------------------------------------------------------------
# Batch capability is a HARDWARE FACT, not a setting (D202)
# ---------------------------------------------------------------------------
# Whether a compiled graph may keep a DYNAMIC batch axis is decided here, from
# the (engine, device) pair, at the moment of load — never per model, never by
# an operator, never in a conversion script. The conversion scripts and the
# model-studio convert path both emit dynamic-batch graphs (`ov.convert_model`
# preserves the ONNX dynamic axis), and the same artifact is loaded on CPU, iGPU,
# NPU and ANE nodes — so the artifact cannot know, and only the loader does.
#
# The one target that refuses: the Intel NPU. Its Level-Zero compiler rejects a
# dynamic dimension outright ("Got negative shape dim bound: '-1'", then
# ZE_RESULT_ERROR_INVALID_ARGUMENT). Found live 2026-08-20 on the hub, and the
# symptom is the trap — a pool load failure is a RETRY, not an error the caller
# sees, so an NPU-pinned node repeated "Loading step variant" forever and looked
# busy rather than broken. Under AUTO it is quieter and just as wrong: the NPU
# candidate silently loses every dynamic-batch model to the GPU fallback.
#
# This is COMPILE shape only. The pool's runtime request grouping (`batch_mode`
# / `max_batch_size`, and the CoreML stacked-tensor fast path gated on the
# export's own RangeDim) is a separate, untouched optimisation.
STATIC_BATCH_PIN = 1


def _static_batch_required(runtime: str, device: str) -> bool:
    """THE authority: does this (engine, device) pair refuse a dynamic shape?

    Pure — no OpenVINO import, so it is unit-testable in a bare sandbox.

      openvino + NPU  -> True  (Level-Zero rejects any dynamic dim)
      openvino + CPU/GPU -> False
      onnxruntime     -> False (every EP we ship handles dynamic axes)
      coreml          -> False (a RangeDim export is exactly what the batched
                                ANE dispatch path reads; pinning would delete it)
      edgetpu         -> False (a tflite graph is static by construction)
    """
    if runtime != "openvino":
        return False
    return device.strip().upper().startswith("NPU")


def _static_batch_plan(
    shapes: "list[list[int | None] | None]",
) -> "tuple[dict[int, list[int]], list[int]]":
    """Pure. Given each input's dims (``None`` = dynamic axis, ``None`` for the
    whole entry = unreadable), return ``(plan, unpinnable)``:

      plan       {input_index: static_dims} for inputs whose BATCH axis is
                 dynamic and whose every other axis is already static.
      unpinnable [input_index] for inputs carrying a dynamic axis that is NOT
                 the batch — there is no value we are allowed to invent for a
                 spatial dim, so the caller compiles as-is and SAYS SO rather
                 than letting the failure be silent.
    """
    plan: "dict[int, list[int]]" = {}
    unpinnable: "list[int]" = []
    for index, dims in enumerate(shapes):
        if dims is None:
            unpinnable.append(index)
            continue
        if len(dims) == 0:
            continue
        if any(d is None for d in dims[1:]):
            unpinnable.append(index)
            continue
        if dims[0] is not None:
            continue  # already a static batch — the rule pins dynamic axes only
        plan[index] = [STATIC_BATCH_PIN] + [int(d) for d in dims[1:] if d is not None]
    return plan, unpinnable


def _pin_batch_for_device(core: Any, source: Any, path: str, device: str) -> Any:
    """OpenVINO applicator of {@link _static_batch_required}.

    Returns what `compile_model` should be handed for `device`: the untouched
    `source` when the target accepts a dynamic shape (or the graph is already
    static), otherwise a model RESHAPED to a static batch of
    {@link STATIC_BATCH_PIN}. `source` is either the IR path (the plain load
    path) or an already-built model object (the PrePostProcessor path); the pin
    is applied to whichever, and it only ever touches axis 0, so a PPP model's
    rewritten uint8 NHWC input survives it. Every outcome is logged — the
    derivation must be readable in the pool stderr.

    (`_ov_dim_to_int` is defined further down with the other OV shape helpers.)
    """
    name = os.path.basename(path)
    if not _static_batch_required("openvino", device):
        return source
    try:
        model = core.read_model(path) if isinstance(source, str) else source
    except Exception as exc:
        sys.stderr.write(
            f"OpenVINO: {device} needs a static shape but re-reading {name} failed "
            f"({exc}); compiling the source as-is\n"
        )
        sys.stderr.flush()
        return source

    shapes: "list[list[int | None] | None]" = []
    for inp in model.inputs:
        try:
            pshape = inp.get_partial_shape()
            shapes.append([_ov_dim_to_int(pshape[i]) for i in range(len(pshape))])
        except Exception:
            shapes.append(None)

    plan, unpinnable = _static_batch_plan(shapes)
    if unpinnable:
        sys.stderr.write(
            f"OpenVINO: {name} has a DYNAMIC NON-BATCH axis on input(s) {unpinnable} "
            f"and {device} refuses dynamic dims — no value may be invented for a "
            f"spatial axis, so this compile is expected to fail\n"
        )
        sys.stderr.flush()
    if not plan:
        sys.stderr.write(
            f"OpenVINO: batch shape for {name} on {device} — already static, no "
            f"reshape (derived from engine+device)\n"
        )
        sys.stderr.flush()
        return source
    try:
        from openvino import PartialShape

        # `Model.reshape` mutates IN PLACE, and on the PrePostProcessor path
        # `source` IS the model object the compile loop reuses for the NEXT
        # candidate. Pinning it directly would leak this NPU-only decision into
        # the GPU/CPU fallback — a candidate that accepts a dynamic shape would
        # silently get the pinned graph. So reshape a CLONE and leave `source`
        # exactly as the caller built it.
        model = model.clone() if not isinstance(source, str) else model
        model.reshape({index: PartialShape(dims) for index, dims in plan.items()})
    except Exception as exc:
        sys.stderr.write(
            f"OpenVINO: static-batch reshape of {name} for {device} failed ({exc}); "
            f"compiling the source as-is\n"
        )
        sys.stderr.flush()
        return source
    sys.stderr.write(
        f"OpenVINO: batch shape for {name} on {device} — PINNED to "
        f"{STATIC_BATCH_PIN} on input(s) {sorted(plan)} because the target refuses "
        f"a dynamic dim (derived from engine+device, not configured)\n"
    )
    sys.stderr.flush()
    return model


# The OpenVINO compile probe (`openvino_compile_probe`) runs the pool's own
# `_load_model` in a throwaway child; the child switches the probe off in itself.
_ov_probe_enabled: bool = True


def _ov_env_tag(core: Any) -> str:
    """OpenVINO version + GPU driver: what a persisted probe verdict is valid for."""
    parts: "list[str]" = []
    try:
        from openvino import get_version

        parts.append(str(get_version()))
    except Exception:
        pass
    try:
        parts.append(str(core.get_property("GPU", "DEVICE_ARCHITECTURE")))
    except Exception:
        pass
    return "|".join(parts)


def _load_model(slot: ModelSlot, config: dict) -> None:
    """Load a model into a slot using the active runtime. Thin adapter per backend."""
    slot.config = dict(config)
    path = config["path"]

    if _runtime == "coreml":
        ct = _runtime_lib
        device = config.get("device", "all")
        compute_map = {
            "cpu": ct.ComputeUnit.CPU_ONLY,
            "gpu": ct.ComputeUnit.CPU_AND_GPU,
            "ane": ct.ComputeUnit.CPU_AND_NE,
            "all": ct.ComputeUnit.ALL,
        }
        # NOTE: a macOS behavior can cause the .mlpackage to be RECOMPILED on
        # every load with the compiled cache not reused until reboot. camstack
        # loads the .mlpackage on
        # every pool spawn, so it was exposed to the same trap.
        # _acquire_coreml_model routes through a persistent `.coreml-cache`
        # of the compiled `.mlmodelc` (CompiledMLModel on hit, plain MLModel
        # compile + persist on miss) and returns the spec read via
        # ct.utils.load_spec on hits — falling back to the plain
        # MLModel/get_spec() path on ANY cache failure.
        #
        # First, the package is loaded once in a CHILD process: a package that
        # aborts Core ML's native loader (SIGABRT, which Python cannot catch)
        # is refused here with `CoremlLoadCrashed` instead of killing this
        # worker and, through the respawn, every worker after it.
        import coreml_load_probe

        coreml_load_probe.ensure_coreml_loadable(path, device)
        model, spec = _acquire_coreml_model(
            ct, path, compute_map.get(device, ct.ComputeUnit.ALL),
        )
        # Report the compute unit that was ACTUALLY applied so a silent
        # CPU-only placement is visible in the pool stderr (mirrors the
        # OpenVINO EXECUTION_DEVICES / ONNX provider reports). Both MLModel
        # and CompiledMLModel expose `compute_unit`.
        _actual_cu = getattr(model, "compute_unit", None)
        sys.stderr.write(
            f"CoreML: loaded {os.path.basename(path)} device={device} "
            f"compute_unit={_actual_cu}\n"
        )
        sys.stderr.flush()
        input_spec = spec.description.input[0]
        slot.config["_input_name"] = input_spec.name
        slot.config["_input_type"] = input_spec.type.WhichOneof("Type")
        slot.config["_input_names"] = [i.name for i in spec.description.input]
        if slot.config["_input_type"] == "multiArrayType":
            slot.config["_input_shape"] = list(input_spec.type.multiArrayType.shape)
            # Detect batch flexibility — when the model's first axis is
            # declared as a `shapeRange` (RangeDim at export time), we
            # can stack N preprocessed frames into a single (N,3,H,W)
            # tensor and issue ONE predict call instead of iterating
            # the list-of-dicts path. One ANE dispatch per batch.
            mat = input_spec.type.multiArrayType
            if mat.WhichOneof("ShapeFlexibility") == "shapeRange" and len(mat.shapeRange.sizeRanges) > 0:
                batch_axis = mat.shapeRange.sizeRanges[0]
                if batch_axis.upperBound > 1:
                    slot.config["_supports_batch"] = True
                    slot.config["_max_batch"] = int(batch_axis.upperBound)
        slot.model = model
        slot.input_names = frozenset(i.name for i in spec.description.input)
        # Filter via slot.input_names atomically read from the CURRENT
        # slot. During a model `replace`, in-flight preprocess calls
        # may have added stale keys (iouThreshold, confidenceThreshold)
        # for the prior model that the new one rejects.
        def _predict(inp: dict, _slot: ModelSlot = slot) -> dict:
            names = _slot.input_names
            filtered = {k: v for k, v in inp.items() if k in names} if names else inp
            return _slot.model.predict(filtered)
        slot.predict_fn = _predict

    elif _runtime == "openvino":
        core = _runtime_lib
        ov_device_req = str(config.get("device", "AUTO")).upper()
        # Device switch (see _resolve_ov_devices above): an AUTO/default request
        # classifies the enumerated devices by FULL_DEVICE_NAME and yields an
        # ORDERED EXPLICIT candidate list (NPU>GPU>CPU) for compile-time
        # failover. An operator-pinned device (config "device" = gpu/cpu/npu) is
        # honored unchanged — compiled directly, no failover.
        if ov_device_req in ("AUTO", "DEFAULT", ""):
            available = list(core.available_devices)
            full_names: dict[str, str] = {}
            for dev in available:
                try:
                    full_names[dev] = str(core.get_property(dev, "FULL_DEVICE_NAME"))
                except Exception:
                    pass
            candidates = _resolve_ov_devices(available, full_names)
            sys.stderr.write(
                f"OpenVINO: explicit device candidates {candidates} "
                f"(available: {available}, names: {full_names})\n"
            )
            sys.stderr.flush()
        else:
            candidates = [ov_device_req]  # operator pin — compiled directly
            sys.stderr.write(f"OpenVINO: operator-pinned device {ov_device_req}\n")
            sys.stderr.flush()
        # PERFORMANCE_HINT is LATENCY: one
        # deterministic execution stream instead of N. THROUGHPUT spins up
        # multiple internal streams whose lazy request creation historically
        # collided with the AUTO handover AND multiplied memory (a factor in the
        # N100 OOM-freeze); it also RAISES OPTIMAL_NUMBER_OF_INFER_REQUESTS, which
        # enlarges the request pool at a memory / tail-latency cost.
        # LATENCY keeps a single stream; camera-level concurrency comes from the
        # fixed InferRequest pool built below.
        ov_config = {"PERFORMANCE_HINT": _OV_PERF_HINT}
        # Persist compiled GPU/NPU kernels so the multi-second JIT compile is paid
        # once (first boot) instead of on every pool spawn. The cold compile storm
        # (~25s for the full model set on an N100 iGPU) is where frames pile up;
        # caching the kernels shrinks that window on subsequent boots.
        try:
            _cache_dir = os.path.join(os.path.dirname(os.path.abspath(path)), ".ov-cache")
            os.makedirs(_cache_dir, exist_ok=True)
            ov_config["CACHE_DIR"] = _cache_dir
        except OSError:
            pass
        # A GPU/NPU compile that has no blob yet runs in a CHILD first
        # (`openvino_compile_probe`): a compiler SIGSEGV is refused here with
        # `OpenvinoLoadCrashed` instead of killing this worker, and on success
        # the child has written the blob, so the compile below is a cache hit.
        if _ov_probe_enabled:
            import openvino_compile_probe

            openvino_compile_probe.ensure_openvino_loadable(
                path, config, candidates,
                cache_dir=ov_config.get("CACHE_DIR"),
                env_tag=_ov_env_tag(core),
            )
        # Fix 2 — fold uint8→float/scale/layout preprocessing INTO the compiled
        # graph via PrePostProcessor. When it succeeds we compile the PPP model
        # object (fed uint8 NHWC at inference time); on ANY failure we fall back
        # to compiling the plain `path` (byte-identical to the historical float
        # preprocess). Always on for OpenVINO (tests flip `_OV_PPP_ENABLED`).
        ppp_meta: Optional[dict] = None
        compile_source: Any = path
        if _OV_PPP_ENABLED:
            try:
                ppp_model, ppp_meta = _build_ov_ppp_model(core, path, config)
                if ppp_model is not None:
                    compile_source = ppp_model
                    sys.stderr.write(
                        f"OpenVINO: PrePostProcessor folded for {os.path.basename(path)} "
                        f"(uint8 NHWC in, {ppp_meta}); Python preprocess stays uint8\n"
                    )
                    sys.stderr.flush()
            except Exception as exc:
                ppp_meta = None
                compile_source = path
                sys.stderr.write(
                    f"OpenVINO: PrePostProcessor setup failed for {os.path.basename(path)} "
                    f"({exc}); falling back to Python float preprocess\n"
                )
                sys.stderr.flush()
        # Compile-time failover over the explicit candidate list (NO AUTO): try
        # each device in order (NPU>GPU>CPU) and stop at the first that compiles.
        # CPU is the guaranteed floor. If every candidate fails, re-raise — the
        # existing load/replace error handler reports the failure.
        compiled = None
        ov_device = None
        # What the compilation bound actually became on the device that won —
        # 0 means the device does not expose the key, so this compile spent
        # `nproc` threads for the life of the process and the operator must be
        # able to SEE that rather than assume the bound applied.
        ov_compile_threads = 0
        ov_precision = "device-default"
        last_exc: Optional[BaseException] = None
        for candidate in candidates:
            try:
                # Batch capability is derived from THIS candidate, not from the
                # artifact and not from a setting (D202): a graph with a dynamic
                # batch axis is reshaped static before it can reach a compiler
                # that refuses dynamic dims (the Intel NPU), and is handed over
                # untouched to every other target.
                candidate_source = _pin_batch_for_device(
                    core, compile_source, path, candidate,
                )
                # Bound the per-compile TBB pool this candidate would otherwise
                # size to `nproc` and never give back (see
                # OV_COMPILATION_NUM_THREADS). Gated on the device's own
                # SUPPORTED_PROPERTIES so a plugin that does not know the key
                # compiles unchanged instead of failing over to the CPU.
                candidate_supported = _ov_supported_properties(core, candidate)
                candidate_config = {
                    **ov_config,
                    **_ov_compilation_properties(
                        candidate_supported,
                        OV_COMPILATION_NUM_THREADS,
                    ),
                    # A model the GPU must not run at its default f16
                    # (catalog `gpuInferencePrecision`).
                    **_ov_precision_properties(config, candidate, candidate_supported),
                }
                compiled = core.compile_model(
                    candidate_source, device_name=candidate, config=candidate_config,
                )
                ov_device = candidate
                ov_compile_threads = int(
                    candidate_config.get("COMPILATION_NUM_THREADS", 0)
                )
                ov_precision = str(
                    candidate_config.get("INFERENCE_PRECISION_HINT", "device-default")
                )
                break
            except Exception as exc:
                last_exc = exc
                sys.stderr.write(f"OpenVINO: compile on {candidate} failed: {exc}\n")
                if candidate != candidates[-1]:
                    sys.stderr.write("OpenVINO: falling back to next device.\n")
                sys.stderr.flush()
        if compiled is None:
            if last_exc is not None:
                raise last_exc
            raise RuntimeError("OpenVINO: no device available to compile the model")
        # Name the resolved mode + what OpenVINO actually placed the model on
        # (the EXECUTION_DEVICES property) so a silent CPU
        # placement is visible in the pool stderr.
        try:
            _exec_devices = compiled.get_property("EXECUTION_DEVICES")
        except Exception:
            _exec_devices = "unknown"
        sys.stderr.write(
            f"OpenVINO: compiled {os.path.basename(path)} mode={ov_device} "
            f"EXECUTION_DEVICES={_exec_devices} compilationThreads="
            f"{ov_compile_threads if ov_compile_threads > 0 else 'unbounded(device rejects the key)'}"
            f" inferencePrecision={ov_precision}\n"
        )
        # A model that needs a GPU precision the device would not take runs at
        # f16 and may return garbage — say so rather than look healthy.
        if (
            config.get("gpuInferencePrecision") in _OV_GPU_PRECISIONS
            and str(ov_device).upper().startswith("GPU")
            and ov_precision == "device-default"
        ):
            sys.stderr.write(
                f"OpenVINO: WARNING {os.path.basename(path)} requires "
                f"inferencePrecision={config.get('gpuInferencePrecision')} on {ov_device}, "
                "which does not list INFERENCE_PRECISION_HINT — it runs at the device default "
                "and its detections may be invalid\n"
            )
        sys.stderr.flush()
        # An OpenVINO IR converted from ONNX can carry an UNNAMED output tensor
        # (e.g. `yolov8n-package`): `get_any_name()` then raises
        # "Attempt to get a name for a Tensor without names", which previously
        # failed the whole model load on OpenVINO nodes (the package-detection
        # step could never run on OpenVINO). Outputs are fetched POSITIONALLY in
        # `predict` below, so a synthetic key per unnamed port is sufficient.
        output_names = []
        for _i, _o in enumerate(compiled.outputs):
            try:
                output_names.append(_o.get_any_name())
            except Exception:
                output_names.append(f"output{_i}")

        # Record the device's optimal infer-request count so the dispatcher
        # can size the predict pool to actually feed the streams.
        global _ov_optimal_reqs
        try:
            opt = int(compiled.get_property("OPTIMAL_NUMBER_OF_INFER_REQUESTS"))
            if opt > _ov_optimal_reqs:
                _ov_optimal_reqs = opt
        except Exception:
            pass

        # Size N ONCE from the device's optimal infer-request count (falling back
        # to OV_DEFAULT_CONCURRENCY only when the property is missing/zero) so it
        # matches the predict-pool worker count sized in _run(); `_ov_request_count`
        # is the one place it is computed.
        import queue as _queue

        try:
            _n_req = int(compiled.get_property("OPTIMAL_NUMBER_OF_INFER_REQUESTS"))
        except Exception:
            _n_req = 0
        _n_req = _ov_request_count(_n_req)

        # Create ALL InferRequests ONCE, now, post-compile. With AUTO gone there is no CPU->GPU handover, so no request
        # can be born mid-handover and bind to stale ports — the score_8 race
        # is structurally removed. Requests are handed out through a thread-
        # safe queue: an InferRequest is never touched by two threads at once
        # (checkout/return), so sharing a fixed pool is safe and avoids the old
        # thread-local lazy creation.
        _req_pool: "_queue.Queue" = _queue.Queue()
        for _ in range(_n_req):
            _req_pool.put(compiled.create_infer_request())
        sys.stderr.write(f"OpenVINO: created {_n_req} InferRequest(s) up-front on {ov_device}\n")
        sys.stderr.flush()

        def predict(inp_dict: dict, _names=output_names, _pool=_req_pool) -> dict:
            inp = list(inp_dict.values())[0]
            req = _pool.get()
            try:
                result = req.infer(inp)
            finally:
                _pool.put(req)
            # Output fetch by positional index — stable and harmless now that
            # the ports no longer diverge (single explicit device, no handover).
            return {name: result[i] for i, name in enumerate(_names)}

        slot.model = compiled
        slot.predict_fn = predict
        # When the PPP preprocessor is folded in, `_preprocess` produces uint8
        # NHWC and short-circuits BEFORE the NHWC/NCHW float logic — so the
        # `_input_shape` heuristic below is irrelevant for PPP models. Record
        # the plan so `_preprocess` takes the uint8 fast path.
        if ppp_meta is not None:
            slot.config["_ov_ppp"] = ppp_meta
        else:
            # Capture the model's declared input layout so `_preprocess` feeds
            # NHWC vs NCHW correctly (ArcFace/CLIP are NHWC). Best-effort — a
            # failure leaves `_input_shape` unset → NCHW fallback (unchanged).
            try:
                slot.config["_input_shape"] = list(compiled.inputs[0].get_partial_shape())
            except Exception:
                pass

    elif _runtime == "onnxruntime":
        ort = _runtime_lib
        ort_device = str(config.get("device", "") or "")
        # WebGPU uses the plugin-EP SessionOptions path (ORT ≥1.24); everything
        # else uses the classic providers= list (see _resolve_onnx_providers).
        if ort_device.strip().lower() == "webgpu":
            # Isolated child — never create a WebGPU InferenceSession in this
            # process (second in-process session SIGSEGVs the pool worker).
            isolated = WebGpuIsolatedSession.open(path)
            active_list = isolated.providers
            _active_eps = [p for p in active_list if p != ONNX_CPU_EP]
            sys.stderr.write(
                f"ONNX: execution provider {', '.join(_active_eps) or ONNX_CPU_EP} "
                f"(device=webgpu, isolated)\n"
            )
            sys.stderr.flush()
            slot.config["_input_name"] = isolated.input_name
            try:
                slot.config["_input_shape"] = isolated.input_shape
            except Exception:
                pass
            try:
                if isolated.input_type == "tensor(uint8)":
                    slot.config["_input_dtype"] = "uint8"
            except Exception:
                pass

            def predict(inp_dict: dict, _iso=isolated) -> dict:
                return _iso.run(inp_dict)

            slot.model = isolated
            slot.predict_fn = predict
        else:
            try:
                available_eps = list(ort.get_available_providers())
            except Exception:
                available_eps = [ONNX_CPU_EP]
            providers = _resolve_onnx_providers(
                ort_device, sys.platform, platform.machine(), available_eps,
            )
            session = ort.InferenceSession(path, providers=providers)
            _active_eps = [p for p in session.get_providers() if p != ONNX_CPU_EP]
            _requested = [p[0] if isinstance(p, tuple) else p for p in providers]
            sys.stderr.write(
                f"ONNX: execution provider {', '.join(_active_eps) or ONNX_CPU_EP} "
                f"(device={ort_device or 'auto'}, requested={_requested}, "
                f"available={available_eps})\n"
            )
            sys.stderr.flush()
            output_names = [o.name for o in session.get_outputs()]
            slot.config["_input_name"] = session.get_inputs()[0].name
            # Declared input layout (ArcFace/CLIP are NHWC) → correct preprocess.
            try:
                slot.config["_input_shape"] = session.get_inputs()[0].shape
            except Exception:
                pass
            # Declared input DTYPE. super-gradients / plus catalog YOLO-NAS exports bake
            # their preprocessing into the graph and take `tensor(uint8)` — the
            # preprocess must feed raw uint8 pixels, not the float32 [0,1] tensor
            # (a hard onnxruntime type error otherwise).
            try:
                if session.get_inputs()[0].type == "tensor(uint8)":
                    slot.config["_input_dtype"] = "uint8"
            except Exception:
                pass

            def predict(inp_dict: dict) -> dict:
                outputs = session.run(output_names, inp_dict)
                return {name: out for name, out in zip(output_names, outputs)}

            slot.model = session
            slot.predict_fn = predict

    elif _runtime == "edgetpu":
        Interpreter = _runtime_lib["Interpreter"]
        delegate = _runtime_lib["delegate"]
        lock = _runtime_lib["lock"]
        interp = Interpreter(path, experimental_delegates=[delegate])
        interp.allocate_tensors()
        in_det = interp.get_input_details()[0]
        out_dets = interp.get_output_details()
        _, in_h, in_w, _ = (int(x) for x in in_det["shape"])
        in_dtype = np.dtype(in_det["dtype"]).name  # 'uint8' | 'int8' | 'float32'
        slot.config["_input_name"] = in_det["name"]
        slot.config["_edgetpu_in_dtype"] = in_dtype
        slot.config["inputWidth"] = in_w
        slot.config["inputHeight"] = in_h
        # The FILE's input size is the truth for a compiled Edge TPU graph: a
        # Coral build may be compiled at a smaller input than the catalog
        # entry's other formats (activations share the 8 MB on-chip memory
        # with the parameter cache, D710), and a decoder sized from the
        # catalog would put every prior in the wrong cell.
        slot.config["inputSize"] = max(in_w, in_h)
        in_index = int(in_det["index"])
        out_index = [int(o["index"]) for o in out_dets]
        from edgetpu_dequant import edgetpu_output_keys

        out_keys = edgetpu_output_keys(
            [str(o.get("name") or "") for o in out_dets], slot.config.get("postprocessor")
        )
        sys.stderr.write(
            f"EdgeTPU: loaded {os.path.basename(path)} in={in_w}x{in_h} "
            f"dtype={in_dtype} outputs={len(out_dets)}\n"
        )
        sys.stderr.flush()

        def predict(
            inp_dict: dict,
            _interp=interp, _lock=lock, _in=in_index, _outs=out_index, _details=out_dets,
            _keys=out_keys,
        ) -> dict:
            from edgetpu_dequant import dequant_edgetpu_output

            tensor = next(iter(inp_dict.values()))
            with _lock:
                _interp.set_tensor(_in, tensor)
                _interp.invoke()
                # `get_tensor` returns a copy, so the Coral is released before
                # the dequantisation below runs.
                raws = [_interp.get_tensor(idx) for idx in _outs]
            # Positional keys — ssd reads "0".."3"; yolo-split-dfl pairs by
            # shape — except for a postprocessor that matches by name
            # (`edgetpu_output_keys`). Integer outputs are dequantised here so
            # every postprocessor sees float32 (SSD Detection_PostProcess is
            # already float and passes through).
            result = {}
            for i, raw in enumerate(raws):
                detail = _details[i]
                q = detail.get("quantization") or (0.0, 0)
                scale = float(q[0]) if q else 0.0
                zp = int(q[1]) if q else 0
                dtype_name = str(np.dtype(detail["dtype"]).name)
                result[_keys[i]] = dequant_edgetpu_output(
                    raw, dtype_name=dtype_name, scale=scale, zero_point=zp
                )
            return result

        slot.model = interp
        slot.predict_fn = predict

    slot.loaded = True


def _unload_model(slot: ModelSlot) -> None:
    model = slot.model
    # WebGpuIsolatedSession (and any future handle) exposes close().
    close = getattr(model, "close", None)
    if callable(close):
        try:
            close()
        except Exception as err:
            sys.stderr.write(f"model close failed: {err}\n")
            sys.stderr.flush()
    slot.model = None
    slot.predict_fn = None
    slot.input_names = frozenset()
    slot.config = {}
    slot.loaded = False


# ---------------------------------------------------------------------------
# Preprocess + run_inference — pure sync helpers called from worker threads
# ---------------------------------------------------------------------------


# Preprocess cache for bench frames only. Keyed by (_bench_frame_id, inputSize)
# where _bench_frame_id is a stable integer tag set on PIL Images stored in
# frame_cache. Camera frames don't have this tag → no cache → correct behavior.
# Avoids the CPython id() reuse problem that caused stale detections.
_bench_preprocess_cache: dict[tuple[int, int], tuple[dict, float, tuple[int, int]]] = {}

# Verifiable proof that the bench preprocess cache is actually HIT on the
# sustained-throughput BATCH path. A tagged frame that misses runs the FULL
# decode-independent preprocess (letterbox + float/255 + transpose); a hit
# returns the pre-built input tensor untouched — pure inference, no CPU
# preprocess. The historical bug was that MSG_INFER_BATCH wrapped each item
# fresh WITHOUT the tag, so the cache was NEVER hit on the batch path and every
# inference re-ran the full preprocess. The sustained benchmark now asserts
# hits ≫ misses (surfaced in the `status` command) so that regression is caught.
_bench_cache_hits: int = 0
_bench_cache_misses: int = 0


def _bench_cache_stats() -> dict:
    """(hits, misses) for the bench preprocess cache — surfaced in `status`."""
    return {"hits": _bench_cache_hits, "misses": _bench_cache_misses}

def _is_channels_last(input_shape) -> bool:
    """True when a 4-D model input is NHWC ([N,H,W,C]) rather than NCHW
    ([N,C,H,W]). Heuristic: the LAST dim is a channel count (1 or 3) and the
    SECOND dim is a concrete non-channel value. ArcFace / CLIP declare
    [N,112,112,3] → True; standard detectors [N,3,H,W] → False. Robust to
    dynamic/None dims → returns False (NCHW, the prior unconditional
    behaviour) whenever it can't be sure, so detectors are never touched."""
    if input_shape is None or len(input_shape) != 4:
        return False

    def _as_int(v) -> "int | None":
        try:
            return int(v)
        except (TypeError, ValueError):
            pass
        # OpenVINO `Dimension` objects don't support int() (TypeError even
        # for STATIC dims — verified live on the hub: arcface's captured
        # shape [?,112,112,3] read as all-None → NCHW fallback → NPU shape
        # error). Static Dimensions expose get_length(); dynamic stay None.
        try:
            if getattr(v, "is_static", False):
                return int(v.get_length())
        except (TypeError, ValueError, AttributeError):
            pass
        return None

    last = _as_int(input_shape[-1])
    second = _as_int(input_shape[1])
    return last in (1, 3) and second is not None and second not in (1, 3)


def _resolve_input_dims(config: dict) -> tuple[int, int, int]:
    """Resolve (width, height, channels) for the model input.

    Explicit `inputWidth`/`inputHeight` (threaded from the catalog's
    `inputSize.{width,height}`) win; they fall back to the square `inputSize`
    (the max side) for legacy square models. `inputChannels` defaults to 3
    (RGB); 1 selects the grayscale CTC recognizer path. Pure — no numpy/PIL.
    """
    input_size = int(config.get("inputSize", 640))
    width = int(config.get("inputWidth") or input_size)
    height = int(config.get("inputHeight") or input_size)
    channels = int(config.get("inputChannels") or 3)
    return width, height, channels


def _to_model_tensor(arr: "np.ndarray", channels_last: bool) -> "np.ndarray":
    """Build the batched RGB model-input tensor from an HWC float array in [0,1].

    - ``channels_last`` (ArcFace/CLIP NHWC) → ``[1,H,W,C]`` untransposed.
    - otherwise → standard detector NCHW ``[1,C,H,W]``.

    Grayscale CTC recognizers do NOT use this — they need aspect-preserving
    resize + edge padding, see {@link _preprocess_ctc_gray}. Pure numpy.
    """
    if channels_last:
        return arr[np.newaxis].astype(np.float32)
    return arr.transpose(2, 0, 1)[np.newaxis].astype(np.float32)


_IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

# InsightFace's SCRFD input contract: upstream feeds `(pixel - 127.5) / 128`
# ([-0.996, 0.996]), not the pool's historical plain `/255` ([0,1]). Expressed
# against the pool's already-`/255` HWC array (`arr`, not raw pixels):
#   (arr*255 - 127.5) / 128  ==  (arr - _SCRFD_MEAN) / _SCRFD_STD
# with mean/std pre-divided by 255, the same shape of transform as the
# ImageNet branch below. See `postprocessors/scrfd.py` for the upstream
# citation and the measured effect (188 → 196 GT faces found,
# 2026-09-26 model-replacement spike, §2.4-2).
_SCRFD_MEAN = 127.5 / 255.0
_SCRFD_STD = 128.0 / 255.0


def _apply_normalization(arr: "np.ndarray", config: dict) -> "np.ndarray":
    """Apply per-model input normalization to an HWC RGB float array in [0,1].

    ``inputNormalization == 'imagenet'`` subtracts the ImageNet per-channel
    mean and divides by the std (RGB), matching the EfficientNet-Lite0 /
    MobileNetV3 animal + vehicle classifiers whose ``labels.json`` declares
    ``normalize: imagenet``. ``'scrfd'`` applies InsightFace's SCRFD contract
    (`_SCRFD_MEAN`/`_SCRFD_STD` above) — the `scrfd-2.5g` catalog entry.
    Absent / ``'none'`` / ``'zero-one'`` keep the plain ``/255`` array
    byte-identical to the historical unconditional path (most detectors,
    CLIP/ArcFace, and the AIY bird classifier which bakes its own scale). Runs
    on the HWC array BEFORE the optional NHWC/NCHW transpose in
    :func:`_to_model_tensor`, so it is layout-agnostic (channel axis is always
    last here). Pure numpy.
    """
    mode = config.get("inputNormalization")
    if mode not in ("imagenet", "scrfd"):
        return arr
    if arr.ndim != 3 or arr.shape[-1] != 3:
        return arr
    if mode == "scrfd":
        return (arr - _SCRFD_MEAN) / _SCRFD_STD
    return (arr - _IMAGENET_MEAN) / _IMAGENET_STD


def _preprocess_ctc_gray(img: "Image.Image", input_w: int, input_h: int) -> "np.ndarray":
    """EasyOCR-accurate preprocess for a fixed-width grayscale CTC recognizer.

    Mirrors EasyOCR's AlignCollate + NormalizePAD exactly:
      1. grayscale by luminance (PIL ``convert('L')``),
      2. resize to height ``input_h`` PRESERVING aspect ratio (width capped at
         ``input_w``) with BICUBIC — the recognizer was trained on undistorted
         glyphs; stretching the crop to the full ``input_w`` warps glyph aspect
         ~4x and the model reads noise (low-confidence garbage),
      3. normalize to ``[-1,1]`` (``(x/255 - 0.5)/0.5``),
      4. right-pad the width up to ``input_w`` by replicating the last column
         (EasyOCR NormalizePAD edge padding — NOT zeros).

    Returns a ``[1,1,input_h,input_w]`` float32 tensor. Pure numpy/PIL.
    """
    gray = img.convert("L")
    ow, oh = gray.size
    ratio = (ow / oh) if oh > 0 else 1.0
    resized_w = int(np.ceil(input_h * ratio))
    resized_w = max(1, min(input_w, resized_w))
    gray = gray.resize((resized_w, input_h), Image.BICUBIC)
    arr = np.asarray(gray, dtype=np.float32) / 255.0  # (H, resized_w)
    arr = (arr - 0.5) / 0.5  # [-1, 1]
    if resized_w < input_w:
        edge = arr[:, resized_w - 1 : resized_w]
        pad = np.repeat(edge, input_w - resized_w, axis=1)
        arr = np.concatenate([arr, pad], axis=1)
    return arr[np.newaxis, np.newaxis].astype(np.float32)  # (1, 1, H, W)


# ---------------------------------------------------------------------------
# Fix 2 — OpenVINO PrePostProcessor (preprocess folded into the compiled graph)
# ---------------------------------------------------------------------------

# Always ON for OpenVINO; a module constant only so tests can exercise the
# plain-path compile. A failed fold already falls back per model (above).
_OV_PPP_ENABLED: bool = True


def _ov_dim_to_int(dim: Any) -> "int | None":
    """Best-effort static-length extraction from an OpenVINO Dimension (or a
    plain int). Dynamic / unknown dims return None. Pure — no numpy."""
    try:
        return int(dim)
    except (TypeError, ValueError):
        pass
    try:
        if getattr(dim, "is_static", False):
            return int(dim.get_length())
    except (TypeError, ValueError, AttributeError):
        pass
    return None


def _ov_ppp_plan(
    dims: "list[int | None] | None",
    input_channels: int,
    preprocess_mode: str,
    normalization: "str | None",
    enabled: bool,
) -> "dict | None":
    """Pure decision: should preprocessing be folded into the OpenVINO graph?

    `dims` is the model's declared input partial-shape as a list of int|None in
    NCHW order. We only fold for standard 3-channel NCHW detectors/classifiers
    with a STATIC spatial size — grayscale CTC recognizers (channels==1) and
    NHWC-native embedders (ArcFace/CLIP, channel dim last) keep the pure-Python
    path. Returns a `ppp_meta` dict describing the Python-side uint8 producer,
    or None when PPP is not applicable. No OpenVINO / numpy imports —
    unit-testable in isolation."""
    if not enabled:
        return None
    if input_channels == 1:
        return None
    if dims is None or len(dims) != 4:
        return None
    _n, c, h, w = dims
    # NCHW with a concrete 3-channel dim. A last-dim of 3 (NHWC-native) leaves
    # c as a spatial value → rejected here, so embedders stay on the float path.
    if c != 3:
        return None
    if h is None or w is None or h <= 0 or w <= 0:
        return None
    return {
        "inputW": int(w),
        "inputH": int(h),
        "size": int(max(w, h)),
        "letterbox": preprocess_mode == "letterbox",
        "normalization": normalization or "none",
    }


def _preprocess_ov_uint8(
    img: "Image.Image", plan: dict,
) -> tuple["np.ndarray", float, tuple[int, int]]:
    """Produce the uint8 NHWC ``[1,H,W,3]`` input for a PPP-folded OV model.

    Letterbox (aspect-preserving pad) or plain resize stays in cheap uint8 PIL
    space; the compiled OV graph does the float convert + /255 + optional
    mean/std + NHWC→NCHW transpose on the inference device. Returns
    ``(tensor, scale, pad)`` — the scale/pad still drive the postprocessor's box
    mapping exactly like the letterbox float path. Pure numpy/PIL."""
    if plan["letterbox"]:
        canvas, scale_val, pad = letterbox_image(img, plan["size"])
    else:
        w, h = plan["inputW"], plan["inputH"]
        if img.size == (w, h):
            canvas, scale_val, pad = img, 1.0, (0, 0)
        else:
            canvas, scale_val, pad = img.resize((w, h), Image.BILINEAR), 1.0, (0, 0)
    pix = np.asarray(canvas, dtype=np.uint8)
    if pix.ndim == 2:
        pix = np.stack([pix] * 3, axis=-1)
    return pix[np.newaxis], scale_val, pad


def _build_ov_ppp_model(core: Any, path: str, config: dict) -> "tuple[Any, dict] | tuple[None, None]":
    """Read the OpenVINO IR and, when eligible, attach a PrePostProcessor that
    accepts a uint8 NHWC tensor and folds convert→scale(→mean/std)→layout into
    the compiled graph. Returns ``(model, ppp_meta)`` to compile, or
    ``(None, None)`` when PPP is not applied (caller compiles the path directly,
    byte-identical to the historical float path). Raises on hard OV errors so
    the caller's try/except falls back safely."""
    from openvino import Layout, Type
    from openvino.preprocess import PrePostProcessor

    model = core.read_model(path)
    inp = model.input()
    try:
        pshape = inp.get_partial_shape()
        dims = [_ov_dim_to_int(pshape[i]) for i in range(len(pshape))]
    except Exception:
        dims = None

    _iw, _ih, input_channels = _resolve_input_dims(config)
    plan = _ov_ppp_plan(
        dims,
        input_channels,
        config.get("preprocessMode", "letterbox"),
        config.get("inputNormalization"),
        _OV_PPP_ENABLED,
    )
    if plan is None:
        return None, None

    ppp = PrePostProcessor(model)
    # Tensor as the caller feeds it: uint8, NHWC, already at the model's spatial
    # size (Python letterboxes/resizes to size in uint8) → OV needs no resize.
    ppp.input().tensor().set_element_type(Type.u8).set_layout(Layout("NHWC"))
    ppp.input().model().set_layout(Layout("NCHW"))
    steps = ppp.input().preprocess().convert_element_type(Type.f32)
    if plan["normalization"] == "imagenet":
        # ((x/255) - mean) / std, applied in add-order (scale divides, mean
        # subtracts). RGB channel order matches the fed PIL tensor.
        steps.scale([255.0, 255.0, 255.0])
        steps.mean([float(v) for v in _IMAGENET_MEAN])
        steps.scale([float(v) for v in _IMAGENET_STD])
    elif plan["normalization"] == "scrfd":
        # ((x/255) - _SCRFD_MEAN) / _SCRFD_STD — InsightFace's SCRFD contract,
        # folded the same way as the ImageNet branch above (see
        # `_apply_normalization`/`_SCRFD_MEAN`/`_SCRFD_STD`).
        steps.scale([255.0, 255.0, 255.0])
        steps.mean([_SCRFD_MEAN, _SCRFD_MEAN, _SCRFD_MEAN])
        steps.scale([_SCRFD_STD, _SCRFD_STD, _SCRFD_STD])
    else:
        steps.scale([255.0, 255.0, 255.0])
    built = ppp.build()
    return built, plan


def _preprocess(img: Image.Image, config: dict) -> tuple[dict, float, tuple[int, int]]:
    input_size = config.get("inputSize", 640)
    input_w, input_h, input_channels = _resolve_input_dims(config)
    # Bench frames have _bench_frame_id tag → use preprocess cache
    bench_fid = getattr(img, '_bench_frame_id', None)
    if bench_fid is not None:
        global _bench_cache_hits, _bench_cache_misses
        cache_key = (bench_fid, input_size)
        cached = _bench_preprocess_cache.get(cache_key)
        if cached is not None:
            _bench_cache_hits += 1
            return cached
        _bench_cache_misses += 1
    preprocess_mode = config.get("preprocessMode", "letterbox")
    input_dict: dict = {}
    if _runtime == "coreml":
        input_name = config.get("_input_name", "image")
        input_type = config.get("_input_type", "imageType")
        input_shape = config.get("_input_shape")
        if input_type == "imageType":
            # FAST PATH — stay in uint8 PIL space. CoreML's predict()
            # accepts a PIL Image directly and handles the
            # BGR/normalize/CVPixelBuffer dance internally on its own
            # (zero-copy when the size matches the model input). Going
            # via numpy float32 → /255 → ×255 → astype(uint8) → Image.
            # fromarray() costs ~16ms per 640×640 frame on M3 Pro and is
            # PURE WASTE for imageType inputs.
            if preprocess_mode == "letterbox":
                canvas, scale_val, pad = letterbox_image(img, input_size)
            elif img.size == (input_size, input_size):
                canvas, scale_val, pad = img, 1.0, (0, 0)
            else:
                canvas, scale_val, pad = img.resize((input_size, input_size), Image.BILINEAR), 1.0, (0, 0)
            input_dict[input_name] = canvas
            arr = None  # not used downstream for imageType — postprocess runs on predictions
        elif input_shape is not None and len(input_shape) == 4:
            if input_channels == 1:
                # Grayscale CTC recognizer — EasyOCR aspect-preserving preprocess.
                input_arr = _preprocess_ctc_gray(img, input_w, input_h)
                scale_val = 1.0
                pad = (0, 0)
            else:
                if preprocess_mode == "letterbox":
                    arr, scale_val, pad = letterbox(img, input_size)
                else:
                    arr = resize_image(img, input_w, input_h)
                    scale_val = 1.0
                    pad = (0, 0)
                # Per-model input normalization (imagenet mean/std for the
                # animal + vehicle classifiers; no-op for everything else).
                arr = _apply_normalization(arr, config)
                # NHWC vs NCHW from the model's declared last dim (1/3 ⇒
                # channels-last), exactly as before for 3-channel models.
                _, _, _, w_or_c = input_shape
                input_arr = _to_model_tensor(arr, w_or_c in (1, 3))
            input_dict[input_name] = input_arr
        else:
            input_arr = arr.transpose(2, 0, 1)[np.newaxis].astype(np.float32)
            input_dict[input_name] = input_arr

        input_names = config.get("_input_names", [])
        if "iouThreshold" in input_names:
            input_dict["iouThreshold"] = 0.45
        if "confidenceThreshold" in input_names:
            input_dict["confidenceThreshold"] = config.get("confidence", 0.25)
    elif _runtime == "edgetpu":
        # EdgeTPU models are FULL-INTEGER quantized: feed raw uint8 (or int8)
        # pixels in NHWC [1,H,W,C] — NO float /255 normalization (that is baked
        # into the model's quantization params).
        input_name = config.get("_input_name", "images")
        in_w = int(config.get("inputWidth") or config.get("inputSize", 300))
        in_h = int(config.get("inputHeight") or config.get("inputSize", 300))
        if preprocess_mode == "letterbox":
            canvas, scale_val, pad = letterbox_image(img, max(in_w, in_h))
            rgb = canvas
        else:
            rgb = img if img.size == (in_w, in_h) else img.resize((in_w, in_h), Image.BILINEAR)
            scale_val, pad = 1.0, (0, 0)
        pix = np.asarray(rgb, dtype=np.uint8)
        if pix.ndim == 2:
            pix = np.stack([pix] * 3, axis=-1)
        if config.get("_edgetpu_in_dtype") == "int8":
            input_dict[input_name] = (pix.astype(np.int16) - 128).astype(np.int8)[np.newaxis]
        else:
            input_dict[input_name] = pix[np.newaxis]  # uint8 NHWC
    else:
        # OpenVINO / ONNX — always need a float tensor.
        input_name = config.get("_input_name", "images")
        # Fix 2 — OpenVINO PrePostProcessor fast path. When the model was
        # compiled with a folded uint8→float/scale/layout preprocessor
        # (`_ov_ppp` plan present), skip ALL numpy float work here: produce a
        # uint8 NHWC tensor (aspect-preserving letterbox stays in cheap PIL
        # space) and let the compiled OV graph do convert/scale/transpose on
        # the inference device. Removes the per-frame /255 + transpose that
        # dominated the non-inference CPU cost in production.
        ov_ppp = config.get("_ov_ppp") if _runtime == "openvino" else None
        if ov_ppp is not None and input_channels != 1:
            input_arr, scale_val, pad = _preprocess_ov_uint8(img, ov_ppp)
            input_dict[input_name] = input_arr
            result = (input_dict, scale_val, pad)
            if bench_fid is not None:
                _bench_preprocess_cache[(bench_fid, input_size)] = result
            return result
        # uint8-input ONNX models: super-gradients / plus catalog YOLO-NAS exports
        # bake the /255 preprocessing INTO the graph and declare a uint8 input
        # tensor. Feeding the historical float32 [0,1] tensor is a hard
        # onnxruntime type error, so feed raw uint8 pixels in the declared
        # layout instead (`_input_dtype` is captured at session load).
        if config.get("_input_dtype") == "uint8" and input_channels == 3:
            in_side = max(input_w, input_h)
            if preprocess_mode == "letterbox":
                canvas, scale_val, pad = letterbox_image(img, in_side)
            else:
                canvas = (
                    img
                    if img.size == (input_w, input_h)
                    else img.resize((input_w, input_h), Image.BILINEAR)
                )
                scale_val, pad = 1.0, (0, 0)
            pix = np.asarray(canvas, dtype=np.uint8)
            if pix.ndim == 2:
                pix = np.stack([pix] * 3, axis=-1)
            if _is_channels_last(config.get("_input_shape")):
                input_dict[input_name] = pix[np.newaxis]
            else:
                input_dict[input_name] = pix.transpose(2, 0, 1)[np.newaxis]
            result = (input_dict, scale_val, pad)
            if bench_fid is not None:
                _bench_preprocess_cache[(bench_fid, input_size)] = result
            return result
        if input_channels == 1:
            # Grayscale CTC recognizer (EasyOCR plate-OCR): aspect-preserving
            # resize + edge-pad + [-1,1] norm → [1,1,H,W]. NOT the squared
            # 3-channel RGB tensor (which the runtime rejected — the reason
            # plate recognition never ran).
            input_dict[input_name] = _preprocess_ctc_gray(img, input_w, input_h)
            scale_val = 1.0
            pad = (0, 0)
        else:
            if preprocess_mode == "letterbox":
                arr, scale_val, pad = letterbox(img, input_size)
            else:
                arr = resize_image(img, input_w, input_h)
                scale_val = 1.0
                pad = (0, 0)
            # Per-model input normalization (imagenet mean/std for the animal +
            # vehicle classifiers; no-op for detectors, CLIP, bird, etc.).
            arr = _apply_normalization(arr, config)
            # Feed the layout the model actually declares. NHWC models (ArcFace
            # face-embedding [N,112,112,3], CLIP) must NOT be NCHW-transposed —
            # a strict backend (NPU) throws on the wrong shape and the embedding
            # is never produced (the multi-day face-collection outage). Unknown
            # shape → NCHW (the prior behaviour), so detectors are unaffected.
            input_dict[input_name] = _to_model_tensor(
                arr, _is_channels_last(config.get("_input_shape"))
            )

    result = (input_dict, scale_val, pad)
    if bench_fid is not None:
        _bench_preprocess_cache[(bench_fid, input_size)] = result
    return result


def _postprocess(
    predictions: dict,
    slot_config: dict,
    orig_w: int,
    orig_h: int,
    scale_val: float,
    pad: tuple[int, int],
    elapsed_ms: float,
    preprocess_ms: float = 0.0,
    predict_ms: float = 0.0,
    batch_size: int = 1,
) -> dict:
    postprocessor_type = slot_config.get("postprocessor", "yolo")
    postprocessor_fn = POSTPROCESSORS.get(postprocessor_type)
    if postprocessor_fn is None:
        raise ValueError(f"Unknown postprocessor: {postprocessor_type}")
    result = postprocessor_fn(predictions, slot_config, orig_w, orig_h, scale_val, pad)
    result["inferenceMs"] = round(elapsed_ms, 2)
    result["preprocessMs"] = round(preprocess_ms, 2)
    result["predictMs"] = round(predict_ms, 2)
    result["batchSize"] = batch_size
    result["frameSize"] = f"{orig_w}x{orig_h}"
    return result


# ---------------------------------------------------------------------------
# Runtime dispatcher — pipelined prepare → predict → postprocess
# ---------------------------------------------------------------------------


class RuntimeDispatcher:
    """Split-stage dispatcher that lets preprocess run ahead of predict.

    Stages use separate thread pools so an in-flight `predict` doesn't
    block the preprocess for the next frame:

        camera A: preprocess → predict ─┐
        camera B:              preprocess → predict ─┐
        camera C:                          preprocess → predict ─┐

    While predict for A runs on the predict_pool, preprocess for B can
    run on the prepare_pool; each stage releases the Python event loop
    between calls so the reader stays responsive.

    `concurrency` sets the prepare pool size AND the predict pool size.
    For CoreML/OpenVINO the runtime itself serialises access to the
    device, so a single predict worker is usually enough. ONNX Runtime
    benefits from >1 (its InferenceSession.run is thread-safe and the
    native thread pool schedules concurrent runs).
    """

    def __init__(self, runtime: str, concurrency: int) -> None:
        workers = max(1, concurrency)
        self._workers = workers
        self._prepare_pool = concurrent.futures.ThreadPoolExecutor(
            max_workers=workers,
            thread_name_prefix=f"{runtime}-prep",
        )
        self._predict_pool = concurrent.futures.ThreadPoolExecutor(
            max_workers=workers,
            thread_name_prefix=f"{runtime}-predict",
        )

    @property
    def workers(self) -> int:
        return self._workers

    async def run(self, slot: ModelSlot, img: Image.Image) -> dict:
        loop = asyncio.get_event_loop()
        t_start = time.perf_counter()
        orig_w, orig_h = img.size
        # Stage 1 — preprocess. Runs on prepare_pool; overlaps with
        # any predict already scheduled for a previous frame.
        input_dict, scale_val, pad = await loop.run_in_executor(
            self._prepare_pool, _preprocess, img, slot.config,
        )
        t_predict_start = time.perf_counter()
        preprocess_ms = (t_predict_start - t_start) * 1000
        # Stage 2 — predict. Dedicated pool so preprocessors for later
        # frames can run while the runtime works on this one.
        predictions = await loop.run_in_executor(
            self._predict_pool, slot.predict_fn, input_dict,
        )
        # Stage 3 — postprocess. Cheap CPU-bound step; reuse the prepare
        # pool to avoid tying up a predict worker on scalar math.
        t_predict_end = time.perf_counter()
        predict_ms = (t_predict_end - t_predict_start) * 1000
        elapsed_ms = (t_predict_end - t_start) * 1000
        return await loop.run_in_executor(
            self._prepare_pool,
            _postprocess,
            predictions, slot.config, orig_w, orig_h, scale_val, pad, elapsed_ms,
            preprocess_ms, predict_ms, 1,
        )

    async def run_cached(
        self,
        slot: ModelSlot,
        img: Image.Image,
        cache_key: tuple[int, int],
        prep_cache: dict[tuple[int, int], tuple[dict, float, tuple[int, int], int, int]],
    ) -> dict:
        """Like run() but caches the preprocessed input dict. Second+
        calls for the same (frame_id, model_idx) skip preprocess entirely
        — goes straight to predict + postprocess. Saves ~10ms/call."""
        loop = asyncio.get_event_loop()
        t_start = time.perf_counter()
        orig_w, orig_h = img.size

        cached = prep_cache.get(cache_key)
        if cached is not None:
            input_dict, scale_val, pad, _, _ = cached
            preprocess_ms = 0.0
        else:
            input_dict, scale_val, pad = await loop.run_in_executor(
                self._prepare_pool, _preprocess, img, slot.config,
            )
            preprocess_ms = (time.perf_counter() - t_start) * 1000
            prep_cache[cache_key] = (input_dict, scale_val, pad, orig_w, orig_h)

        t_predict_start = time.perf_counter()
        predictions = await loop.run_in_executor(
            self._predict_pool, slot.predict_fn, input_dict,
        )
        t_predict_end = time.perf_counter()
        predict_ms = (t_predict_end - t_predict_start) * 1000
        elapsed_ms = (t_predict_end - t_start) * 1000
        return await loop.run_in_executor(
            self._prepare_pool,
            _postprocess,
            predictions, slot.config, orig_w, orig_h, scale_val, pad, elapsed_ms,
            preprocess_ms, predict_ms, 1,
        )

    async def run_list(self, slot: ModelSlot, imgs: list[Image.Image]) -> list[dict]:
        """Batch predict path — single CoreML/OV/ORT predict call processing
        all N items, then split + per-item postprocess.

        For CoreML: passes a list of input dicts to `model.predict(...)`,
        which CoreML iterates internally with shared session state — saves
        per-call ANE setup overhead vs a thread-pool fan-out.

        For OpenVINO/ONNX: falls back to a loop on the same predict thread
        (no model-level batching since their predict_fn signatures take one
        array). Still saves the asyncio.gather + ThreadPoolExecutor dispatch
        overhead.
        """
        if not imgs:
            return []
        loop = asyncio.get_event_loop()
        t_start = time.perf_counter()
        orig_sizes = [img.size for img in imgs]
        batch_size = len(imgs)

        # Stage 1 — preprocess all in parallel on the prepare pool.
        prepared = await asyncio.gather(*[
            loop.run_in_executor(self._prepare_pool, _preprocess, img, slot.config)
            for img in imgs
        ])
        # prepared = list of (input_dict, scale_val, pad)
        t_predict_start = time.perf_counter()
        preprocess_ms = (t_predict_start - t_start) * 1000

        # Stage 2 — single predict call on the predict thread.
        runtime = _runtime
        supports_batch = bool(slot.config.get("_supports_batch"))
        max_batch = int(slot.config.get("_max_batch", 1))
        if runtime == "coreml" and supports_batch and batch_size <= max_batch:
            # FAST PATH — stack the N preprocessed (1,3,H,W) tensors
            # into a single (N,3,H,W) tensor and issue ONE predict call.
            # The model was exported with a flexible batch axis so this
            # produces a single ANE dispatch processing all N frames in
            # parallel — amortises CoreML session setup AND the per-call
            # compute_units context-switch.
            input_name = slot.config.get("_input_name", "image")
            stacked = np.concatenate([p[0][input_name] for p in prepared], axis=0)

            def stacked_predict() -> list[dict]:
                names = slot.input_names
                payload: dict = {input_name: stacked}
                # Some models accept side-channel inputs (iouThreshold
                # etc.). Forward only those that the current model
                # accepts; the stacked input is set above.
                first = prepared[0][0]
                for k, v in first.items():
                    if k != input_name and (not names or k in names):
                        payload[k] = v
                out = slot.model.predict(payload)
                # Split each output along axis 0 back into N items.
                # Output shape (N, ...); slice per index and rebuild
                # per-item dicts so postprocess sees the same shape it
                # would for a single-frame predict.
                results: list[dict] = []
                for i in range(batch_size):
                    item: dict = {}
                    for k, v in out.items():
                        if hasattr(v, "shape") and len(v.shape) > 0 and v.shape[0] == batch_size:
                            item[k] = v[i:i + 1]
                        else:
                            item[k] = v
                    results.append(item)
                return results

            predictions_list = await loop.run_in_executor(self._predict_pool, stacked_predict)
        elif runtime == "coreml":
            # Fallback — model.predict([list of input dicts]) iterates
            # internally on shared session state. Not as fast as stacked
            # but still saves the asyncio.gather + ThreadPoolExecutor
            # dispatch overhead vs N separate calls.
            def batched_predict() -> list[dict]:
                names = slot.input_names
                if names:
                    cleaned = [{k: v for k, v in p[0].items() if k in names} for p in prepared]
                else:
                    cleaned = [p[0] for p in prepared]
                return slot.model.predict(cleaned)

            predictions_list = await loop.run_in_executor(self._predict_pool, batched_predict)
        else:
            # OpenVINO / ONNX — loop on the predict thread to keep IPC
            # amortisation (one executor dispatch instead of N) without
            # requiring model-level batched inputs.
            def looped_predict() -> list[dict]:
                return [slot.predict_fn(p[0]) for p in prepared]

            predictions_list = await loop.run_in_executor(self._predict_pool, looped_predict)

        # Stage 3 — postprocess each result. Per-item elapsed shares the
        # batch wall (fair attribution) — callers see it as `inferenceMs`.
        t_predict_end = time.perf_counter()
        predict_ms = (t_predict_end - t_predict_start) * 1000
        elapsed_ms = (t_predict_end - t_start) * 1000
        return await asyncio.gather(*[
            loop.run_in_executor(
                self._prepare_pool,
                _postprocess,
                predictions, slot.config,
                orig_sizes[i][0], orig_sizes[i][1],
                prepared[i][1], prepared[i][2],
                elapsed_ms,
                preprocess_ms, predict_ms, batch_size,
            )
            for i, predictions in enumerate(predictions_list)
        ])

    def close(self) -> None:
        self._prepare_pool.shutdown(wait=False)
        self._predict_pool.shutdown(wait=False)


# ---------------------------------------------------------------------------
# Per-model backpressure — bound in-flight inference, drop-oldest shedding
# ---------------------------------------------------------------------------

# Frames a single model may hold WAITING behind its running set before the
# OLDEST waiting frame is shed. Running slots (= predict-pool size) keep the
# device fed; a couple of pending frames cover dispatch gaps. Anything beyond
# that only sits in an invisible executor queue inflating per-frame
# "inference" time — on an overloaded node (N100 iGPU) that queue wait
# ballooned to 9-22s per frame. Shedding it instead makes overload read as
# `dropped` frames (fast `"dropped": true` responses) rather than latency.
MAX_PENDING_PER_MODEL: int = 2


@dataclass
class _ModelQueueState:
    """Mutable per-model counters for ModelBackpressure."""
    running: int = 0
    pending: "deque[Any]" = field(default_factory=deque)


class ModelBackpressure:
    """Per-model in-flight bound with drop-oldest shedding.

    Pure decision core — no asyncio, no I/O — so it is unit-testable
    (see test_inference_pool_backpressure.py). The event loop calls:

      admit(model_idx, item)  on every single-frame inference arrival.
        Returns (to_run, to_drop): items to dispatch NOW and items shed
        (oldest queued first). At most one of the lists is non-empty.
      complete(model_idx)     when a dispatched inference finishes.
        Returns the next queued items to dispatch (0 or 1).

    Why per-model and why these bounds: the predict pool has `workers`
    threads shared by all models; a model gets at most `max_running`
    concurrently-dispatched inferences (sized to the predict pool), plus
    a `max_pending` waiting buffer. The previous GLOBAL ceiling
    (`workers * 4`, min 16) was unreachable from the live pipeline — the
    TS runner's semaphore keeps at most `maxConcurrentInferences` frames
    in flight per node, well below 16 — so overload never shed frames; it
    just queued inside the executor as multi-second "inference" time.
    """

    def __init__(self, max_running: int, max_pending: int) -> None:
        self._max_running = max(1, max_running)
        self._max_pending = max(0, max_pending)
        self._states: dict[int, _ModelQueueState] = {}

    def _state(self, model_idx: int) -> _ModelQueueState:
        state = self._states.get(model_idx)
        if state is None:
            state = _ModelQueueState()
            self._states[model_idx] = state
        return state

    def admit(self, model_idx: int, item: Any) -> tuple[list, list]:
        """Admit one inference request; returns (to_run, to_drop)."""
        state = self._state(model_idx)
        if state.running < self._max_running:
            state.running += 1
            return [item], []
        state.pending.append(item)
        dropped: list = []
        while len(state.pending) > self._max_pending:
            # DROP-OLDEST: the newest frame is the most valuable one for a
            # live detection pipeline — shed the stalest queued frame(s).
            dropped.append(state.pending.popleft())
        return [], dropped

    def complete(self, model_idx: int) -> list:
        """One running inference finished; returns queued items to start."""
        state = self._state(model_idx)
        state.running = max(0, state.running - 1)
        if state.pending and state.running < self._max_running:
            state.running += 1
            return [state.pending.popleft()]
        return []

    def snapshot(self) -> dict:
        """Per-model {running, pending} — queue depth for the mem_stats line.

        A leak shows RSS climbing while these stay flat; a genuinely growing
        working set shows them climbing together. Pure read, no mutation.
        """
        return {
            str(idx): {"running": st.running, "pending": len(st.pending)}
            for idx, st in self._states.items()
        }


# ---------------------------------------------------------------------------
# Memory diagnostics (mem_stats command)
#
# The pools leak over hours and get OOM-killed (2026-08-18: anon-rss 3.8 GB /
# 8.8 GB, twice in six hours) — the Node-side watchdog samples RSS from
# /proc/<pid>/status, and asks THIS process once per sweep for the internals
# /proc cannot see: what the pool has been asked to do (request counters),
# what it is holding (caches, queue depths) and what the allocator is doing
# (arena count — the lead on total-vm 47.5 GB vs 11.3 GB at similar RSS).
# Everything here is a cheap O(1)-ish read; nothing walks the heap.
# ---------------------------------------------------------------------------


@dataclass
class PoolCounters:
    """Requests served since spawn, by opcode. Monotonic, wraps never."""

    infer_jpeg: int = 0
    infer_raw: int = 0
    infer_batch: int = 0
    infer_cached: int = 0
    commands: int = 0
    frames_cached: int = 0
    # Requests answered `dropped` because their wire deadline had already
    # passed when they would have run — dead work NOT executed (D350). For a
    # batch, every item counts.
    shed_deadline_expired: int = 0

    def as_dict(self) -> dict:
        return {
            "inferJpeg": self.infer_jpeg,
            "inferRaw": self.infer_raw,
            "inferBatch": self.infer_batch,
            "inferCached": self.infer_cached,
            "commands": self.commands,
            "framesCached": self.frames_cached,
            "shedDeadlineExpired": self.shed_deadline_expired,
            "totalInference": (
                self.infer_jpeg + self.infer_raw + self.infer_batch + self.infer_cached
            ),
        }


def _read_self_memory() -> dict:
    """RSS / VmSize / peak-RSS / swap / thread count for THIS process.

    /proc on Linux (one 4 KB read); getrusage maxrss everywhere as backstop.
    Partial results are fine — an empty dict means the read failed entirely.
    """
    out: dict = {}
    if sys.platform == "win32":
        # No `resource` and no /proc on Windows: psapi has the same numbers.
        return pool_platform.read_windows_memory()
    try:
        import resource

        ru = resource.getrusage(resource.RUSAGE_SELF)
        # ru_maxrss is kilobytes on Linux, BYTES on macOS.
        out["maxRssKb"] = (
            int(ru.ru_maxrss // 1024) if sys.platform == "darwin" else int(ru.ru_maxrss)
        )
    except Exception:
        pass
    try:
        with open("/proc/self/status", "r") as fh:
            text = fh.read()
        for label, key in (
            ("VmRSS", "rssKb"),
            ("VmSize", "vmKb"),
            ("VmHWM", "hwmKb"),
            ("VmSwap", "swapKb"),
        ):
            match = re.search(rf"^{label}:\s+(\d+)\s*kB", text, re.M)
            if match:
                out[key] = int(match.group(1))
        match = re.search(r"^Threads:\s+(\d+)", text, re.M)
        if match:
            out["threads"] = int(match.group(1))
    except Exception:
        pass
    return out


def _malloc_arena_count() -> Optional[int]:
    """Count glibc malloc arenas via malloc_info(3) into an in-memory stream.

    Each arena reserves up to 64 MB of VIRTUAL space — the count is the direct
    test of the "total-vm 47.5 GB is allocator arenas" hypothesis from the
    2026-08-18 OOM audit. glibc/Linux only; None elsewhere or on any failure
    (never raises — this rides the mem_stats reply and must not kill it).
    """
    if not sys.platform.startswith("linux"):
        return None
    try:
        import ctypes

        libc = ctypes.CDLL(None, use_errno=True)
        libc.open_memstream.restype = ctypes.c_void_p
        libc.open_memstream.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        libc.malloc_info.argtypes = [ctypes.c_int, ctypes.c_void_p]
        libc.fclose.argtypes = [ctypes.c_void_p]
        libc.free.argtypes = [ctypes.c_void_p]

        buf = ctypes.c_char_p()
        size = ctypes.c_size_t()
        stream = libc.open_memstream(ctypes.byref(buf), ctypes.byref(size))
        if not stream:
            return None
        rc = libc.malloc_info(0, stream)
        libc.fclose(stream)  # flushes and finalises buf/size
        try:
            if rc != 0 or not buf.value:
                return None
            xml = ctypes.string_at(buf, size.value)
            return xml.count(b"<heap nr=")
        finally:
            libc.free(buf)
    except Exception:
        return None


def _mem_stats_payload(
    models: list,
    counters: PoolCounters,
    backpressure: "ModelBackpressure",
    frame_cache_len: int,
    preprocess_cache_len: int,
    bench_cache_len: int,
    uptime_sec: int,
    model_load: Optional[dict] = None,
) -> dict:
    """Assemble the mem_stats reply. Pure given its inputs except the two
    process-wide reads (memory + arenas), so the shape is unit-testable."""
    return {
        "cmd": "mem_stats",
        "status": "ok",
        "memory": _read_self_memory(),
        "mallocArenas": _malloc_arena_count(),
        "gcCounts": list(gc.get_count()),
        "counters": counters.as_dict(),
        "backpressure": backpressure.snapshot(),
        "modelsLoaded": sum(1 for s in models if getattr(s, "loaded", False)),
        "frameCacheEntries": frame_cache_len,
        "preprocessCacheEntries": preprocess_cache_len,
        "benchPreprocessCacheEntries": bench_cache_len,
        "uptimeSec": uptime_sec,
        # What is compiling, and whether a compile ever failed to return
        # (D653) — the one fact a host needs to tell "slow" from "poisoned".
        "modelLoad": model_load,
    }


# ---------------------------------------------------------------------------
# Single-frame inference execution — module-level so the deadline gate is
# unit-testable (test_inference_pool_deadline.py) without driving the whole
# event loop. `handle_inference` in _run() delegates here; the caller's
# `finally` still owns the backpressure slot release.
# ---------------------------------------------------------------------------


async def _execute_inference(
    req_id: int,
    img: Any,
    model_idx: int,
    deadline_ms: int,
    *,
    models: "list[ModelSlot]",
    dispatcher: Any,
    writer: Any,
    batch_mode: str,
    get_accumulator: "Optional[Callable[[int], Any]]",
    counters: "PoolCounters",
) -> None:
    """Deadline gate + predict for ONE admitted single-frame request.

    The deadline is checked HERE — immediately before predict — rather than
    only at arrival, because this coroutine is entered both on admission and
    when the backpressure queue promotes a waiting frame: the wait is exactly
    where a request goes stale. The gate comes first (before the model-loaded
    check) on purpose — the cheapest question first, and an abandoned request
    deserves a shed, not a diagnosis. `dispatcher` and `writer` are
    duck-typed (RuntimeDispatcher / ResponseWriter in production).
    """
    now_ms = time.time() * 1000.0
    if _deadline_expired(deadline_ms, now_ms):
        counters.shed_deadline_expired += 1
        _log_deadline_shed(counters.shed_deadline_expired, model_idx, now_ms - deadline_ms)
        await writer.send(req_id, _dropped_deadline_payload())
        return
    if model_idx >= len(models) or not models[model_idx].loaded:
        await writer.send(req_id, {
            "error": f"Model {model_idx} not loaded",
            "kind": "detections",
            "detections": [],
            "inferenceMs": 0,
        })
        return
    if batch_mode == "window" and get_accumulator is not None:
        await get_accumulator(model_idx).submit(req_id, img)
        return
    result = await dispatcher.run(models[model_idx], img)
    await writer.send(req_id, result)


# ---------------------------------------------------------------------------
# IPC — binary framing with request_id multiplexing
# ---------------------------------------------------------------------------


HEADER_LEN = 4  # total_len prefix
PREFIX_LEN = HEADER_LEN + 4 + 1  # total_len + req_id + msg_type


async def _read_exact(reader: asyncio.StreamReader, n: int) -> bytes:
    return await reader.readexactly(n)


class ResponseWriter:
    """Serialises writes to the stdout pipe; safe from multiple coroutines."""

    def __init__(self, writer: asyncio.StreamWriter) -> None:
        self._writer = writer
        self._lock = asyncio.Lock()

    async def send(self, req_id: int, payload: dict) -> None:
        # numpy scalars (float32 / int64 / bool_) are NOT JSON-serializable
        # under the stdlib encoder. With numpy 2.x the previous lenient
        # path is gone, so we must coerce before encoding. Cheap default
        # callback only kicks in for unhandled types — Python natives skip
        # it entirely.
        data = json.dumps(payload, default=_json_default).encode("utf-8")
        total_len = 4 + len(data)  # req_id(4) + json
        header = struct.pack("<II", total_len, req_id)
        async with self._lock:
            self._writer.write(header)
            self._writer.write(data)
            await self._writer.drain()


def _json_default(obj: Any) -> Any:
    """Coerce numpy scalars/arrays to JSON-friendly Python natives."""
    if isinstance(obj, np.generic):
        return obj.item()
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    raise TypeError(f"Object of type {obj.__class__.__name__} is not JSON serializable")


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------

# Config keys a LOADED slot can absorb through `reconfigure` — decode-scoped
# values the postprocessor re-reads from `slot.config` on every inference, so
# they take effect on the next frame with no session reload. Mirrors
# `PoolDecodeSettings` on the TypeScript side; adding a key here without adding
# it there (or vice versa) reintroduces the D214 dead-knob class.
RECONFIGURABLE_CONFIG_KEYS = frozenset({"nmsIouThreshold"})


def _handle_command(models: list[ModelSlot], cmd: dict) -> dict:
    """The model commands that need no compile: unload, reconfigure, status.

    `load` and `replace` are NOT here — they compile, and a compile must never
    run on the event loop (D653). They go through `_handle_model_command`,
    which the `CommandRouter` awaits off the loop's reader.
    """
    action = cmd.get("cmd")
    if action == "unload":
        index = cmd["index"]
        if index < len(models) and models[index].loaded:
            _unload_model(models[index])
            sys.stderr.write(f"Model {index} unloaded\n")
            sys.stderr.flush()
        return {"cmd": "unload", "index": index, "status": "ok"}

    if action == "reconfigure":
        # Retune a LOADED slot's decode-scoped settings in place — no session
        # re-instantiation. `slot.config` is re-read by the postprocessor on
        # every inference (see `_postprocess`), so mutating these keys is
        # picked up by the next frame without a reload.
        #
        # ONLY the allow-listed keys are accepted. A `path` or `inputSize`
        # arriving here would be written into the config while the loaded
        # session kept serving the OLD model — a silent, undetectable lie.
        # Anything else is refused loudly; the caller must use `replace`.
        index = cmd["index"]
        patch = cmd.get("config") or {}
        unknown = sorted(k for k in patch if k not in RECONFIGURABLE_CONFIG_KEYS)
        if unknown:
            return {
                "cmd": "reconfigure",
                "index": index,
                "status": "error",
                "error": (
                    f"keys not reconfigurable without a reload: {', '.join(unknown)} "
                    f"(allowed: {', '.join(sorted(RECONFIGURABLE_CONFIG_KEYS))})"
                ),
            }
        if index >= len(models) or not models[index].loaded:
            return {
                "cmd": "reconfigure",
                "index": index,
                "status": "error",
                "error": f"model {index} is not loaded",
            }
        slot = models[index]
        before = {k: slot.config.get(k) for k in patch}
        slot.config.update(patch)
        sys.stderr.write(f"Model {index} reconfigured: {before} -> {dict(patch)}\n")
        sys.stderr.flush()
        return {"cmd": "reconfigure", "index": index, "status": "ok"}

    if action == "status":
        status = []
        for i, slot in enumerate(models):
            status.append({
                "index": i,
                "path": slot.config.get("path") if slot.loaded else None,
                "loaded": slot.loaded,
                "postprocessor": slot.config.get("postprocessor") if slot.loaded else None,
            })
        return {"cmd": "status", "models": status, "benchCache": _bench_cache_stats()}

    return {"cmd": action or "unknown", "status": "error", "error": f"Unknown command: {action}"}


# ---------------------------------------------------------------------------
# Model loads run OFF the event loop, one at a time, under a hard bound (D653)
# ---------------------------------------------------------------------------
#
# 2026-09-26, hub `openvino:gpu`: one `core.compile_model()` of
# `camstack-yunet-2023mar.xml` for the iGPU never returned. It ran INLINE on this
# loop, so from 18:33:48 until a container restart at 22:41 the worker read no
# request and wrote no reply: 786 client-side timeouts on six cameras, 123 of
# 123 `mem_stats` probes lost, and a process that looked perfectly alive.
#
# So a load now runs on its own DAEMON thread and the loop only awaits it:
# inference and `mem_stats` keep being served while a compile runs. And it is
# BOUNDED: past `MODEL_LOAD_TIMEOUT_SEC` the load answers `compile-timeout`,
# naming the model, instead of never answering.
#
# A native thread stuck in a GPU compiler cannot be cancelled or killed from
# Python. So a timeout POISONS the worker FOR NEW LOADS: every later load is
# refused at once (`worker-poisoned`) rather than queued behind a thread that
# may never free the compiler, and the models already loaded keep serving.
#
# The abandoned compile is NOT abandoned work (fix round 1): it keeps running,
# so a slow but finite compile still writes its cache. When it comes back the
# worker says so on the event channel (`compile-finished-late`) and is usable
# for loads again — the next load of that model is a warm cache hit. If it
# never comes back, the host kills the process at its HARD bound
# (shared-inference-pool.ts `POOL_MODEL_LOAD_BOUNDS`). Daemon, not an executor
# thread: `concurrent.futures` joins its threads at interpreter exit, so a stuck
# compile would also have made the worker impossible to shut down.

# SOFT bound on ONE model load — compile included — in seconds. A cold GPU
# compile of the whole model set on the N100 iGPU measured ~25 s; one model is
# normally 1-3 s. The host declares its own value in the startup config
# (`modelLoadTimeoutMs`) so its reply deadline and this bound cannot drift;
# this is what an old host that declares nothing gets.
MODEL_LOAD_TIMEOUT_SEC = 120.0

# Request id reserved for UNSOLICITED worker events (a reply to no request).
# The host never allocates it (shared-inference-pool.ts `WORKER_EVENT_REQ_ID`).
WORKER_EVENT_REQ_ID = 0xFFFFFFFF

# Commands answered by the loop immediately, never queued behind a load: the
# probe the host uses to tell "slow" from "wedged" must never wait for the very
# compile it is asking about.
INLINE_COMMANDS = frozenset({"mem_stats", "uncache_frame"})

# Commands that compile a model — the only ones that leave the loop.
LOAD_COMMANDS = frozenset({"load", "replace"})


def _model_load_timeout_sec(config: dict) -> float:
    """The load bound for this connection: the host's, else the default."""
    raw = config.get("modelLoadTimeoutMs")
    if isinstance(raw, (int, float)) and not isinstance(raw, bool) and raw > 0:
        return float(raw) / 1000.0
    return MODEL_LOAD_TIMEOUT_SEC


def _model_id_of(config: dict) -> str:
    """The model's file stem — what a log line and the host's reply carry."""
    path = str(config.get("path") or "")
    stem = os.path.splitext(os.path.basename(path))[0]
    return stem or "unknown"


class ModelLoadTimeout(Exception):
    """A load did not finish inside its bound; new loads are refused until it does."""


class WorkerPoisoned(Exception):
    """A previous load is still running past its bound; no new load starts."""


class ModelLoader:
    """Runs `_load_model` on a daemon thread under a hard bound.

    One load at a time is the CALLER's guarantee (the `CommandRouter` consumes
    model commands in order); this class only owns the thread, the bound and
    the poisoning. `load_fn` is injectable for tests; production passes
    nothing and gets the module's `_load_model`, looked up at call time.
    `notify` sends an unsolicited event to the host (the `compile-finished-late`
    line); absent, the event is only written to stderr.
    """

    def __init__(
        self,
        timeout_sec: float = MODEL_LOAD_TIMEOUT_SEC,
        load_fn: "Optional[Callable[[ModelSlot, dict], None]]" = None,
        notify: "Optional[Callable[[dict], Awaitable[None]]]" = None,
    ) -> None:
        self.timeout_sec = timeout_sec
        self._load_fn = load_fn
        self._notify = notify
        self.finished_late = 0
        # Test seam: runs on the load thread right after it has claimed the
        # outcome — lets a test hold the thread exactly in the race window.
        self._after_claim: Optional[Callable[[], None]] = None
        # Monotonic start of the compile running past its bound, if any — the
        # host counts its HARD bound from here, not from a later refusal.
        self._abandoned_started: Optional[float] = None
        # `ensure_future` tasks are only weakly referenced by the loop; keep
        # each notification alive until it is sent.
        self._pending_notifications: "set[asyncio.Future[None]]" = set()
        self.in_flight: Optional[dict] = None
        self.poisoned_by: Optional[dict] = None
        self.completed = 0
        self.failed = 0
        self.timed_out = 0

    def snapshot(self) -> dict:
        """What the `mem_stats` reply carries about loads."""
        in_flight = None
        if self.in_flight is not None:
            in_flight = {
                "index": self.in_flight["index"],
                "modelId": self.in_flight["modelId"],
                "elapsedMs": round((time.monotonic() - self.in_flight["startedAt"]) * 1000),
            }
        return {
            "inFlight": in_flight,
            "poisonedBy": dict(self.poisoned_by) if self.poisoned_by is not None else None,
            "boundMs": round(self.timeout_sec * 1000),
            "completed": self.completed,
            "failed": self.failed,
            "timedOut": self.timed_out,
            "finishedLate": self.finished_late,
        }

    def _finish_abandoned(
        self, index: int, model_id: str, outcome: Optional[BaseException], elapsed_ms: int,
    ) -> None:
        """On the loop: an abandoned compile came back. The compiler is free
        again, so the worker loads again; a successful one has written its
        cache, so the host's next load of the model is warm. Its RESULT is
        still discarded — the host was told it failed and has moved on."""
        self.finished_late += 1
        self.poisoned_by = None
        self._abandoned_started = None
        payload = {
            "event": "compile-finished-late",
            "index": index,
            "modelId": model_id,
            "ok": outcome is None,
            "elapsedMs": elapsed_ms,
        }
        if outcome is not None:
            payload["error"] = str(outcome)
        if self._notify is not None:
            task = asyncio.ensure_future(self._notify(payload))
            self._pending_notifications.add(task)
            task.add_done_callback(self._pending_notifications.discard)

    def abandoned_elapsed_ms(self) -> Optional[int]:
        """How long the compile running past its bound has been running."""
        if self._abandoned_started is None:
            return None
        return round((time.monotonic() - self._abandoned_started) * 1000)

    async def load(self, slot: ModelSlot, config: dict, index: int) -> None:
        """Load `config` into the DETACHED `slot`, or raise.

        Raises `WorkerPoisoned` without starting anything once a previous load
        timed out, `ModelLoadTimeout` when this one exceeds the bound, and the
        load's own exception when it fails in time.
        """
        model_id = _model_id_of(config)
        if self.poisoned_by is not None:
            raise WorkerPoisoned(
                f"worker poisoned for loads: the load of {self.poisoned_by['modelId']} is still "
                f"running past its bound ({self.poisoned_by['boundMs']}ms) — no new load starts "
                f"until it returns"
            )
        load_fn = self._load_fn if self._load_fn is not None else _load_model
        loop = asyncio.get_running_loop()
        done: "asyncio.Future[None]" = loop.create_future()
        # Exactly ONE of "the load returned in time" and "the bound fired"
        # wins, decided under this lock (release review). Without it the
        # thread could see "not abandoned", the bound fire before its settle
        # ran, and the worker stay poisoned forever for a load that finished.
        decision = threading.Lock()
        claimed: dict = {"by": None}  # "thread" | "bound"

        def settle(exc: Optional[BaseException]) -> None:
            if done.done():
                return
            if exc is None:
                done.set_result(None)
            else:
                done.set_exception(exc)

        def target() -> None:
            outcome: Optional[BaseException] = None
            try:
                load_fn(slot, config)
            except BaseException as exc:  # noqa: BLE001 — handed to the awaiting loop
                outcome = exc
            with decision:
                late = claimed["by"] == "bound"
                if not late:
                    claimed["by"] = "thread"
            if self._after_claim is not None:
                self._after_claim()
            if late:
                # The bound already fired. Say that the native call DID come
                # back, and when — the only evidence of how long a slow
                # compile really takes — and hand the worker back its loads.
                elapsed_ms = round((time.monotonic() - started) * 1000)
                sys.stderr.write(
                    f"Model {index} load of {model_id} returned AFTER its bound "
                    f"in {elapsed_ms}ms ({'error: ' + str(outcome) if outcome else 'ok'}) "
                    f"— result discarded, loads re-enabled\n"
                )
                sys.stderr.flush()
                try:
                    loop.call_soon_threadsafe(
                        self._finish_abandoned, index, model_id, outcome, elapsed_ms,
                    )
                except RuntimeError:
                    pass  # loop closed: the process is shutting down
                return
            try:
                loop.call_soon_threadsafe(settle, outcome)
            except RuntimeError:
                pass  # loop closed: the process is shutting down

        started = time.monotonic()
        self.in_flight = {"index": index, "modelId": model_id, "startedAt": started}
        thread = threading.Thread(target=target, name=f"model-load-{index}", daemon=True)
        thread.start()
        try:
            try:
                await asyncio.wait_for(asyncio.shield(done), timeout=self.timeout_sec)
            except asyncio.TimeoutError:
                with decision:
                    bound_won = claimed["by"] is None
                    if bound_won:
                        claimed["by"] = "bound"
                if bound_won:
                    raise
                # The load returned AT the bound: its settle is already on
                # its way to this loop. It counts as in time.
                await done
        except asyncio.TimeoutError:
            self.timed_out += 1
            self._abandoned_started = started
            self.poisoned_by = {
                "index": index,
                "modelId": model_id,
                "boundMs": round(self.timeout_sec * 1000),
                "at": round(time.time() * 1000),
            }
            raise ModelLoadTimeout(
                f"load of {model_id} (index {index}) did not return within "
                f"{round(self.timeout_sec * 1000)}ms — it keeps running so its cache "
                f"can be written; no new load starts until it returns"
            ) from None
        except Exception:
            self.failed += 1
            raise
        finally:
            self.in_flight = None
        self.completed += 1


async def _handle_model_command(
    models: "list[ModelSlot]", cmd: dict, loader: ModelLoader,
) -> dict:
    """Every model-management command, in order; `load`/`replace` off the loop.

    The new model is loaded into a DETACHED slot and installed only once its
    load completed inside the bound, so a compile that returns late — after the
    host was told `compile-timeout` — can never surface as a model the host
    believes failed. Whatever the index held before keeps serving until that
    swap: a `replace` that fails or times out leaves the old model in place,
    and the old slot object is only dropped, never mutated, so a predict
    already holding it finishes normally.
    """
    action = cmd.get("cmd")
    if action not in LOAD_COMMANDS:
        return _handle_command(models, cmd)
    index = cmd["index"]
    config = cmd["config"]
    model_id = _model_id_of(config)
    while len(models) <= index:
        models.append(ModelSlot())
    slot = ModelSlot()
    sys.stderr.write(
        f"Model {index} load started: {config['path']} "
        f"(bound {round(loader.timeout_sec * 1000)}ms)\n"
    )
    sys.stderr.flush()
    t0 = time.perf_counter()
    try:
        await loader.load(slot, config, index)
    except WorkerPoisoned as exc:
        return {
            "cmd": action, "index": index, "status": "error",
            "reason": "worker-poisoned", "modelId": model_id, "poisoned": True,
            # How long the EARLIER compile has run: the host's hard bound
            # counts from its start, not from this refusal.
            "compileElapsedMs": loader.abandoned_elapsed_ms(),
            "error": str(exc),
        }
    except ModelLoadTimeout as exc:
        sys.stderr.write(f"Model {index} load TIMED OUT: {exc}\n")
        sys.stderr.flush()
        return {
            "cmd": action, "index": index, "status": "error",
            "reason": "compile-timeout", "modelId": model_id, "poisoned": True,
            "timeoutMs": round(loader.timeout_sec * 1000),
            "compileElapsedMs": loader.abandoned_elapsed_ms(),
            "error": str(exc),
        }
    except Exception as exc:
        reply = {"cmd": action, "index": index, "status": "error", "error": str(exc)}
        # A typed refusal (e.g. `native-load-crashed`) names its class, so the
        # host can tell it from an ordinary failed load.
        reason = getattr(exc, "reason", None)
        if isinstance(reason, str):
            reply["reason"] = reason
            reply["modelId"] = model_id
        return reply
    models[index] = slot
    load_ms = round((time.perf_counter() - t0) * 1000)
    verb = "loaded" if action == "load" else "replaced"
    sys.stderr.write(f"Model {index} {verb}: {config['path']} ({load_ms}ms)\n")
    sys.stderr.flush()
    return {"cmd": action, "index": index, "status": "ok", "loadMs": load_ms}


class CommandRouter:
    """Routes MSG_COMMAND frames without ever blocking the reader.

    `INLINE_COMMANDS` are answered at once by `inline` (it needs the loop's own
    state: caches, backpressure, counters). Everything else is queued and
    consumed IN ORDER by one task — model slots are indices shared with the
    host, so a `status` or `unload` must never overtake the `load` sent before
    it.
    """

    def __init__(
        self,
        models: "list[ModelSlot]",
        loader: ModelLoader,
        send: "Callable[[int, dict], Awaitable[None]]",
        inline: "Callable[[dict], dict]",
    ) -> None:
        self._models = models
        self._loader = loader
        self._send = send
        self._inline = inline
        self._queue: "asyncio.Queue[tuple[int, dict]]" = asyncio.Queue()
        self._consumer: "Optional[asyncio.Task[None]]" = None

    async def submit(self, req_id: int, cmd: dict) -> None:
        if cmd.get("cmd") in INLINE_COMMANDS:
            try:
                response = self._inline(cmd)
            except Exception as exc:
                response = {"cmd": cmd.get("cmd") or "unknown", "status": "error", "error": str(exc)}
            await self._send(req_id, response)
            return
        self._queue.put_nowait((req_id, cmd))
        if self._consumer is None or self._consumer.done():
            self._consumer = asyncio.create_task(self._consume())

    async def _consume(self) -> None:
        while not self._queue.empty():
            req_id, cmd = self._queue.get_nowait()
            try:
                response = await _handle_model_command(self._models, cmd, self._loader)
            except Exception as exc:
                response = {"cmd": cmd.get("cmd") or "unknown", "status": "error", "error": str(exc)}
            await self._send(req_id, response)


# ---------------------------------------------------------------------------
# Main async loop
# ---------------------------------------------------------------------------


async def _run() -> None:
    loop = asyncio.get_event_loop()
    reader, stream_writer = await pool_platform.open_stdio(loop)
    writer = ResponseWriter(stream_writer)

    t_start = time.perf_counter()

    # ── Startup — first message is config (req_id=0, msg_type=COMMAND) ──
    header = await _read_exact(reader, PREFIX_LEN)
    total_len, req_id = struct.unpack("<II", header[0:8])
    msg_type = header[8]
    remaining = total_len - 5
    payload = await _read_exact(reader, remaining)
    if msg_type != MSG_COMMAND:
        sys.stderr.write(f"Expected startup config (cmd), got msg_type={msg_type}\n")
        sys.exit(1)
    config = json.loads(payload)
    runtime = config.get("runtime", "coreml")
    pool_device = str(config.get("device", "") or "")
    # Wire version for THIS connection (D350): an old host declares nothing
    # and negotiates v1 — byte-identical historical behaviour, no deadline
    # prefix expected on any payload.
    wire_version = _negotiate_wire_version(config)
    concurrency = int(config.get("concurrency", 1) or 1)
    batch_mode = str(config.get("batch_mode", "none"))
    if batch_mode not in ("none", "list", "window"):
        batch_mode = "none"
    window_ms = max(0, int(config.get("window_ms", 0) or 0))
    max_batch_size = max(1, int(config.get("max_batch_size", 1) or 1))

    sys.stderr.write(
        f"Initializing runtime: {runtime} (concurrency={concurrency}, "
        f"batch_mode={batch_mode}, window_ms={window_ms}, max_batch={max_batch_size}, "
        f"wire_version={wire_version})\n"
    )
    sys.stderr.flush()
    _init_runtime(runtime, pool_device)
    # Off-loop, bounded model loads (D653). Startup-config models below still
    # load inline: nothing is served before `ready`, and the host bounds that
    # handshake itself.
    model_loader = ModelLoader(
        timeout_sec=_model_load_timeout_sec(config),
        notify=lambda event: writer.send(WORKER_EVENT_REQ_ID, event),
    )

    models: list[ModelSlot] = []
    for i, mc in enumerate(config.get("models", [])):
        slot = ModelSlot()
        sys.stderr.write(f"Loading model {i}: {mc['path']}\n")
        sys.stderr.flush()
        try:
            _load_model(slot, mc)
        except Exception as exc:
            sys.stderr.write(f"ERROR loading model {i}: {exc}\n")
            sys.stderr.flush()
        models.append(slot)

    # OpenVINO: size the predict pool so the fixed InferRequest pool (built per
    # model in _load_model) is actually fed by concurrent predict workers. The
    # addon passes concurrency=1 (it predates the request pool) and models load
    # lazily AFTER this point, so we can't read OPTIMAL_NUMBER_OF_INFER_REQUESTS
    # here — `_ov_request_count(0)` then answers OV_DEFAULT_CONCURRENCY, because
    # a device that could not be asked is UNKNOWN and not small. A startup-loaded
    # model that DID answer sizes it to what the device actually wants. The
    # per-model InferRequest pool goes through the same function, so the two
    # cannot drift apart.
    if runtime == "openvino":
        target = _ov_request_count(_ov_optimal_reqs)
        if target > concurrency:
            sys.stderr.write(
                f"OpenVINO LATENCY: predict concurrency {concurrency} -> {target}\n"
            )
            sys.stderr.flush()
            concurrency = target

    dispatcher = RuntimeDispatcher(runtime, concurrency)
    # Backpressure: bound in-flight single-frame inference PER MODEL, shedding
    # the OLDEST queued frame when full (see ModelBackpressure). max_running is
    # sized to the predict pool — dispatching more than `workers` concurrent
    # inferences for one model can't run any faster, it only queues invisibly
    # inside the executor and balloons per-frame "inference" time (9-22s
    # observed on the N100 iGPU). Healthy nodes never fill the pending buffer,
    # so this is a no-op except under genuine overload.
    backpressure = ModelBackpressure(
        max_running=dispatcher.workers,
        max_pending=MAX_PENDING_PER_MODEL,
    )
    # Served-request counters + spawn time for the mem_stats command — the
    # denominator that lets the watchdog tell "RSS grew because it worked"
    # from "RSS grew per unit of work" (a leak).
    counters = PoolCounters()
    pool_started_monotonic = time.monotonic()
    startup_ms = round((time.perf_counter() - t_start) * 1000)
    loaded_count = sum(1 for s in models if s.loaded)
    sys.stderr.write(
        f"Ready — {loaded_count}/{len(models)} model(s) in {startup_ms}ms "
        f"(runtime={runtime}, workers={dispatcher.workers})\n"
    )
    sys.stderr.flush()

    # Compute the estimate scales from (D930). A failed probe is omitted —
    # never a row of zeros — and must not delay `ready`.
    accelerator_facts = None
    try:
        from accelerator_facts import facts_for_runtime, publish_accelerator_facts

        accelerator_facts = facts_for_runtime(runtime, _runtime_lib, pool_device)
        if accelerator_facts:
            publish_accelerator_facts(accelerator_facts)
    except Exception as exc:
        sys.stderr.write(f"accelerator facts: probe failed ({exc})\n")
        sys.stderr.flush()
        accelerator_facts = None

    ready_payload = {
        "status": "ready",
        "models": loaded_count,
        "total": len(models),
        "startupMs": startup_ms,
        "runtime": runtime,
        "workers": dispatcher.workers,
        # Our own capability, NOT the negotiated minimum: the Node side runs
        # the same min() against what it declared, so both ends derive the
        # identical effective version (D350).
        "protocolVersion": PROTOCOL_VERSION,
    }
    if accelerator_facts is not None:
        ready_payload["acceleratorFacts"] = accelerator_facts
    await writer.send(req_id, ready_payload)

    # ── Window accumulator (per-model) ──────────────────────────────
    #
    # In `window` mode, every MSG_INFER_RAW arrival pushes (req_id, img)
    # into a per-model pending queue and arms a `window_ms` timer. When
    # the timer fires, OR the queue reaches `max_batch_size`, we flush
    # via `dispatcher.run_list(slot, imgs)` — single batched predict.
    # Concurrent inferRaw calls from N cameras coalesce into one CoreML
    # predict call, amortising ANE setup.

    class WindowAccumulator:
        def __init__(self, model_idx: int) -> None:
            self.model_idx = model_idx
            self.pending: list[tuple[int, Image.Image]] = []
            self.flush_task: Optional[asyncio.Task[None]] = None

        async def submit(self, req_id: int, img: Image.Image) -> None:
            self.pending.append((req_id, img))
            if len(self.pending) >= max_batch_size:
                # Reached cap — cancel any pending timer (we are flushing
                # immediately from the caller's coroutine, not the timer)
                # and flush now.
                if self.flush_task is not None:
                    self.flush_task.cancel()
                    self.flush_task = None
                await self._flush()
                return
            if self.flush_task is None:
                self.flush_task = asyncio.create_task(self._delayed_flush())

        async def _delayed_flush(self) -> None:
            try:
                await asyncio.sleep(window_ms / 1000.0)
            except asyncio.CancelledError:
                return
            # Mark the timer task as complete BEFORE the dispatch await so
            # `_flush` does not try to cancel the running task (which would
            # raise CancelledError at `await dispatcher.run_list` and drop
            # responses on the floor — the symptom the TS side observed as
            # `runPipeline.mutate` hanging forever).
            self.flush_task = None
            await self._flush()

        async def _flush(self) -> None:
            batch = self.pending
            self.pending = []
            if not batch:
                return
            slot = models[self.model_idx]
            try:
                imgs = [b[1] for b in batch]
                results = await dispatcher.run_list(slot, imgs)
            except Exception as exc:
                sys.stderr.write(f"Window flush error (model {self.model_idx}): {exc}\n")
                sys.stderr.flush()
                err_payload = {
                    "error": str(exc),
                    "kind": "detections",
                    "detections": [],
                    "inferenceMs": 0,
                }
                for rid, _ in batch:
                    await writer.send(rid, err_payload)
                return
            for (rid, _), result in zip(batch, results):
                await writer.send(rid, result)

    accumulators: dict[int, WindowAccumulator] = {}

    # ── Bench frame cache ──────────────────────────────────────────
    # Stores raw PIL Images keyed by uint32 frame_id. The Node side
    # sends MSG_CACHE_FRAME once with the full 1.2MB payload; all
    # subsequent MSG_INFER_CACHED calls send only a 5-byte header
    # (model_idx + frame_id). Eliminates the 35ms/call pipe transfer
    # that dominates bench throughput.
    frame_cache: dict[int, Image.Image] = {}

    # Preprocessed-input cache: keyed by (frame_id, model_idx). First
    # inferCached call preprocesses and caches; subsequent calls skip
    # preprocess entirely and go straight to predict + postprocess.
    # Saves ~10ms/call (the PIL resize + numpy + tensor pack cost).
    _preprocess_cache: dict[tuple[int, int], tuple[dict, float, tuple[int, int], int, int]] = {}

    def inline_command(cmd: dict) -> dict:
        # Needs the loop's own state (caches, backpressure, counters), which
        # the model-command path never sees. Answered at once — this is the
        # host's liveness probe, and it must not wait for a compile.
        if cmd.get("cmd") == "mem_stats":
            return _mem_stats_payload(
                models,
                counters,
                backpressure,
                len(frame_cache),
                len(_preprocess_cache),
                len(_bench_preprocess_cache),
                round(time.monotonic() - pool_started_monotonic),
                model_load=model_loader.snapshot(),
            )
        fid = cmd.get("frameId", -1)
        frame_cache.pop(fid, None)
        # Purge preprocessed tensor caches for this frame
        for k in [k for k in _preprocess_cache if k[0] == fid]:
            del _preprocess_cache[k]
        # Also purge the bench preprocess cache
        for k in [k for k in _bench_preprocess_cache if k[0] == fid]:
            del _bench_preprocess_cache[k]
        return {"cmd": "uncache_frame", "status": "ok", "frameId": fid}

    command_router = CommandRouter(models, model_loader, writer.send, inline_command)

    def get_accumulator(model_idx: int) -> WindowAccumulator:
        acc = accumulators.get(model_idx)
        if acc is None:
            acc = WindowAccumulator(model_idx)
            accumulators[model_idx] = acc
        return acc

    # ── Main loop ───────────────────────────────────────────────────
    async def handle_inference(
        req_id: int, img: Image.Image, model_idx: int, deadline_ms: int = 0,
    ) -> None:
        try:
            # The deadline gate lives in _execute_inference, immediately
            # before predict — it runs here on admission AND again when a
            # queued frame is promoted below, which is where a request goes
            # stale (D350).
            await _execute_inference(
                req_id, img, model_idx, deadline_ms,
                models=models,
                dispatcher=dispatcher,
                writer=writer,
                batch_mode=batch_mode,
                get_accumulator=get_accumulator,
                counters=counters,
            )
        except Exception as exc:
            sys.stderr.write(f"Inference error (model {model_idx}, req {req_id}): {exc}\n")
            sys.stderr.flush()
            await writer.send(req_id, {
                "error": str(exc),
                "kind": "detections",
                "detections": [],
                "inferenceMs": 0,
            })
        finally:
            # Release this model's running slot; promote the next queued
            # frame (if any) into the freed slot immediately.
            for next_req_id, next_img, next_deadline_ms in backpressure.complete(model_idx):
                asyncio.create_task(
                    handle_inference(next_req_id, next_img, model_idx, next_deadline_ms)
                )

    def _send_dropped(req_id: int) -> None:
        # Fast shed response — returned in microseconds instead of queuing the
        # frame for seconds. The TS side (shared-inference-pool.ts) recognises
        # `dropped: true` and counts it, so overload is measurable, not silent.
        asyncio.create_task(writer.send(req_id, {
            "kind": "detections",
            "detections": [],
            "inferenceMs": 0,
            "dropped": True,
        }))

    def _dispatch_inference(
        req_id: int, img: Image.Image, model_idx: int, deadline_ms: int = 0,
    ) -> None:
        # Gate every single-frame inference through the per-model in-flight
        # bound. Slot accounting is synchronous (admit here, complete in the
        # handle_inference `finally`), so a slot can never leak past a task's
        # lifetime. Under overload the OLDEST queued frame is shed and answered
        # immediately so the caller never hangs on a frame we chose not to run.
        # The wire deadline rides the queued tuple so the gate in
        # _execute_inference sees it AFTER the wait, not just at arrival.
        to_run, to_drop = backpressure.admit(model_idx, (req_id, img, deadline_ms))
        for dropped_req_id, _dropped_img, _dropped_deadline in to_drop:
            _send_dropped(dropped_req_id)
        for run_req_id, run_img, run_deadline_ms in to_run:
            asyncio.create_task(handle_inference(run_req_id, run_img, model_idx, run_deadline_ms))

    async def handle_batch(
        req_id: int, model_idx: int, items: list[Image.Image], deadline_ms: int = 0,
    ) -> None:
        # Deadline gate first — the whole batch is one abandoned caller, so
        # every item is answered as a well-formed dropped record and none of
        # the work runs (D350).
        now_ms = time.time() * 1000.0
        if _deadline_expired(deadline_ms, now_ms):
            counters.shed_deadline_expired += len(items)
            _log_deadline_shed(counters.shed_deadline_expired, model_idx, now_ms - deadline_ms)
            await writer.send(req_id, {
                "results": [_dropped_deadline_payload() for _ in items],
            })
            return
        if model_idx >= len(models) or not models[model_idx].loaded:
            await writer.send(req_id, {
                "error": f"Model {model_idx} not loaded",
                "results": [],
            })
            return
        try:
            slot = models[model_idx]
            if batch_mode in ("list", "window"):
                # `list` mode: send the batch through dispatcher.run_list
                # — single predict call, internal CoreML iteration.
                # `window` mode: same dispatch path (no point queueing into
                # the accumulator when caller already packed N items).
                payload = await dispatcher.run_list(slot, items)
            else:
                tasks = [dispatcher.run(slot, img) for img in items]
                results = await asyncio.gather(*tasks, return_exceptions=True)
                payload = []
                for r in results:
                    if isinstance(r, Exception):
                        payload.append({
                            "error": str(r),
                            "kind": "detections",
                            "detections": [],
                            "inferenceMs": 0,
                        })
                    else:
                        payload.append(r)
            await writer.send(req_id, {"results": payload})
        except Exception as exc:
            sys.stderr.write(f"Batch error (model {model_idx}, req {req_id}): {exc}\n")
            sys.stderr.flush()
            await writer.send(req_id, {"error": str(exc), "results": []})

    while True:
        try:
            header = await _read_exact(reader, PREFIX_LEN)
        except asyncio.IncompleteReadError:
            return  # stdin closed
        total_len, req_id = struct.unpack("<II", header[0:8])
        msg_type = header[8]
        remaining = total_len - 5
        try:
            payload = await _read_exact(reader, remaining) if remaining > 0 else b""
        except asyncio.IncompleteReadError:
            return

        # v2 sheddable payloads carry [8B absolute deadline] first; v1 (and
        # every command) passes through untouched with deadline 0 (D350).
        try:
            deadline_ms, payload = _split_deadline(msg_type, payload, wire_version)
        except ValueError as exc:
            await writer.send(req_id, {"error": str(exc)})
            continue

        if msg_type == MSG_COMMAND:
            counters.commands += 1
            try:
                cmd = json.loads(payload)
            except Exception as exc:
                await writer.send(req_id, {"cmd": "unknown", "status": "error", "error": str(exc)})
                continue
            # NEVER awaits a model load: `load`/`replace` are queued and
            # compiled on their own thread under a bound (D653), so the next
            # frame is read while a GPU compile runs.
            await command_router.submit(req_id, cmd)

        elif msg_type == MSG_INFER_JPEG:
            counters.infer_jpeg += 1
            if len(payload) < 1:
                await writer.send(req_id, {"error": "empty infer_jpeg payload"})
                continue
            model_idx = payload[0]
            jpeg = payload[1:]
            try:
                img = decode_jpeg(jpeg)
            except Exception as exc:
                await writer.send(req_id, {"error": f"jpeg decode failed: {exc}"})
                continue
            _dispatch_inference(req_id, img, model_idx, deadline_ms)

        elif msg_type == MSG_INFER_RAW:
            counters.infer_raw += 1
            if len(payload) < 10:
                await writer.send(req_id, {"error": "truncated infer_raw header"})
                continue
            model_idx = payload[0]
            width, height = struct.unpack("<II", payload[1:9])
            fmt = payload[9]
            raw = payload[10:]
            try:
                img = wrap_raw(raw, width, height, fmt)
            except Exception as exc:
                await writer.send(req_id, {"error": f"raw wrap failed: {exc}"})
                continue
            _dispatch_inference(req_id, img, model_idx, deadline_ms)

        elif msg_type == MSG_INFER_BATCH:
            # Header: [1B model_idx][1B count][4B frame_id]
            # frame_id (0 = untagged, the live/default case). A NONZERO frame_id
            # tags every wrapped item with `_bench_frame_id` so `_preprocess`
            # uses the bench cache — the whole batch is the SAME pinned frame in
            # the sustained-throughput benchmark, so decode+preprocess runs ONCE
            # (first miss) and every later inference is a pure-inference cache
            # hit. Historically the batch path shipped no frame_id and re-ran the
            # full preprocess on every inference (the ~78fps ceiling).
            counters.infer_batch += 1
            if len(payload) < 6:
                await writer.send(req_id, {"error": "truncated infer_batch header"})
                continue
            model_idx = payload[0]
            count = payload[1]
            batch_frame_id = struct.unpack("<I", payload[2:6])[0]
            offset = 6
            items: list[Image.Image] = []
            parse_err: Optional[str] = None
            for _ in range(count):
                # Per-item header: [4B w][4B h][1B fmt][4B size]
                if offset + 13 > len(payload):
                    parse_err = "truncated batch item header"
                    break
                width, height = struct.unpack("<II", payload[offset:offset + 8])
                fmt = payload[offset + 8]
                size = struct.unpack("<I", payload[offset + 9:offset + 13])[0]
                offset += 13
                if offset + size > len(payload):
                    parse_err = "truncated batch item payload"
                    break
                raw = payload[offset:offset + size]
                offset += size
                try:
                    item_img = wrap_raw(raw, width, height, fmt)
                    if batch_frame_id != 0:
                        item_img._bench_frame_id = batch_frame_id
                    items.append(item_img)
                except Exception as exc:
                    parse_err = f"raw wrap failed: {exc}"
                    break
            if parse_err is not None:
                await writer.send(req_id, {"error": parse_err, "results": []})
                continue
            asyncio.create_task(handle_batch(req_id, model_idx, items, deadline_ms))

        elif msg_type == MSG_CACHE_FRAME:
            counters.frames_cached += 1
            # Wire: [4B frame_id][4B width][4B height][1B fmt][raw bytes]
            if len(payload) < 13:
                await writer.send(req_id, {"error": "truncated cache_frame header"})
                continue
            fid = struct.unpack("<I", payload[0:4])[0]
            width, height = struct.unpack("<II", payload[4:12])
            fmt = payload[12]
            raw = payload[13:]
            try:
                img = wrap_raw(raw, width, height, fmt)
                img._bench_frame_id = fid  # Tag for preprocess cache keying
                frame_cache[fid] = img
                await writer.send(req_id, {"status": "cached", "frameId": fid, "width": width, "height": height})
            except Exception as exc:
                await writer.send(req_id, {"error": f"cache_frame wrap failed: {exc}"})

        elif msg_type == MSG_INFER_CACHED:
            # Wire: [1B model_idx][4B frame_id]
            # Routes through handle_inference → window accumulator for
            # batching. The preprocess runs each time (~4ms) but batch=4
            # predict saves much more (8ms vs 4×9ms=36ms).
            counters.infer_cached += 1
            if len(payload) < 5:
                await writer.send(req_id, {"error": "truncated infer_cached header"})
                continue
            model_idx = payload[0]
            fid = struct.unpack("<I", payload[1:5])[0]
            img = frame_cache.get(fid)
            if img is None:
                await writer.send(req_id, {"error": f"frame {fid} not in cache"})
                continue
            if model_idx >= len(models) or not models[model_idx].loaded:
                await writer.send(req_id, {"error": f"model {model_idx} not loaded"})
                continue
            _dispatch_inference(req_id, img, model_idx, deadline_ms)

        else:
            await writer.send(req_id, {"error": f"unknown msg_type: {msg_type}"})


def main() -> None:
    # The host asks for a stack (SIGUSR1) before it kills a hung worker.
    pool_platform.register_stack_dump_signal()
    try:
        asyncio.run(_run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
