"""Unit tests for the OpenVINO child-process compile probe (openvino_compile_probe).

An iGPU compiler SIGSEGV (2026-10-22, hub Core Ultra iGPU) takes the whole pool
process with it. The probe compiles a (model x device request x compile config)
key whose blob is absent in a CHILD first, remembers the verdict, and refuses a
model whose child died by a signal — with an exception, not a crash.

Covers:
  - needs_probe — only GPU/NPU targets are probed; CPU-only never.
  - run_probe — a REAL child that SIGSEGVs is `crashed`, one that prints the
    marker is `ok`, a Python failure / a timeout is `inconclusive`.
  - ensure_openvino_loadable — a crash refuses now and on the next call without
    re-probing; a warm key (blob the probe wrote still present) skips the probe;
    a wiped blob re-probes; a changed model / compile config / env re-probes.
  - inference_pool._load_model (openvino branch) — a model the probe calls
    crashed never reaches `core.compile_model`; the reply carries
    reason `native-load-crashed`.

Pure-python: stubs numpy / PIL / postprocessors when absent.

Run: python3 -m unittest test_openvino_compile_probe -v
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import types
import unittest

try:
    import numpy  # noqa: F401
except ImportError:
    _np = types.ModuleType("numpy")
    _np.array = lambda seq, dtype=None: list(seq)  # noqa: E731
    _np.float32 = "float32"
    sys.modules["numpy"] = _np

try:
    import PIL.Image  # noqa: F401
except ImportError:
    _pil = types.ModuleType("PIL")
    _pil_image = types.ModuleType("PIL.Image")
    _pil.Image = _pil_image
    sys.modules["PIL"] = _pil
    sys.modules["PIL.Image"] = _pil_image

if "postprocessors" not in sys.modules:
    _pp = types.ModuleType("postprocessors")
    _pp.POSTPROCESSORS = {}
    sys.modules["postprocessors"] = _pp

import openvino_compile_probe as probe
import inference_pool as ip

GPU_CONFIG = {"device": "gpu", "inputSize": 320}


def _write(path: str, content: bytes = b"x") -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(content)


class _Runner:
    """A fake probe runner: answers a fixed verdict, optionally writes a blob."""

    def __init__(self, verdict: str, detail: str = "", blob: "str | None" = None, cache_dir: str = "") -> None:
        self.verdict = verdict
        self.detail = detail
        self.blob = blob
        self.cache_dir = cache_dir
        self.calls: "list[tuple[str, dict]]" = []

    def __call__(self, model_path: str, config: dict) -> "tuple[str, str]":
        self.calls.append((model_path, config))
        if self.blob:
            _write(os.path.join(self.cache_dir, self.blob))
        return self.verdict, self.detail


class NeedsProbeTest(unittest.TestCase):
    def test_gpu_and_npu_are_probed(self) -> None:
        self.assertTrue(probe.needs_probe(["GPU"]))
        self.assertTrue(probe.needs_probe(["NPU", "GPU", "CPU"]))
        self.assertTrue(probe.needs_probe(["GPU.0"]))

    def test_cpu_only_is_never_probed(self) -> None:
        self.assertFalse(probe.needs_probe(["CPU"]))
        self.assertFalse(probe.needs_probe([]))


class RunProbeRealChildTest(unittest.TestCase):
    """The child is a real interpreter: a native SIGSEGV is seen as a crash."""

    def test_child_that_segfaults_is_crashed(self) -> None:
        code = "import os, signal; os.kill(os.getpid(), signal.SIGSEGV)"
        verdict, detail = probe.run_probe("/nonexistent.xml", GPU_CONFIG, child_code=code)
        self.assertEqual(verdict, probe.VERDICT_CRASHED)
        self.assertIn("SIGSEGV", detail)

    def test_child_that_prints_marker_is_ok(self) -> None:
        code = f"print({probe.PROBE_MARKER!r}, flush=True)"
        verdict, _ = probe.run_probe("/nonexistent.xml", GPU_CONFIG, child_code=code)
        self.assertEqual(verdict, probe.VERDICT_OK)

    def test_child_that_raises_is_inconclusive(self) -> None:
        verdict, _ = probe.run_probe(
            "/nonexistent.xml", GPU_CONFIG, child_code="raise RuntimeError('bad ir')",
        )
        self.assertEqual(verdict, probe.VERDICT_INCONCLUSIVE)

    def test_child_past_its_bound_is_inconclusive(self) -> None:
        verdict, detail = probe.run_probe(
            "/nonexistent.xml", GPU_CONFIG, child_code="import time; time.sleep(30)",
            timeout_sec=0.5,
        )
        self.assertEqual(verdict, probe.VERDICT_INCONCLUSIVE)
        self.assertIn("timed out", detail)


class EnsureOpenvinoLoadableTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.model = os.path.join(self._tmp.name, "yolov9m-320-int8.xml")
        _write(self.model, b"<net/>")
        _write(os.path.join(self._tmp.name, "yolov9m-320-int8.bin"), b"w")
        self.cache = os.path.join(self._tmp.name, ".ov-cache")
        os.makedirs(self.cache)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def ensure(self, runner, config=None, candidates=("GPU",), env_tag="2025.4.1") -> None:
        probe.ensure_openvino_loadable(
            self.model, config or GPU_CONFIG, list(candidates), self.cache,
            env_tag=env_tag, run=runner,
        )

    def test_crash_refuses_with_a_typed_reason(self) -> None:
        runner = _Runner(probe.VERDICT_CRASHED, "probe child died by signal 11 (SIGSEGV)")
        with self.assertRaises(probe.OpenvinoLoadCrashed) as ctx:
            self.ensure(runner)
        self.assertEqual(ctx.exception.reason, "native-load-crashed")
        self.assertIn("yolov9m-320-int8", str(ctx.exception))

    def test_crash_is_remembered_and_not_reprobed(self) -> None:
        runner = _Runner(probe.VERDICT_CRASHED)
        for _ in range(2):
            with self.assertRaises(probe.OpenvinoLoadCrashed):
                self.ensure(runner)
        self.assertEqual(len(runner.calls), 1)

    def test_cpu_only_load_does_not_probe(self) -> None:
        runner = _Runner(probe.VERDICT_CRASHED)
        self.ensure(runner, config={"device": "cpu"}, candidates=("CPU",))
        self.assertEqual(runner.calls, [])

    def test_warm_key_skips_the_probe(self) -> None:
        runner = _Runner(probe.VERDICT_OK, blob="11aa.blob", cache_dir=self.cache)
        self.ensure(runner)
        self.ensure(runner)
        self.assertEqual(len(runner.calls), 1)

    def test_a_wiped_blob_is_probed_again(self) -> None:
        runner = _Runner(probe.VERDICT_OK, blob="11aa.blob", cache_dir=self.cache)
        self.ensure(runner)
        os.remove(os.path.join(self.cache, "11aa.blob"))
        self.ensure(runner)
        self.assertEqual(len(runner.calls), 2)

    def test_a_changed_model_is_reprobed(self) -> None:
        crashed = _Runner(probe.VERDICT_CRASHED)
        with self.assertRaises(probe.OpenvinoLoadCrashed):
            self.ensure(crashed)
        _write(self.model, b"<net>fixed</net>")
        ok = _Runner(probe.VERDICT_OK)
        self.ensure(ok)
        self.assertEqual(len(ok.calls), 1)

    def test_a_different_compile_config_is_reprobed(self) -> None:
        crashed = _Runner(probe.VERDICT_CRASHED)
        with self.assertRaises(probe.OpenvinoLoadCrashed):
            self.ensure(crashed)
        ok = _Runner(probe.VERDICT_OK)
        self.ensure(ok, config={**GPU_CONFIG, "gpuInferencePrecision": "f32"})
        self.assertEqual(len(ok.calls), 1)

    def test_a_threshold_is_not_part_of_the_key(self) -> None:
        crashed = _Runner(probe.VERDICT_CRASHED)
        with self.assertRaises(probe.OpenvinoLoadCrashed):
            self.ensure(crashed)
        with self.assertRaises(probe.OpenvinoLoadCrashed):
            self.ensure(crashed, config={**GPU_CONFIG, "confidence": 0.9})
        self.assertEqual(len(crashed.calls), 1)

    def test_a_different_runtime_build_is_reprobed(self) -> None:
        crashed = _Runner(probe.VERDICT_CRASHED)
        with self.assertRaises(probe.OpenvinoLoadCrashed):
            self.ensure(crashed, env_tag="2025.4.1")
        ok = _Runner(probe.VERDICT_OK)
        self.ensure(ok, env_tag="2026.0.0")
        self.assertEqual(len(ok.calls), 1)

    def test_inconclusive_neither_refuses_nor_is_remembered(self) -> None:
        runner = _Runner(probe.VERDICT_INCONCLUSIVE, "child exited 1")
        self.ensure(runner)
        self.ensure(runner)
        self.assertEqual(len(runner.calls), 2)

    def test_verdict_lives_in_the_ov_cache_dir(self) -> None:
        self.ensure(_Runner(probe.VERDICT_OK))
        path = probe.probe_verdict_path(self.model, GPU_CONFIG, self.cache)
        self.assertEqual(os.path.dirname(path), self.cache)
        with open(path, "r", encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["verdict"], probe.VERDICT_OK)


class _Clock:
    """A settable wall clock (seconds) handed to the probe as `now`."""

    def __init__(self, start: float = 1_000_000.0) -> None:
        self.t = start

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


class CrashNeedsASecondAgreeingReadTest(unittest.TestCase):
    """One SIGSEGV during an overloaded moment must not ban a model forever (D49).

    Measured 2026-10-23: a single probe crash on the hub GPU wrote `crashed`
    and every later load of the model was refused `native-load-crashed`.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.model = os.path.join(self._tmp.name, "yolov9m-320-fp16.xml")
        _write(self.model, b"<net/>")
        self.cache = os.path.join(self._tmp.name, ".ov-cache")
        os.makedirs(self.cache)
        self.clock = _Clock()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def ensure(self, runner) -> None:
        probe.ensure_openvino_loadable(
            self.model, GPU_CONFIG, ["GPU"], self.cache, env_tag="2025.4.1",
            run=runner, now=self.clock, loadavg=lambda: (13.9, 9.1, 6.2),
        )

    def stored(self) -> dict:
        path = probe.probe_verdict_path(self.model, GPU_CONFIG, self.cache)
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)

    def test_a_single_crash_is_retried_after_the_cool_off(self) -> None:
        crashed = _Runner(probe.VERDICT_CRASHED, "probe child died by signal 11 (SIGSEGV)")
        with self.assertRaises(probe.OpenvinoLoadCrashed):
            self.ensure(crashed)
        self.clock.advance(probe.CRASH_COOL_OFF_SEC + 1)
        ok = _Runner(probe.VERDICT_OK)
        self.ensure(ok)  # no raise: the second read disagreed
        self.assertEqual(len(ok.calls), 1)
        self.assertEqual(self.stored()["verdict"], probe.VERDICT_OK)

    def test_within_the_cool_off_a_single_crash_refuses_without_probing(self) -> None:
        crashed = _Runner(probe.VERDICT_CRASHED)
        with self.assertRaises(probe.OpenvinoLoadCrashed):
            self.ensure(crashed)
        self.clock.advance(probe.CRASH_COOL_OFF_SEC - 1)
        with self.assertRaises(probe.OpenvinoLoadCrashed) as ctx:
            self.ensure(crashed)
        self.assertEqual(len(crashed.calls), 1)
        self.assertIn("re-probed after", str(ctx.exception))

    def test_a_single_crash_is_stored_as_suspect_not_crashed(self) -> None:
        with self.assertRaises(probe.OpenvinoLoadCrashed):
            self.ensure(_Runner(probe.VERDICT_CRASHED, "signal 11"))
        stored = self.stored()
        self.assertEqual(stored["verdict"], probe.VERDICT_SUSPECT)
        self.assertEqual(len(stored["crashes"]), 1)
        crash = stored["crashes"][0]
        self.assertEqual(crash["at"], self.clock.t)
        self.assertEqual(crash["loadavg"], [13.9, 9.1, 6.2])
        self.assertEqual(crash["detail"], "signal 11")

    def test_two_crashes_a_cool_off_apart_are_cached(self) -> None:
        crashed = _Runner(probe.VERDICT_CRASHED)
        with self.assertRaises(probe.OpenvinoLoadCrashed):
            self.ensure(crashed)
        self.clock.advance(probe.CRASH_COOL_OFF_SEC + 1)
        with self.assertRaises(probe.OpenvinoLoadCrashed):
            self.ensure(crashed)
        stored = self.stored()
        self.assertEqual(stored["verdict"], probe.VERDICT_CRASHED)
        self.assertEqual(len(stored["crashes"]), 2)
        # Confirmed: refused for good, never probed again.
        self.clock.advance(10 * probe.CRASH_COOL_OFF_SEC)
        with self.assertRaises(probe.OpenvinoLoadCrashed):
            self.ensure(crashed)
        self.assertEqual(len(crashed.calls), 2)

    def test_a_success_in_between_resets_the_count(self) -> None:
        crashed = _Runner(probe.VERDICT_CRASHED)
        with self.assertRaises(probe.OpenvinoLoadCrashed):
            self.ensure(crashed)
        self.clock.advance(probe.CRASH_COOL_OFF_SEC + 1)
        self.ensure(_Runner(probe.VERDICT_OK, blob="22bb.blob", cache_dir=self.cache))
        os.remove(os.path.join(self.cache, "22bb.blob"))  # wiped: the next load re-probes
        self.clock.advance(probe.CRASH_COOL_OFF_SEC + 1)
        with self.assertRaises(probe.OpenvinoLoadCrashed):
            self.ensure(crashed)
        stored = self.stored()
        self.assertEqual(stored["verdict"], probe.VERDICT_SUSPECT)
        self.assertEqual(len(stored["crashes"]), 1)

    def test_a_legacy_single_crash_verdict_is_reprobed(self) -> None:
        # A v1 file (no crash list) is what the field wrote after ONE crash.
        key = probe.probe_key(self.model, GPU_CONFIG, ["GPU"], "2025.4.1")
        path = probe.probe_verdict_path(self.model, GPU_CONFIG, self.cache)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"key": key, "verdict": probe.VERDICT_CRASHED, "detail": "sig 11", "blobs": []}, fh)
        ok = _Runner(probe.VERDICT_OK)
        self.ensure(ok)
        self.assertEqual(len(ok.calls), 1)


