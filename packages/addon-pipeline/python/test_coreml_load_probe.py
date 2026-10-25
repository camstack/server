"""Unit tests for the CoreML child-process load probe (coreml_load_probe).

A CoreML package that aborts the native loader (SIGABRT inside Core ML) takes
the whole pool process with it, and the host respawns the pool straight into
the same load. The probe loads the package in a CHILD first, remembers the
verdict per (package fingerprint, compute unit, OS build), and refuses a
package whose child died by a signal — with an exception, not a crash.

Covers:
  - classify_probe_exit — the exit -> verdict mapping (signal = crashed only).
  - run_probe — a REAL child that calls os.abort() is classified `crashed`,
    a child that prints the marker is `ok`.
  - ensure_coreml_loadable — verdict persistence: a crash refuses now and on
    the next call without re-probing; `ok` is not re-probed; a changed package
    is re-probed; an inconclusive probe is not remembered and does not refuse.
  - inference_pool._load_model (coreml branch) — a package the probe calls
    crashed never reaches `ct.models.MLModel`.

Pure-python: stubs numpy / PIL / postprocessors when absent, like the other
inference_pool tests.

Run: python3 -m unittest test_coreml_load_probe -v
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

import coreml_load_probe as probe
import inference_pool as ip


def _write(path: str, content: bytes = b"x") -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(content)


def _make_mlpackage(root: str, name: str = "camstack-yolo26n-320.mlpackage") -> str:
    pkg = os.path.join(root, name)
    _write(os.path.join(pkg, "Manifest.json"), b"{}")
    _write(os.path.join(pkg, "Data", "com.apple.CoreML", "model.mlmodel"), b"graph")
    return pkg


class _Runner:
    """A fake probe runner: answers a fixed verdict and counts its calls."""

    def __init__(self, verdict: str, detail: str = "") -> None:
        self.verdict = verdict
        self.detail = detail
        self.calls: list[tuple[str, str]] = []

    def __call__(self, model_path: str, device: str) -> "tuple[str, str]":
        self.calls.append((model_path, device))
        return self.verdict, self.detail


class ClassifyProbeExitTest(unittest.TestCase):
    def test_marker_and_zero_exit_is_ok(self) -> None:
        self.assertEqual(probe.classify_probe_exit(0, True), probe.VERDICT_OK)

    def test_death_by_signal_is_crashed(self) -> None:
        # subprocess reports a signal death as -signum (SIGABRT = 6).
        self.assertEqual(probe.classify_probe_exit(-6, False), probe.VERDICT_CRASHED)
        self.assertEqual(probe.classify_probe_exit(-11, False), probe.VERDICT_CRASHED)

    def test_python_exception_is_inconclusive(self) -> None:
        # A Python-level failure raises the same exception in-process: harmless,
        # so it is not a reason to refuse the package.
        self.assertEqual(probe.classify_probe_exit(1, False), probe.VERDICT_INCONCLUSIVE)

    def test_clean_exit_without_marker_is_inconclusive(self) -> None:
        self.assertEqual(probe.classify_probe_exit(0, False), probe.VERDICT_INCONCLUSIVE)


class RunProbeRealChildTest(unittest.TestCase):
    """The child is a real interpreter: a native abort is seen as a crash."""

    def test_child_that_aborts_is_crashed(self) -> None:
        verdict, detail = probe.run_probe(
            "/nonexistent.mlpackage", "all", child_code="import os; os.abort()",
        )
        self.assertEqual(verdict, probe.VERDICT_CRASHED)
        self.assertIn("signal", detail)

    def test_child_that_prints_marker_is_ok(self) -> None:
        code = f"print({probe.PROBE_MARKER!r}, flush=True)"
        verdict, _ = probe.run_probe("/nonexistent.mlpackage", "all", child_code=code)
        self.assertEqual(verdict, probe.VERDICT_OK)

    def test_child_that_raises_is_inconclusive(self) -> None:
        verdict, _ = probe.run_probe(
            "/nonexistent.mlpackage", "all", child_code="raise RuntimeError('bad spec')",
        )
        self.assertEqual(verdict, probe.VERDICT_INCONCLUSIVE)

    def test_child_past_its_bound_is_inconclusive(self) -> None:
        verdict, detail = probe.run_probe(
            "/nonexistent.mlpackage", "all", child_code="import time; time.sleep(30)",
            timeout_sec=0.5,
        )
        self.assertEqual(verdict, probe.VERDICT_INCONCLUSIVE)
        self.assertIn("timed out", detail)


class EnsureCoremlLoadableTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.pkg = _make_mlpackage(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_crash_refuses_with_a_typed_reason(self) -> None:
        runner = _Runner(probe.VERDICT_CRASHED, "child died by signal 6 (SIGABRT)")
        with self.assertRaises(probe.CoremlLoadCrashed) as ctx:
            probe.ensure_coreml_loadable(self.pkg, "all", run=runner)
        self.assertEqual(ctx.exception.reason, "native-load-crashed")
        self.assertIn("camstack-yolo26n-320", str(ctx.exception))

    def test_crash_is_remembered_and_not_reprobed(self) -> None:
        runner = _Runner(probe.VERDICT_CRASHED)
        with self.assertRaises(probe.CoremlLoadCrashed):
            probe.ensure_coreml_loadable(self.pkg, "all", run=runner)
        with self.assertRaises(probe.CoremlLoadCrashed):
            probe.ensure_coreml_loadable(self.pkg, "all", run=runner)
        self.assertEqual(len(runner.calls), 1)

    def test_ok_is_remembered_and_not_reprobed(self) -> None:
        runner = _Runner(probe.VERDICT_OK)
        probe.ensure_coreml_loadable(self.pkg, "all", run=runner)
        probe.ensure_coreml_loadable(self.pkg, "all", run=runner)
        self.assertEqual(len(runner.calls), 1)

    def test_a_load_that_rewrites_the_package_is_not_reprobed(self) -> None:
        # Core ML rewrites a file inside the .mlpackage when it loads it (seen
        # on macOS 26.2: the package's max mtime moves on every MLModel load),
        # so the verdict must be keyed on the package as the probe LEFT it.
        manifest = os.path.join(self.pkg, "Manifest.json")

        def touching_runner(model_path: str, device: str) -> "tuple[str, str]":
            touching_runner.calls += 1  # type: ignore[attr-defined]
            st = os.stat(manifest)
            os.utime(manifest, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))
            return probe.VERDICT_CRASHED, "child died by signal 6"

        touching_runner.calls = 0  # type: ignore[attr-defined]
        for _ in range(2):
            with self.assertRaises(probe.CoremlLoadCrashed):
                probe.ensure_coreml_loadable(self.pkg, "all", run=touching_runner)
        self.assertEqual(touching_runner.calls, 1)  # type: ignore[attr-defined]

    def test_verdict_is_per_compute_unit(self) -> None:
        runner = _Runner(probe.VERDICT_OK)
        probe.ensure_coreml_loadable(self.pkg, "all", run=runner)
        probe.ensure_coreml_loadable(self.pkg, "cpu", run=runner)
        self.assertEqual([d for _, d in runner.calls], ["all", "cpu"])

    def test_a_changed_package_is_reprobed(self) -> None:
        crashed = _Runner(probe.VERDICT_CRASHED)
        with self.assertRaises(probe.CoremlLoadCrashed):
            probe.ensure_coreml_loadable(self.pkg, "all", run=crashed)
        # A re-download replaces the package: different size -> different fingerprint.
        _write(os.path.join(self.pkg, "Data", "com.apple.CoreML", "model.mlmodel"), b"fixed graph")
        ok = _Runner(probe.VERDICT_OK)
        probe.ensure_coreml_loadable(self.pkg, "all", run=ok)
        self.assertEqual(len(ok.calls), 1)

    def test_a_different_os_build_is_reprobed(self) -> None:
        runner = _Runner(probe.VERDICT_CRASHED)
        with self.assertRaises(probe.CoremlLoadCrashed):
            probe.ensure_coreml_loadable(self.pkg, "all", run=runner, os_build="26.2")
        ok = _Runner(probe.VERDICT_OK)
        probe.ensure_coreml_loadable(self.pkg, "all", run=ok, os_build="26.3")
        self.assertEqual(len(ok.calls), 1)

    def test_inconclusive_neither_refuses_nor_is_remembered(self) -> None:
        runner = _Runner(probe.VERDICT_INCONCLUSIVE, "child exited 1")
        probe.ensure_coreml_loadable(self.pkg, "all", run=runner)
        probe.ensure_coreml_loadable(self.pkg, "all", run=runner)
        self.assertEqual(len(runner.calls), 2)

    def test_verdict_lives_in_the_coreml_cache_dir(self) -> None:
        probe.ensure_coreml_loadable(self.pkg, "ane", run=_Runner(probe.VERDICT_OK))
        verdict_path = probe.probe_verdict_path(self.pkg, "ane")
        self.assertEqual(
            os.path.dirname(verdict_path),
            os.path.join(self._tmp.name, ip.COREML_CACHE_DIR_NAME),
        )
        with open(verdict_path, "r", encoding="utf-8") as fh:
            self.assertEqual(json.load(fh)["verdict"], probe.VERDICT_OK)

    def test_an_unreadable_verdict_file_is_reprobed(self) -> None:
        _write(probe.probe_verdict_path(self.pkg, "all"), b"{not json")
        runner = _Runner(probe.VERDICT_OK)
        probe.ensure_coreml_loadable(self.pkg, "all", run=runner)
        self.assertEqual(len(runner.calls), 1)


class CoremlCrashNeedsASecondAgreeingReadTest(unittest.TestCase):
    """One native abort must not ban a package forever (D926, D49)."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.pkg = _make_mlpackage(self._tmp.name)
        self.t = 2_000_000.0

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def ensure(self, runner) -> None:
        probe.ensure_coreml_loadable(
            self.pkg, "all", run=runner, os_build="26.2",
            now=lambda: self.t, loadavg=lambda: (4.0, 3.0, 2.0),
        )

    def stored(self) -> dict:
        with open(probe.probe_verdict_path(self.pkg, "all"), "r", encoding="utf-8") as fh:
            return json.load(fh)

    def test_a_single_crash_is_retried_after_the_cool_off(self) -> None:
        with self.assertRaises(probe.CoremlLoadCrashed):
            self.ensure(_Runner(probe.VERDICT_CRASHED, "signal 6"))
        self.assertEqual(self.stored()["verdict"], probe.VERDICT_SUSPECT)
        self.t += probe.CRASH_COOL_OFF_SEC + 1
        ok = _Runner(probe.VERDICT_OK)
        self.ensure(ok)
        self.assertEqual(len(ok.calls), 1)
        self.assertEqual(self.stored()["verdict"], probe.VERDICT_OK)

    def test_within_the_cool_off_a_single_crash_refuses_without_probing(self) -> None:
        crashed = _Runner(probe.VERDICT_CRASHED)
        with self.assertRaises(probe.CoremlLoadCrashed):
            self.ensure(crashed)
        self.t += probe.CRASH_COOL_OFF_SEC - 1
        with self.assertRaises(probe.CoremlLoadCrashed):
            self.ensure(crashed)
        self.assertEqual(len(crashed.calls), 1)

    def test_two_crashes_a_cool_off_apart_are_cached(self) -> None:
        crashed = _Runner(probe.VERDICT_CRASHED)
        with self.assertRaises(probe.CoremlLoadCrashed):
            self.ensure(crashed)
        self.t += probe.CRASH_COOL_OFF_SEC + 1
        with self.assertRaises(probe.CoremlLoadCrashed):
            self.ensure(crashed)
        stored = self.stored()
        self.assertEqual(stored["verdict"], probe.VERDICT_CRASHED)
        self.assertEqual(len(stored["crashes"]), 2)
        self.assertEqual(stored["crashes"][0]["loadavg"], [4.0, 3.0, 2.0])
        self.t += 10 * probe.CRASH_COOL_OFF_SEC
        with self.assertRaises(probe.CoremlLoadCrashed):
            self.ensure(crashed)
        self.assertEqual(len(crashed.calls), 2)

    def test_a_success_in_between_resets_the_count(self) -> None:
        crashed = _Runner(probe.VERDICT_CRASHED)
        with self.assertRaises(probe.CoremlLoadCrashed):
            self.ensure(crashed)
        self.t += probe.CRASH_COOL_OFF_SEC + 1
        self.ensure(_Runner(probe.VERDICT_OK))
        # An ok is remembered for good; a changed OS build is what re-probes it.
        with open(probe.probe_verdict_path(self.pkg, "all"), "r", encoding="utf-8") as fh:
            record = json.load(fh)
        self.assertNotIn("crashes", record)

    def test_a_legacy_single_crash_verdict_is_reprobed(self) -> None:
        key = {
            "version": probe.PROBE_VERDICT_VERSION,
            "fingerprint": ip._coreml_model_fingerprint(self.pkg),
            "device": "all",
            "os": "26.2",
        }
        path = probe.probe_verdict_path(self.pkg, "all")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"key": key, "verdict": probe.VERDICT_CRASHED, "detail": "sig 6"}, fh)
        ok = _Runner(probe.VERDICT_OK)
        self.ensure(ok)
        self.assertEqual(len(ok.calls), 1)


