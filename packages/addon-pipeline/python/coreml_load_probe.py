"""Load a CoreML package in a CHILD process before the pool loads it in-process.

Why (2026-10-07, M3 Pro, macOS 26.2): the batch-flexible YOLO26 @320/@256
packages abort ANY process that loads them — SIGABRT from libmalloc inside
`Espresso::generic_gather_nd_kernel::top_shapes_for_bottom_shapes`, on every
compute unit, with coremltools 8.3 and 9.0 alike. Python cannot catch an
abort, so the pool worker died, the host respawned it, and the respawned
worker went straight back into the same load.

So the first load of a package (per fingerprint, compute unit and OS build)
happens in a throwaway interpreter. The verdict is remembered next to the
compiled-model cache:

  ok           -> load in-process, never probe this package again
  crashed      -> refuse with `CoremlLoadCrashed` (reason `native-load-crashed`)
                  now. ONE crash is only `suspect` (D926): refused without
                  probing for a cool-off, then probed again. A SECOND crash
                  at least a cool-off after the first caches `crashed`, refused
                  on every later load without re-probing; an `ok` resets.
  inconclusive -> (a Python exception in the child, a probe past its bound, a
                  child that could not start) remembered NOWHERE; the
                  in-process load runs exactly as it did before this gate

Only a death by SIGNAL is a crash. A Python-level failure raises the same
exception in-process, which the pool already turns into an error reply.

The child runs the pool's own `_acquire_coreml_model`, so on success it has
also written the compiled-model cache and the in-process load is a cache HIT:
the probe costs one interpreter start and one cached load, once per package.
"""
from __future__ import annotations

import json
import os
import platform
import signal
import subprocess
import sys
import time
from typing import Callable, Optional

# One-way: inference_pool imports this module lazily, inside its CoreML branch.
from inference_pool import COREML_CACHE_DIR_NAME, _coreml_model_fingerprint

VERDICT_OK = "ok"
VERDICT_CRASHED = "crashed"
VERDICT_INCONCLUSIVE = "inconclusive"

PROBE_VERDICT_VERSION = 1

# The two-crash rule, shared with `openvino_compile_probe` (D926, D49): one
# native crash is `suspect`; this many crashes, the last at least a cool-off
# after the first, is `crashed` and cached for good. A v1 `crashed` record
# (no `crashes` list) reads as ONE crash of unknown age, so it is re-probed.
VERDICT_SUSPECT = "suspect"
CRASHES_TO_CONFIRM = 2
CRASH_COOL_OFF_SEC = 600.0

Clock = Callable[[], float]
LoadAvg = Callable[[], "tuple[float, float, float]"]


def host_loadavg() -> "tuple[float, float, float]":
    try:
        return os.getloadavg()
    except (OSError, AttributeError):  # Windows has no load average
        return (-1.0, -1.0, -1.0)


def crash_at(crash: object) -> float:
    if isinstance(crash, dict):
        at = crash.get("at")
        if isinstance(at, (int, float)):
            return float(at)
    return 0.0


def crashes_confirmed(crashes: list) -> bool:
    """Two crashes (or more), the last at least a cool-off after the first."""
    if len(crashes) < CRASHES_TO_CONFIRM:
        return False
    return crash_at(crashes[-1]) - crash_at(crashes[0]) >= CRASH_COOL_OFF_SEC


def normalise_crash_record(stored: dict) -> Optional[dict]:
    """A stored verdict with its crash list filled in; an unconfirmed `crashed` reads `suspect`."""
    verdict = stored.get("verdict")
    if verdict not in (VERDICT_OK, VERDICT_CRASHED, VERDICT_SUSPECT):
        return None
    if verdict == VERDICT_OK:
        return stored
    crashes = stored.get("crashes")
    if not isinstance(crashes, list) or not crashes:
        crashes = [{"at": 0.0, "loadavg": None, "detail": str(stored.get("detail") or "")}]
    out = {**stored, "crashes": crashes}
    if verdict == VERDICT_CRASHED and not crashes_confirmed(crashes):
        out = {**out, "verdict": VERDICT_SUSPECT}
    return out


