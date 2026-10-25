"""
WebGPU ORT sessions in a dedicated OS process.

One child process per WebGPU model (D823). This module:

  - loads a WebGPU session — used by the child worker;
  - hosts the child worker entrypoint (`python webgpu_isolated.py --ipc-in N --ipc-out M`);
  - exposes `WebGpuIsolatedSession` for the pool parent: one child per model.

Two facts measured on agent-b 2026-10-13 (D845) shape the loader:

  1. The SIGSEGV that motivated D823 was NOT a second session. It is a second
     `register_execution_provider_library` call for a name that is already
     registered: ORT raises "EP library is already registered", and the next
     `InferenceSession` on that EP then dies in `_create_inference_session`.
     Register ONCE per process (`_ensure_webgpu_ep_registered`) and three
     sessions in one process load and run — serialised; concurrent `run()` on
     distinct sessions aborts the process, so a shared process would need one
     lock. The child-per-model layout stays for crash isolation.
  2. Dawn never reports a software adapter. With `/dev/dri/renderD*` not
     openable (the entrypoint dropped the render group), the session still
     answered `providers=[WebGpuExecutionProvider, …]` and ran at 224 ms per
     yolov9t-320 frame with gpu_busy 0 % — 15× the GPU's 13 ms, for a week,
     looking like a weak iGPU. A render node that cannot be opened is
     therefore REFUSED before any session is built; the error names the
     uid/gid so the fix (device ownership in the entrypoint) is one read away.

IPC uses dedicated pipe fds (`pass_fds`), never stdin/stdout — ORT/Dawn log on
fd 1 and a yolov9 raw head on a shared stdout pickle channel truncated the
frame (2026-10-10). Pipe `read(n)` can also return short; framing uses
`_read_exact`.

OpenVINO / CoreML / classic ONNX stay in-process in inference_pool.py.
"""
from __future__ import annotations

import os
import pickle
import struct
import subprocess
import sys
import threading
from typing import Any, BinaryIO, Callable, Optional

ONNX_CPU_EP = "CPUExecutionProvider"
ONNX_WEBGPU_EP_REGISTRATION = "webgpu_ep_registration"

# ORT's CPU thread pool in a WebGPU child only feeds buffer uploads and the
# rare CPU-placed node; the per-frame cost is Dawn's dispatch on ONE thread.
# Measured 2026-10-13 (yolov9t-320 warm p50): 14.2 ms at 1, 2 and 6 threads —
# so the default (one spinning thread per core, per child, ten children on a
# six-core node) buys nothing and costs CPU. Two keeps a CPU-placed node from
# serialising fully.
WEBGPU_INTRA_OP_THREADS = 2

RENDER_NODE_DIR = "/dev/dri"
RENDER_NODE_PREFIX = "renderD"

_HDR = struct.Struct(">I")

_webgpu_registered = False
_webgpu_register_lock = threading.Lock()


class WebGpuDeviceUnavailable(RuntimeError):
    """The webgpu device was asked for and cannot reach a GPU. Never served from CPU."""


def render_node_accessible(
    *,
    platform: str = sys.platform,
    listdir: Callable[[str], list[str]] = os.listdir,
    access: Callable[[str, int], bool] = os.access,
) -> Optional[bool]:
    """True when some /dev/dri/renderD* is readable+writable by this process.

    None on a platform without DRM render nodes (nothing to check); False when
    the directory is absent, empty of render nodes, or every node is denied.
    """
    if not platform.startswith("linux"):
        return None
    try:
        names = [n for n in listdir(RENDER_NODE_DIR) if n.startswith(RENDER_NODE_PREFIX)]
    except OSError:
        return False
    if not names:
        return False
    return any(access(os.path.join(RENDER_NODE_DIR, n), os.R_OK | os.W_OK) for n in names)


def _identity() -> str:
    try:
        return f"uid={os.getuid()} gid={os.getgid()} groups={sorted(os.getgroups())}"
    except (AttributeError, OSError):
        return "uid=? gid=? groups=?"


def _ensure_webgpu_ep_registered(ort: Any, webgpu_ep: Any) -> None:
    """Register the plugin EP library at most once per process.

    A second registration under the same name raises and leaves the next
    session creation to SIGSEGV (the real cause behind D823's "second session
    crashes"). Idempotent across callers and threads.
    """
    global _webgpu_registered
    with _webgpu_register_lock:
        if _webgpu_registered:
            return
        ort.register_execution_provider_library(
            ONNX_WEBGPU_EP_REGISTRATION, webgpu_ep.get_library_path()
        )
        _webgpu_registered = True


def _read_exact(stream: BinaryIO, n: int) -> bytes:
    """Read exactly n bytes; pipe read() may return short without EOF."""
    buf = bytearray()
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            raise EOFError("webgpu worker closed")
        buf.extend(chunk)
    return bytes(buf)