class _FakeCt:
    """The slice of coremltools `_load_model` touches before the model loads."""

    class ComputeUnit:
        CPU_ONLY = "CPU_ONLY"
        CPU_AND_GPU = "CPU_AND_GPU"
        CPU_AND_NE = "CPU_AND_NE"
        ALL = "ALL"

    def __init__(self) -> None:
        self.mlmodel_calls = 0
        outer = self

        class _Models:
            @staticmethod
            def MLModel(*_a, **_k):  # noqa: N802 — coremltools' name
                outer.mlmodel_calls += 1
                raise AssertionError("the native loader must not be reached")

            @staticmethod
            def CompiledMLModel(*_a, **_k):  # noqa: N802
                outer.mlmodel_calls += 1
                raise AssertionError("the native loader must not be reached")

        self.models = _Models
        self.utils = types.SimpleNamespace(load_spec=lambda _p: None)


class LoadModelGateTest(unittest.TestCase):
    """`_load_model` asks the probe BEFORE the in-process native load."""

    def test_crashed_package_never_reaches_the_native_loader(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pkg = _make_mlpackage(tmp)
            fake_ct = _FakeCt()
            saved = (ip._runtime, ip._runtime_lib, probe.DEFAULT_RUNNER)
            try:
                ip._runtime = "coreml"
                ip._runtime_lib = fake_ct
                probe.DEFAULT_RUNNER = _Runner(probe.VERDICT_CRASHED, "child died by signal 6")
                with self.assertRaises(probe.CoremlLoadCrashed):
                    ip._load_model(ip.ModelSlot(), {"path": pkg, "device": "all"})
            finally:
                (ip._runtime, ip._runtime_lib, probe.DEFAULT_RUNNER) = saved
            self.assertEqual(fake_ct.mlmodel_calls, 0)


class ModelCommandReasonTest(unittest.TestCase):
    """A refused load answers the host with the machine-readable reason."""

    def test_load_reply_carries_native_load_crashed(self) -> None:
        import asyncio

        def failing_load(_slot, config):
            raise probe.CoremlLoadCrashed(config["path"], "all", "child died by signal 6")

        async def run() -> dict:
            loader = ip.ModelLoader(timeout_sec=5.0, load_fn=failing_load)
            cmd = {"cmd": "load", "index": 0, "config": {"path": "/m/camstack-yolo26n-320.mlpackage"}}
            return await ip._handle_model_command([], cmd, loader)

        reply = asyncio.run(run())
        self.assertEqual(reply["status"], "error")
        self.assertEqual(reply["reason"], "native-load-crashed")
        self.assertEqual(reply["modelId"], "camstack-yolo26n-320")


if __name__ == "__main__":
    unittest.main()