def record_crash(
    prior: list, detail: str, now: float, load: "tuple[float, float, float]",
) -> "tuple[str, list]":
    """Append one crash; return the verdict to store (`suspect` or `crashed`) and the list."""
    crashes = [*prior, {"at": now, "loadavg": [round(x, 2) for x in load], "detail": detail}]
    return (VERDICT_CRASHED if crashes_confirmed(crashes) else VERDICT_SUSPECT), crashes
PROBE_MARKER = "@@CAMSTACK_COREML_PROBE_OK@@"
# Long enough for the slowest cold compile measured on a Mac (rfdetr-package,
# 58 s); the pool's own load bound reports a slow load to the host meanwhile.
PROBE_TIMEOUT_SEC = 600.0

_HERE = os.path.dirname(os.path.abspath(__file__))

# The child loads the package exactly as the pool does (same function, same
# compute units, same compiled-model cache) and runs one predict on a neutral
# input, then prints the marker. It never touches the parent's state.
_CHILD_CODE = f"""
import json, sys
args = json.loads(sys.argv[1])
sys.path.insert(0, args["pool_dir"])
import coremltools as ct
import numpy as np
from PIL import Image
import inference_pool as ip
units = {{"cpu": ct.ComputeUnit.CPU_ONLY, "gpu": ct.ComputeUnit.CPU_AND_GPU,
         "ane": ct.ComputeUnit.CPU_AND_NE, "all": ct.ComputeUnit.ALL}}
model, spec = ip._acquire_coreml_model(ct, args["path"], units.get(args["device"], ct.ComputeUnit.ALL))
feed = {{}}
for inp in spec.description.input:
    kind = inp.type.WhichOneof("Type")
    if kind == "imageType":
        feed[inp.name] = Image.new("RGB", (inp.type.imageType.width, inp.type.imageType.height), (114, 114, 114))
    elif kind == "multiArrayType":
        mat = inp.type.multiArrayType
        if mat.WhichOneof("ShapeFlexibility") == "shapeRange":
            shape = [max(1, r.lowerBound) for r in mat.shapeRange.sizeRanges]
        else:
            shape = [max(1, d) for d in mat.shape]
        feed[inp.name] = np.zeros(shape, dtype=np.float32)
if feed:
    model.predict(feed)
print({PROBE_MARKER!r}, flush=True)
"""

ProbeRunner = Callable[[str, str], "tuple[str, str]"]


class CoremlLoadCrashed(Exception):
    """The package kills the native loader; it is refused instead of loaded."""

    reason = "native-load-crashed"

    def __init__(self, model_path: str, device: str, detail: str) -> None:
        self.model_path = model_path
        self.device = device
        self.detail = detail
        super().__init__(
            f"CoreML package {os.path.basename(model_path)} crashes the native loader "
            f"on device={device} ({detail}); refused so it cannot take the pool down. "
            f"Run this model through ONNX Runtime, or replace the package"
        )


def classify_probe_exit(returncode: int, marker_seen: bool) -> str:
    """Pure: the probe child's exit -> verdict. Only a signal death is a crash."""
    if returncode < 0:
        return VERDICT_CRASHED
    if returncode == 0 and marker_seen:
        return VERDICT_OK
    return VERDICT_INCONCLUSIVE


def _signal_name(signum: int) -> str:
    try:
        return signal.Signals(signum).name
    except ValueError:
        return str(signum)


def run_probe(
    model_path: str,
    device: str,
    child_code: str = _CHILD_CODE,
    timeout_sec: float = PROBE_TIMEOUT_SEC,
) -> "tuple[str, str]":
    """Load `model_path` in a fresh interpreter; return (verdict, detail)."""
    payload = json.dumps({"path": model_path, "device": device, "pool_dir": _HERE})
    try:
        proc = subprocess.run(
            [sys.executable, "-c", child_code, payload],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            timeout=timeout_sec,
        )
    except subprocess.TimeoutExpired:
        return VERDICT_INCONCLUSIVE, f"probe timed out after {timeout_sec:g}s"
    except OSError as exc:
        return VERDICT_INCONCLUSIVE, f"probe could not start ({exc})"
    marker_seen = any(line.strip() == PROBE_MARKER for line in proc.stdout.splitlines())
    verdict = classify_probe_exit(proc.returncode, marker_seen)
    tail = " | ".join(proc.stderr.strip().splitlines()[-3:])
    if proc.returncode < 0:
        detail = f"probe child died by signal {-proc.returncode} ({_signal_name(-proc.returncode)})"
    else:
        detail = f"probe child exited {proc.returncode}"
    return verdict, f"{detail}{': ' + tail if tail else ''}"


