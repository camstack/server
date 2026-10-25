"""Compile an OpenVINO GPU/NPU model in a CHILD process before the pool loads it.

Why (2026-10-22, hub with a Core Ultra 7 265K iGPU, OpenVINO 2025.4.1): the
iGPU compiler SIGSEGVed the pool worker three times in 15 s while
`compile_model()` ran for a model with no compiled blob (`malloc(): unsorted
double linked list corrupted`, then `longjmp causes uninitialized stack
frame`). The compile runs in the same process as the predict threads and every
other model, so one native crash took the whole `openvino:gpu` worker (and the
camera's detection with it) down, and the respawn went straight back into the
same load. Python cannot catch a SIGSEGV. A warm load (blob present) never
crashed.

So the first load of each (model x device request x compile config) happens in
a throwaway interpreter that runs the pool's OWN `_load_model` — same
PrePostProcessor, same candidate list, same properties, same CACHE_DIR — and
therefore writes the blob the pool then loads warm. Mirrors CoreML's
`coreml_load_probe.py` (D742):

  ok           -> load in-process (a cache HIT), never probe this key again
                  while the blobs the probe wrote are still on disk
  crashed      -> refuse with `OpenvinoLoadCrashed` (reason
                  `native-load-crashed`) now. ONE crash is only `suspect`:
                  later loads are refused without probing until a cool-off
                  (CRASH_COOL_OFF_SEC) has passed, then probed again. Only a
                  SECOND crash at least a cool-off after the first caches
                  `crashed` — refused on every later load of the same key,
                  without re-probing. An `ok` in between resets the count.
  inconclusive -> (a Python exception in the child, a probe past its bound, a
                  child that could not start) remembered NOWHERE; the
                  in-process load runs exactly as it did before this gate

Only a death by SIGNAL is a crash. CPU-only loads are never probed.

Why two (2026-10-23, D926): a single SIGSEGV during an overloaded moment wrote
`crashed`, and every later request for that model on the GPU was refused for
good. A destructive verdict needs a second agreeing read (D49). Every crash is
recorded with its time, the host load average and the child's detail. To
clear a verdict by hand, delete
`<models>/.ov-cache/<model>.<DEVICE>.ovprobe.json`.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from typing import Callable, Optional

# One-way: inference_pool imports this module lazily, inside its OpenVINO branch.
# The two-crash rule (D926) lives there too, shared by both probes.
from coreml_load_probe import (
    CRASH_COOL_OFF_SEC,
    CRASHES_TO_CONFIRM,
    VERDICT_CRASHED,
    VERDICT_INCONCLUSIVE,
    VERDICT_OK,
    VERDICT_SUSPECT,
    Clock,
    LoadAvg,
    _signal_name,
    classify_probe_exit,
    crash_at,
    host_loadavg,
    normalise_crash_record,
    record_crash,
)

# The key's version stays 1: a v1 `crashed` file (no `crashes` list) is read
# as ONE crash of unknown age, so it is re-probed rather than discarded.
PROBE_VERDICT_VERSION = 1
PROBE_MARKER = "@@CAMSTACK_OV_PROBE_OK@@"
# A cold iGPU compile of a large detector takes tens of seconds; past this the
# probe says nothing and the pool's own load bound (POOL_MODEL_LOAD_BOUNDS)
# is the only fence, exactly as before the probe existed.
PROBE_TIMEOUT_SEC = 300.0
# The config keys that change what `compile_model` is handed (PrePostProcessor
# plan, input shape, precision hint). A threshold or a class list does not.
COMPILE_CONFIG_KEYS = (
    "device",
    "inputSize",
    "inputWidth",
    "inputHeight",
    "inputChannels",
    "preprocessMode",
    "inputNormalization",
    "gpuInferencePrecision",
)
PROBED_DEVICE_PREFIXES = ("GPU", "NPU")

_HERE = os.path.dirname(os.path.abspath(__file__))

# The child runs the pool's own loader, with the probe switched off in it.
_CHILD_CODE = f"""
import json, sys
args = json.loads(sys.argv[1])
sys.path.insert(0, args["pool_dir"])
import inference_pool as ip
ip._ov_probe_enabled = False
ip._init_runtime("openvino", str(args["config"].get("device", "")))
ip._load_model(ip.ModelSlot(), args["config"])
print({PROBE_MARKER!r}, flush=True)
"""

ProbeRunner = Callable[[str, dict], "tuple[str, str]"]


class OpenvinoLoadCrashed(Exception):
    """The model kills the native compiler on this device; refused instead of loaded."""

    reason = "native-load-crashed"

    def __init__(self, model_path: str, device: str, detail: str) -> None:
        self.model_path = model_path
        self.device = device
        self.detail = detail
        super().__init__(
            f"OpenVINO model {os.path.basename(model_path)} crashes the native compiler "
            f"on device={device} ({detail}); refused so it cannot take the pool down. "
            f"Run this model on another device, or replace it"
        )


def needs_probe(candidates: "list[str]") -> bool:
    """True when any compile target is a GPU or an NPU (CPU-only loads are never probed)."""
    return any(str(c).upper().startswith(PROBED_DEVICE_PREFIXES) for c in candidates)


def run_probe(
    model_path: str,
    config: dict,
    child_code: str = _CHILD_CODE,
    timeout_sec: float = PROBE_TIMEOUT_SEC,
) -> "tuple[str, str]":
    """Compile `model_path` in a fresh interpreter; return (verdict, detail)."""
    payload = json.dumps({"config": {**config, "path": model_path}, "pool_dir": _HERE})
    try:
        proc = subprocess.run(
            [sys.executable, "-c", child_code, payload],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            timeout=timeout_sec,
        )
    except subprocess.TimeoutExpired:
        return VERDICT_INCONCLUSIVE, f"probe timed out after {timeout_sec:g}s"
    except (OSError, TypeError, ValueError) as exc:
        return VERDICT_INCONCLUSIVE, f"probe could not start ({exc})"
    marker_seen = any(line.strip() == PROBE_MARKER for line in proc.stdout.splitlines())
    verdict = classify_probe_exit(proc.returncode, marker_seen)
    tail = " | ".join(proc.stderr.strip().splitlines()[-3:])
    if proc.returncode < 0:
        detail = f"probe child died by signal {-proc.returncode} ({_signal_name(-proc.returncode)})"
    else:
        detail = f"probe child exited {proc.returncode}"
    return verdict, f"{detail}{': ' + tail if tail else ''}"


# Looked up at call time, so a test can replace it.
DEFAULT_RUNNER: ProbeRunner = run_probe


def _file_fingerprint(path: str) -> dict:
    """size + mtime of the model file and, for an IR, its `.bin` weights."""
    out: dict = {}
    for candidate in (path, os.path.splitext(path)[0] + ".bin"):
        try:
            st = os.stat(candidate)
        except OSError:
            continue
        out[os.path.basename(candidate)] = [st.st_size, st.st_mtime_ns]
    return out


def probe_key(path: str, config: dict, candidates: "list[str]", env_tag: str) -> dict:
    return {
        "version": PROBE_VERDICT_VERSION,
        "model": _file_fingerprint(path),
        "candidates": [str(c).upper() for c in candidates],
        "compile": {k: config.get(k) for k in COMPILE_CONFIG_KEYS},
        # An OpenVINO / GPU-driver update may fix or break a model.
        "env": env_tag,
    }


def probe_verdict_path(path: str, config: dict, cache_dir: str) -> str:
    stem = os.path.splitext(os.path.basename(path))[0]
    device = str(config.get("device", "AUTO")).upper() or "AUTO"
    return os.path.join(cache_dir, f"{stem}.{device}.ovprobe.json")


def _blob_names(cache_dir: str) -> "set[str]":
    try:
        return {n for n in os.listdir(cache_dir) if n.endswith(".blob")}
    except OSError:
        return set()


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
    path: str, key: dict, verdict: str, detail: str, blobs: "list[str]",
    crashes: "Optional[list]" = None,
) -> None:
    """Atomic replace; a verdict that cannot be written only costs a re-probe."""
    tmp = f"{path}.tmp-{os.getpid()}"
    record: dict = {"key": key, "verdict": verdict, "detail": detail, "blobs": blobs}
    if crashes:
        record["crashes"] = crashes
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(record, fh)
        os.replace(tmp, path)
    except OSError as exc:
        sys.stderr.write(f"OpenVINO probe: could not persist the verdict for {path} ({exc})\n")
        sys.stderr.flush()
        try:
            os.remove(tmp)
        except OSError:
            pass


def _warm(known: dict, cache_dir: str) -> bool:
    """An `ok` verdict holds only while the blobs its probe wrote are still on disk."""
    blobs = known.get("blobs")
    if not isinstance(blobs, list):
        return False
    return all(os.path.isfile(os.path.join(cache_dir, str(b))) for b in blobs)


def ensure_openvino_loadable(
    model_path: str,
    config: dict,
    candidates: "list[str]",
    cache_dir: Optional[str],
    env_tag: str = "",
    run: Optional[ProbeRunner] = None,
    now: Optional[Clock] = None,
    loadavg: Optional[LoadAvg] = None,
) -> None:
    """Return when `model_path` may be compiled in-process; raise when it would crash."""
    if not needs_probe(candidates):
        return
    clock = now if now is not None else time.time
    name = os.path.basename(model_path)
    device = str(config.get("device", "AUTO"))
    key = probe_key(model_path, config, candidates, env_tag)
    verdict_path = probe_verdict_path(model_path, config, cache_dir) if cache_dir else None
    prior_crashes: list = []
    if verdict_path is not None:
        known = _read_verdict(verdict_path, key)
        if known is not None:
            if known["verdict"] == VERDICT_CRASHED:
                _log(f"{name} device={device} is a KNOWN compiler crash "
                     f"({len(known['crashes'])} crashes) — refused")
                raise OpenvinoLoadCrashed(model_path, device, str(known.get("detail") or "known crash"))
            if known["verdict"] == VERDICT_SUSPECT:
                prior_crashes = list(known["crashes"])
                retry_at = crash_at(prior_crashes[-1]) + CRASH_COOL_OFF_SEC
                if clock() < retry_at:
                    _log(f"{name} device={device} crashed the compiler once — refused until "
                         f"the cool-off ends ({retry_at - clock():.0f}s left)")
                    raise OpenvinoLoadCrashed(
                        model_path, device,
                        f"{known.get('detail') or 'one crash'}; one crash so far, "
                        f"re-probed after {CRASH_COOL_OFF_SEC:g}s",
                    )
            elif cache_dir is not None and _warm(known, cache_dir):
                return  # blob present: the in-process load is a cache hit
    before = _blob_names(cache_dir) if cache_dir else set()
    runner = run if run is not None else DEFAULT_RUNNER
    verdict, detail = runner(model_path, config)
    _log(f"{name} device={device} -> {verdict} ({detail})")
    if verdict == VERDICT_OK:
        if verdict_path is not None and cache_dir is not None:
            written = sorted(_blob_names(cache_dir) - before)
            _write_verdict(verdict_path, key, verdict, detail, written)
        return
    if verdict != VERDICT_CRASHED:
        return  # inconclusive: remembered nowhere; an earlier suspect stands
    load = (loadavg if loadavg is not None else host_loadavg)()
    stored, crashes = record_crash(prior_crashes, detail, clock(), load)
    _log(f"{name} device={device} compiler crash {len(crashes)}/{CRASHES_TO_CONFIRM} "
         f"(load {load[0]:.1f}) -> {stored}")
    if verdict_path is not None and cache_dir is not None:
        _write_verdict(verdict_path, key, stored, detail, [], crashes)
    raise OpenvinoLoadCrashed(model_path, device, detail)


def _log(line: str) -> None:
    sys.stderr.write(f"OpenVINO probe: {line}\n")
    sys.stderr.flush()