def _write_msg(stream: BinaryIO, obj: Any) -> None:
    payload = pickle.dumps(obj, protocol=pickle.HIGHEST_PROTOCOL)
    stream.write(_HDR.pack(len(payload)))
    stream.write(payload)
    stream.flush()


def _read_msg(stream: BinaryIO) -> Any:
    hdr = _read_exact(stream, _HDR.size)
    (n,) = _HDR.unpack(hdr)
    if n > 512 * 1024 * 1024:
        raise RuntimeError(f"webgpu IPC frame too large: {n}")
    data = _read_exact(stream, n)
    return pickle.loads(data)


def load_onnx_webgpu_session(
    ort: Any,
    path: str,
    *,
    render_node_ok: Optional[bool] = None,
) -> tuple[Any, list[str]]:
    """Build an InferenceSession on the WebGPU plugin EP.

    Refuses (`WebGpuDeviceUnavailable`) when no DRM render node is openable —
    Dawn would otherwise serve the session from software and still call it
    WebGPU. A missing plugin or a missing Vulkan adapter still falls back to
    the CPU EP, and says so in `providers`.
    """
    accessible = render_node_accessible() if render_node_ok is None else render_node_ok
    if accessible is False:
        raise WebGpuDeviceUnavailable(
            f"ONNX WebGPU: no openable {RENDER_NODE_DIR}/{RENDER_NODE_PREFIX}* "
            f"({_identity()}) — Dawn would run this model on a software adapter at "
            f"~15× the GPU latency while reporting WebGpuExecutionProvider; refusing "
            f"device webgpu. The container entrypoint must own or group-grant the "
            f"render node to the camstack user (compose group_add is dropped by gosu)."
        )

    try:
        import onnxruntime_ep_webgpu as webgpu_ep  # type: ignore
    except Exception as err:
        sys.stderr.write(f"ONNX WebGPU: plugin import failed ({err}); CPU fallback\n")
        sys.stderr.flush()
        return ort.InferenceSession(path, providers=[ONNX_CPU_EP]), [ONNX_CPU_EP]

    try:
        _ensure_webgpu_ep_registered(ort, webgpu_ep)
    except Exception as err:
        sys.stderr.write(f"ONNX WebGPU: register failed ({err}); CPU fallback\n")
        sys.stderr.flush()
        return ort.InferenceSession(path, providers=[ONNX_CPU_EP]), [ONNX_CPU_EP]

    ep_name = webgpu_ep.get_ep_name()
    webgpu_device = next(
        (d for d in ort.get_ep_devices() if getattr(d, "ep_name", None) == ep_name),
        None,
    )
    if webgpu_device is None:
        sys.stderr.write(
            f"ONNX WebGPU: no OrtEpDevice for {ep_name!r} "
            f"(Vulkan/libvulkan missing?); CPU fallback\n"
        )
        sys.stderr.flush()
        return ort.InferenceSession(path, providers=[ONNX_CPU_EP]), [ONNX_CPU_EP]

    sess_options = ort.SessionOptions()
    sess_options.intra_op_num_threads = WEBGPU_INTRA_OP_THREADS
    sess_options.add_provider_for_devices([webgpu_device], {})
    session = ort.InferenceSession(path, sess_options=sess_options)
    active = list(session.get_providers())
    sys.stderr.write(
        f"ONNX WebGPU: providers={active} ep={ep_name} device=webgpu "
        f"render-node=ok {_identity()}\n"
    )
    sys.stderr.flush()
    return session, active


def _parse_ipc_fds(argv: list[str]) -> tuple[int, int]:
    ipc_in: Optional[int] = None
    ipc_out: Optional[int] = None
    i = 0
    while i < len(argv):
        if argv[i] == "--ipc-in" and i + 1 < len(argv):
            ipc_in = int(argv[i + 1])
            i += 2
            continue
        if argv[i] == "--ipc-out" and i + 1 < len(argv):
            ipc_out = int(argv[i + 1])
            i += 2
            continue
        i += 1
    if ipc_in is None or ipc_out is None:
        raise SystemExit("webgpu_isolated worker needs --ipc-in FD --ipc-out FD")
    return ipc_in, ipc_out