# The runner `ensure_coreml_loadable` uses when it is given none — looked up
# at call time, so a test can replace it.
DEFAULT_RUNNER: ProbeRunner = run_probe


def current_os_build() -> str:
    """The OS the verdict was measured on: a macOS update may fix or break a package."""
    release = platform.mac_ver()[0]
    return f"{release or platform.system()} {platform.version()}"


def probe_verdict_path(model_path: str, device: str) -> str:
    models_dir = os.path.dirname(os.path.abspath(model_path))
    stem = os.path.splitext(os.path.basename(model_path))[0]
    return os.path.join(models_dir, COREML_CACHE_DIR_NAME, f"{stem}.{device}.probe.json")


def _read_verdict(path: str, key: dict) -> Optional[dict]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            stored = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(stored, dict) or stored.get("key") != key:
        return None
    return normalise_crash_record(stored)


def _write_verdict(
    path: str, key: dict, verdict: str, detail: str, crashes: "Optional[list]" = None,
) -> None:
    """Atomic replace; a verdict that cannot be written only costs a re-probe."""
    tmp = f"{path}.tmp-{os.getpid()}"
    record: dict = {"key": key, "verdict": verdict, "detail": detail}
    if crashes:
        record["crashes"] = crashes
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(record, fh)
        os.replace(tmp, path)
    except OSError as exc:
        sys.stderr.write(f"CoreML probe: could not persist the verdict for {path} ({exc})\n")
        sys.stderr.flush()
        try:
            os.remove(tmp)
        except OSError:
            pass


def ensure_coreml_loadable(
    model_path: str,
    device: str,
    run: Optional[ProbeRunner] = None,
    os_build: Optional[str] = None,
    now: Optional[Clock] = None,
    loadavg: Optional[LoadAvg] = None,
) -> None:
    """Return when `model_path` may be loaded in-process; raise when it would crash."""
    clock = now if now is not None else time.time
    key = {
        "version": PROBE_VERDICT_VERSION,
        "fingerprint": _coreml_model_fingerprint(model_path),  # a re-download is a new package
        "device": device,
        "os": os_build if os_build is not None else current_os_build(),
    }
    verdict_path = probe_verdict_path(model_path, device)
    known = _read_verdict(verdict_path, key)
    name = os.path.basename(model_path)
    prior_crashes: list = []
    if known is not None:
        if known["verdict"] == VERDICT_CRASHED:
            _log(f"{name} device={device} is a KNOWN loader crash "
                 f"({len(known['crashes'])} crashes) — refused")
            raise CoremlLoadCrashed(model_path, device, str(known.get("detail") or "known crash"))
        if known["verdict"] == VERDICT_OK:
            return
        prior_crashes = list(known["crashes"])
        retry_at = crash_at(prior_crashes[-1]) + CRASH_COOL_OFF_SEC
        if clock() < retry_at:
            _log(f"{name} device={device} crashed the loader once — refused until the "
                 f"cool-off ends ({retry_at - clock():.0f}s left)")
            raise CoremlLoadCrashed(
                model_path, device,
                f"{known.get('detail') or 'one crash'}; one crash so far, "
                f"re-probed after {CRASH_COOL_OFF_SEC:g}s",
            )
    runner = run if run is not None else DEFAULT_RUNNER
    verdict, detail = runner(model_path, device)
    _log(f"{name} device={device} -> {verdict} ({detail})")
    if verdict == VERDICT_OK:
        _write_verdict(verdict_path, key, verdict, detail)
        return
    if verdict != VERDICT_CRASHED:
        return  # inconclusive: remembered nowhere; an earlier suspect stands
    load = (loadavg if loadavg is not None else host_loadavg)()
    stored, crashes = record_crash(prior_crashes, detail, clock(), load)
    _log(f"{name} device={device} loader crash {len(crashes)}/{CRASHES_TO_CONFIRM} "
         f"(load {load[0]:.1f}) -> {stored}")
    _write_verdict(verdict_path, key, stored, detail, crashes)
    raise CoremlLoadCrashed(model_path, device, detail)


def _log(line: str) -> None:
    sys.stderr.write(f"CoreML probe: {line}\n")
    sys.stderr.flush()