class _FakeCore:
    """The slice of `openvino.Core` `_load_model` touches before it compiles."""

    available_devices = ["CPU", "GPU"]

    def __init__(self) -> None:
        self.compile_calls = 0

    def get_property(self, *_a, **_k):
        raise RuntimeError("no property")

    def read_model(self, *_a, **_k):
        raise AssertionError("the model must not be read: the probe refuses first")

    def compile_model(self, *_a, **_k):
        self.compile_calls += 1
        raise AssertionError("the native compiler must not be reached")


class LoadModelGateTest(unittest.TestCase):
    """`_load_model` asks the probe BEFORE the in-process compile."""

    def test_crashed_model_never_reaches_the_native_compiler(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            model = os.path.join(tmp, "yolov9m-320-int8.xml")
            _write(model, b"<net/>")
            core = _FakeCore()
            saved = (ip._runtime, ip._runtime_lib, probe.DEFAULT_RUNNER)
            try:
                ip._runtime = "openvino"
                ip._runtime_lib = core
                probe.DEFAULT_RUNNER = _Runner(probe.VERDICT_CRASHED, "child died by signal 11")
                with self.assertRaises(probe.OpenvinoLoadCrashed):
                    ip._load_model(ip.ModelSlot(), {"path": model, "device": "gpu"})
            finally:
                (ip._runtime, ip._runtime_lib, probe.DEFAULT_RUNNER) = saved
            self.assertEqual(core.compile_calls, 0)

    def test_the_child_itself_is_not_probed(self) -> None:
        # The child runs `_load_model` with the probe switched off in it; without
        # that switch it would fork a child of its own, forever.
        with tempfile.TemporaryDirectory() as tmp:
            model = os.path.join(tmp, "m.xml")
            _write(model, b"<net/>")
            runner = _Runner(probe.VERDICT_CRASHED)
            saved = (ip._runtime, ip._runtime_lib, probe.DEFAULT_RUNNER, ip._ov_probe_enabled)
            try:
                ip._runtime = "openvino"
                ip._runtime_lib = _FakeCore()
                ip._ov_probe_enabled = False
                probe.DEFAULT_RUNNER = runner
                with self.assertRaises(Exception) as ctx:
                    ip._load_model(ip.ModelSlot(), {"path": model, "device": "gpu"})
                self.assertNotIsInstance(ctx.exception, probe.OpenvinoLoadCrashed)
            finally:
                (ip._runtime, ip._runtime_lib, probe.DEFAULT_RUNNER, ip._ov_probe_enabled) = saved
            self.assertEqual(runner.calls, [])


class ModelCommandReasonTest(unittest.TestCase):
    def test_load_reply_carries_native_load_crashed(self) -> None:
        import asyncio

        def failing_load(_slot, config):
            raise probe.OpenvinoLoadCrashed(config["path"], "gpu", "child died by signal 11")

        async def run() -> dict:
            loader = ip.ModelLoader(timeout_sec=5.0, load_fn=failing_load)
            cmd = {"cmd": "load", "index": 0, "config": {"path": "/m/yolov9m-320-int8.xml"}}
            return await ip._handle_model_command([], cmd, loader)

        reply = asyncio.run(run())
        self.assertEqual(reply["status"], "error")
        self.assertEqual(reply["reason"], "native-load-crashed")
        self.assertEqual(reply["modelId"], "yolov9m-320-int8")


if __name__ == "__main__":
    unittest.main()