def _worker_main(argv: list[str]) -> None:
    """One InferenceSession; commands on --ipc-in, replies on --ipc-out."""
    import numpy as np
    import onnxruntime as ort

    fd_in, fd_out = _parse_ipc_fds(argv)
    ipc_in = os.fdopen(fd_in, "rb", buffering=0)
    ipc_out = os.fdopen(fd_out, "wb", buffering=0)

    session = None
    output_names: list[str] = []
    while True:
        try:
            msg = _read_msg(ipc_in)
        except EOFError:
            break
        cmd = msg.get("cmd")
        if cmd == "shutdown":
            _write_msg(ipc_out, {"ok": True})
            break
        if cmd == "load":
            path = msg["path"]
            try:
                session, providers = load_onnx_webgpu_session(ort, path)
                output_names = [o.name for o in session.get_outputs()]
                inp = session.get_inputs()[0]
                _write_msg(
                    ipc_out,
                    {
                        "ok": True,
                        "providers": providers,
                        "input_name": inp.name,
                        "input_shape": list(inp.shape),
                        "input_type": inp.type,
                        "output_names": output_names,
                    },
                )
            except Exception as exc:
                _write_msg(ipc_out, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})
            continue
        if cmd == "predict":
            if session is None:
                _write_msg(ipc_out, {"ok": False, "error": "no session"})
                continue
            try:
                outputs = session.run(output_names, msg["inputs"])
                payload = {
                    name: np.ascontiguousarray(out)
                    for name, out in zip(output_names, outputs)
                }
                _write_msg(ipc_out, {"ok": True, "outputs": payload})
            except Exception as exc:
                _write_msg(ipc_out, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})
            continue
        _write_msg(ipc_out, {"ok": False, "error": f"unknown cmd {cmd!r}"})


class WebGpuIsolatedSession:
    """Parent-side handle: one child process holding one WebGPU ORT session."""

    def __init__(self, proc: subprocess.Popen, ipc_in: BinaryIO, ipc_out: BinaryIO, meta: dict):
        self._proc = proc
        self._ipc_in = ipc_in  # parent reads replies
        self._ipc_out = ipc_out  # parent writes commands
        self._lock = threading.Lock()
        self.providers: list[str] = list(meta["providers"])
        self.input_name: str = meta["input_name"]
        self.input_shape = meta["input_shape"]
        self.input_type: str = meta["input_type"]
        self.output_names: list[str] = list(meta["output_names"])

    @classmethod
    def open(cls, path: str, *, python_exe: Optional[str] = None) -> "WebGpuIsolatedSession":
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "webgpu_isolated.py")
        exe = python_exe or sys.executable
        # cmd_r ← parent writes commands; reply_r ← parent reads replies
        cmd_r, cmd_w = os.pipe()
        reply_r, reply_w = os.pipe()
        try:
            proc = subprocess.Popen(
                [exe, script, "--ipc-in", str(cmd_r), "--ipc-out", str(reply_w)],
                pass_fds=(cmd_r, reply_w),
                stdin=subprocess.DEVNULL,
                stdout=None,  # inherit — ORT/Dawn logs stay in the pool log
                stderr=None,
                close_fds=True,
            )
        except Exception:
            for fd in (cmd_r, cmd_w, reply_r, reply_w):
                try:
                    os.close(fd)
                except OSError:
                    pass
            raise
        # Parent keeps cmd_w + reply_r; close the ends the child owns.
        os.close(cmd_r)
        os.close(reply_w)
        ipc_out = os.fdopen(cmd_w, "wb", buffering=0)
        ipc_in = os.fdopen(reply_r, "rb", buffering=0)
        try:
            _write_msg(ipc_out, {"cmd": "load", "path": path})
            reply = _read_msg(ipc_in)
        except Exception:
            ipc_out.close()
            ipc_in.close()
            proc.kill()
            proc.wait(timeout=5)
            raise
        if not reply.get("ok"):
            ipc_out.close()
            ipc_in.close()
            proc.kill()
            proc.wait(timeout=5)
            raise RuntimeError(reply.get("error") or "webgpu child load failed")
        sys.stderr.write(
            f"ONNX WebGPU: isolated child pid={proc.pid} providers={reply['providers']}\n"
        )
        sys.stderr.flush()
        return cls(proc, ipc_in, ipc_out, reply)

    def run(self, inputs: dict) -> dict:
        with self._lock:
            if self._proc.poll() is not None:
                raise RuntimeError(
                    f"webgpu child dead (exit={self._proc.returncode})"
                )
            _write_msg(self._ipc_out, {"cmd": "predict", "inputs": inputs})
            reply = _read_msg(self._ipc_in)
        if not reply.get("ok"):
            raise RuntimeError(reply.get("error") or "webgpu predict failed")
        return reply["outputs"]

    def close(self) -> None:
        proc = self._proc
        if proc.poll() is not None:
            try:
                self._ipc_out.close()
            except Exception:
                pass
            try:
                self._ipc_in.close()
            except Exception:
                pass
            return
        try:
            _write_msg(self._ipc_out, {"cmd": "shutdown"})
            proc.wait(timeout=5)
        except Exception:
            pass
        try:
            self._ipc_out.close()
        except Exception:
            pass
        try:
            self._ipc_in.close()
        except Exception:
            pass
        if proc.poll() is None:
            proc.kill()
            try:
                proc.wait(timeout=5)
            except Exception:
                pass


if __name__ == "__main__":
    _worker_main(sys.argv[1:])
