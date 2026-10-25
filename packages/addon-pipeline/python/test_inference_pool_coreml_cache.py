"""Unit tests for the CoreML persistent compiled-model cache in inference_pool.

Covers:
  - _coreml_cache_paths — `.coreml-cache/<stem>.mlmodelc` + stamp resolution.
  - _coreml_model_fingerprint — file/.mlpackage-dir fingerprinting + JSON
    round-trip stability.
  - _coreml_stamp_matches — pure cache-validity decision.
  - _persist_coreml_compiled — atomic copy + stamp-written-LAST ordering.
  - _acquire_coreml_model — HIT/MISS/invalidation flow with a fake `ct`, and
    the HARD SAFETY guarantee: every cache failure falls back to the plain
    `ct.models.MLModel(path)` load (pre-cache behavior).

Pure-python: stubs numpy / PIL / postprocessors in sys.modules so the module
imports without the ML runtime installed (inference_pool uses
`from __future__ import annotations`, so annotations never touch the stubs).

Run: python3 -m unittest test_inference_pool_coreml_cache -v
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import types
import unittest

# ---------------------------------------------------------------------------
# Stub the heavy third-party imports BEFORE importing inference_pool.
# ---------------------------------------------------------------------------

try:  # real numpy when the sandbox has it — a blind stub POISONS the whole
    import numpy  # noqa: F401  # pytest session for every sibling that needs it
except ImportError:
    _np = types.ModuleType("numpy")
    # `inference_pool` builds `_IMAGENET_MEAN = np.array(...)` at import time.
    _np.array = lambda seq, dtype=None: list(seq)  # noqa: E731
    _np.float32 = "float32"
    sys.modules["numpy"] = _np

try:  # real PIL when present, for the same reason
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

from inference_pool import (
    COREML_CACHE_DIR_NAME,
    COREML_CACHE_STAMP_VERSION,
    _acquire_coreml_model,
    _coreml_cache_paths,
    _coreml_model_fingerprint,
    _coreml_stamp_matches,
    _persist_coreml_compiled,
)


def _write(path: str, content: bytes = b"x") -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(content)


def _make_mlpackage(root: str, name: str = "yolo.mlpackage") -> str:
    pkg = os.path.join(root, name)
    _write(os.path.join(pkg, "Manifest.json"), b"{}")
    _write(os.path.join(pkg, "Data", "com.apple.CoreML", "model.mlmodel"), b"weights")
    return pkg


class CoremlCachePathsTest(unittest.TestCase):
    def test_mlpackage_maps_to_dot_cache_sibling(self) -> None:
        cache, stamp = _coreml_cache_paths("/models/yolo.mlpackage")
        self.assertEqual(cache, os.path.join("/models", COREML_CACHE_DIR_NAME, "yolo.mlmodelc"))
        self.assertEqual(stamp, os.path.join("/models", COREML_CACHE_DIR_NAME, "yolo.stamp.json"))

    def test_plain_mlmodel_file_uses_stem(self) -> None:
        cache, stamp = _coreml_cache_paths("/m/face.mlmodel")
        self.assertEqual(cache, os.path.join("/m", COREML_CACHE_DIR_NAME, "face.mlmodelc"))
        self.assertEqual(stamp, os.path.join("/m", COREML_CACHE_DIR_NAME, "face.stamp.json"))

    def test_relative_path_is_absolutized(self) -> None:
        cache, _ = _coreml_cache_paths("yolo.mlpackage")
        self.assertTrue(os.path.isabs(cache))

    def test_different_models_get_distinct_entries(self) -> None:
        a, _ = _coreml_cache_paths("/models/yolo9.mlpackage")
        b, _ = _coreml_cache_paths("/models/yolo11.mlpackage")
        self.assertNotEqual(a, b)


class CoremlModelFingerprintTest(unittest.TestCase):
    def test_directory_fingerprint_counts_files_and_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pkg = _make_mlpackage(tmp)
            fp = _coreml_model_fingerprint(pkg)
            self.assertEqual(fp["kind"], "dir")
            self.assertEqual(fp["files"], 2)
            self.assertEqual(fp["size"], len(b"{}") + len(b"weights"))
            self.assertGreater(fp["mtimeNs"], 0)

    def test_plain_file_fingerprint(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "m.mlmodel")
            _write(path, b"abc")
            fp = _coreml_model_fingerprint(path)
            self.assertEqual(fp["kind"], "file")
            self.assertEqual(fp["files"], 1)
            self.assertEqual(fp["size"], 3)

    def test_content_change_changes_fingerprint(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pkg = _make_mlpackage(tmp)
            before = _coreml_model_fingerprint(pkg)
            _write(os.path.join(pkg, "Data", "com.apple.CoreML", "model.mlmodel"), b"NEW weights!")
            after = _coreml_model_fingerprint(pkg)
            self.assertNotEqual(before, after)

    def test_manifest_rewrite_with_same_bytes_keeps_fingerprint(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pkg = _make_mlpackage(tmp)
            before = _coreml_model_fingerprint(pkg)
            _touch_manifest(pkg)
            self.assertEqual(_coreml_model_fingerprint(pkg), before)

    def test_fingerprint_survives_json_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pkg = _make_mlpackage(tmp)
            fp = _coreml_model_fingerprint(pkg)
            self.assertEqual(json.loads(json.dumps(fp)), fp)

    def test_missing_path_raises(self) -> None:
        # The caller (_acquire_coreml_model) catches this and falls back.
        with self.assertRaises(OSError):
            _coreml_model_fingerprint("/nonexistent/model.mlpackage")


class CoremlStampMatchesTest(unittest.TestCase):
    FP = {"kind": "dir", "files": 2, "size": 9, "mtimeNs": 123}

    def _stamp(self) -> dict:
        return {"version": COREML_CACHE_STAMP_VERSION, "fingerprint": dict(self.FP)}

    def test_matching_stamp_validates(self) -> None:
        self.assertTrue(_coreml_stamp_matches(self._stamp(), dict(self.FP)))

    def test_none_or_non_dict_rejected(self) -> None:
        self.assertFalse(_coreml_stamp_matches(None, dict(self.FP)))
        self.assertFalse(_coreml_stamp_matches("stamp", dict(self.FP)))
        self.assertFalse(_coreml_stamp_matches([], dict(self.FP)))

    def test_wrong_version_rejected(self) -> None:
        stamp = self._stamp()
        stamp["version"] = COREML_CACHE_STAMP_VERSION + 1
        self.assertFalse(_coreml_stamp_matches(stamp, dict(self.FP)))

    def test_changed_fingerprint_rejected(self) -> None:
        changed = dict(self.FP)
        changed["mtimeNs"] = 999
        self.assertFalse(_coreml_stamp_matches(self._stamp(), changed))

    def test_missing_fingerprint_rejected(self) -> None:
        self.assertFalse(
            _coreml_stamp_matches({"version": COREML_CACHE_STAMP_VERSION}, dict(self.FP)),
        )


class PersistCoremlCompiledTest(unittest.TestCase):
    def _compiled_src(self, root: str) -> str:
        src = os.path.join(root, "tmp-compiled.mlmodelc")
        _write(os.path.join(src, "coremldata.bin"), b"compiled")
        _write(os.path.join(src, "model.espresso.net"), b"net")
        return src

    def test_persists_dir_and_stamp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            src = self._compiled_src(tmp)
            cache = os.path.join(tmp, COREML_CACHE_DIR_NAME, "yolo.mlmodelc")
            stamp = os.path.join(tmp, COREML_CACHE_DIR_NAME, "yolo.stamp.json")
            fp = {"kind": "dir", "files": 1, "size": 1, "mtimeNs": 1}
            _persist_coreml_compiled(src, cache, stamp, fp)
            self.assertTrue(os.path.isfile(os.path.join(cache, "coremldata.bin")))
            self.assertTrue(os.path.isfile(os.path.join(cache, "model.espresso.net")))
            with open(stamp, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            self.assertTrue(_coreml_stamp_matches(data, fp))
            # No tmp leftovers.
            leftovers = [n for n in os.listdir(os.path.dirname(cache)) if ".tmp-" in n]
            self.assertEqual(leftovers, [])

    def test_overwrites_stale_cache(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            src = self._compiled_src(tmp)
            cache = os.path.join(tmp, COREML_CACHE_DIR_NAME, "yolo.mlmodelc")
            stamp = os.path.join(tmp, COREML_CACHE_DIR_NAME, "yolo.stamp.json")
            _write(os.path.join(cache, "old.bin"), b"stale")
            _write(stamp, b"{}")
            fp = {"kind": "dir", "files": 1, "size": 1, "mtimeNs": 2}
            _persist_coreml_compiled(src, cache, stamp, fp)
            self.assertFalse(os.path.exists(os.path.join(cache, "old.bin")))
            self.assertTrue(os.path.isfile(os.path.join(cache, "coremldata.bin")))

    def test_missing_source_raises_and_leaves_no_stamp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cache = os.path.join(tmp, COREML_CACHE_DIR_NAME, "yolo.mlmodelc")
            stamp = os.path.join(tmp, COREML_CACHE_DIR_NAME, "yolo.stamp.json")
            with self.assertRaises(OSError):
                _persist_coreml_compiled(
                    os.path.join(tmp, "missing"), cache, stamp,
                    {"kind": "dir", "files": 0, "size": 0, "mtimeNs": 0},
                )
            # Stamp is written LAST — a failed copy must never leave one.
            self.assertFalse(os.path.exists(stamp))


# ---------------------------------------------------------------------------
# Fake coremltools for _acquire_coreml_model flow tests
# ---------------------------------------------------------------------------


class _FakeSpec:
    """Sentinel spec object; identity is asserted in the tests."""


class _FakeMLModel:
    def __init__(self, compiled_dir: str) -> None:
        self._compiled_dir = compiled_dir
        self._spec = _FakeSpec()

    def get_spec(self) -> _FakeSpec:
        return self._spec

    def get_compiled_model_path(self) -> str:
        return self._compiled_dir


class _FakeCompiledMLModel:
    def __init__(self, path: str, compute_units: object) -> None:
        self.path = path
        self.compute_units = compute_units


def _touch_manifest(pkg: str) -> None:
    """What coremltools does on EVERY open of an .mlpackage (MLModel AND
    utils.load_spec, measured with coremltools 8.3 on macOS 26.2): it rewrites
    Manifest.json with the same bytes, so only its mtime moves."""
    manifest = os.path.join(pkg, "Manifest.json")
    st = os.stat(manifest)
    os.utime(manifest, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))


class _FakeCt:
    """Minimal stand-in for the coremltools module surface the helper uses."""

    def __init__(
        self, tmp: str, fail_compiled: bool = False, fail_load_spec: bool = False,
        touch_manifest: bool = False,
    ) -> None:
        self.tmp = tmp
        self.mlmodel_calls: list[tuple[str, object]] = []
        self.compiled_calls: list[tuple[str, object]] = []
        self.load_spec_calls: list[str] = []
        self.loaded_spec = _FakeSpec()

        fake = self

        class _MLModel:
            def __new__(cls, path: str, compute_units: object = None) -> _FakeMLModel:
                fake.mlmodel_calls.append((path, compute_units))
                if touch_manifest:
                    _touch_manifest(path)
                compiled = os.path.join(fake.tmp, f"compiled-{len(fake.mlmodel_calls)}.mlmodelc")
                _write(os.path.join(compiled, "coremldata.bin"), b"compiled")
                return _FakeMLModel(compiled)

        class _CompiledMLModel:
            def __new__(cls, path: str, compute_units: object = None) -> _FakeCompiledMLModel:
                fake.compiled_calls.append((path, compute_units))
                if fail_compiled:
                    raise RuntimeError("CompiledMLModel load failed")
                return _FakeCompiledMLModel(path, compute_units)

        def _load_spec(path: str) -> _FakeSpec:
            fake.load_spec_calls.append(path)
            if touch_manifest:
                _touch_manifest(path)
            if fail_load_spec:
                raise RuntimeError("load_spec failed")
            return fake.loaded_spec

        self.models = types.SimpleNamespace(MLModel=_MLModel, CompiledMLModel=_CompiledMLModel)
        self.utils = types.SimpleNamespace(load_spec=_load_spec)


class AcquireCoremlModelTest(unittest.TestCase):
    CU = object()

    def test_first_load_is_miss_that_compiles_and_persists(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pkg = _make_mlpackage(tmp)
            ct = _FakeCt(tmp)
            model, spec = _acquire_coreml_model(ct, pkg, self.CU)
            # MISS: plain MLModel compile, spec from model.get_spec().
            self.assertIsInstance(model, _FakeMLModel)
            self.assertIs(spec, model.get_spec())
            self.assertEqual(ct.mlmodel_calls, [(pkg, self.CU)])
            self.assertEqual(ct.compiled_calls, [])
            # Persisted for the next spawn.
            cache, stamp = _coreml_cache_paths(pkg)
            self.assertTrue(os.path.isfile(os.path.join(cache, "coremldata.bin")))
            self.assertTrue(os.path.isfile(stamp))

    def test_second_load_is_hit_with_no_recompile(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pkg = _make_mlpackage(tmp)
            _acquire_coreml_model(_FakeCt(tmp), pkg, self.CU)  # seed the cache
            ct = _FakeCt(tmp)
            model, spec = _acquire_coreml_model(ct, pkg, self.CU)
            # HIT: CompiledMLModel over the cache path; spec via load_spec
            # from the SOURCE .mlpackage; NO MLModel compile.
            cache, _ = _coreml_cache_paths(pkg)
            self.assertIsInstance(model, _FakeCompiledMLModel)
            self.assertEqual(model.path, cache)
            self.assertIs(model.compute_units, self.CU)
            self.assertIs(spec, ct.loaded_spec)
            self.assertEqual(ct.load_spec_calls, [pkg])
            self.assertEqual(ct.mlmodel_calls, [])

    def test_a_hit_does_not_invalidate_the_next_hit(self) -> None:
        # The HIT path reads the spec with `ct.utils.load_spec`, which rewrites
        # the package's Manifest.json. Keyed on that mtime, every HIT
        # invalidated the cache for the NEXT spawn: HIT, MISS, HIT, MISS.
        with tempfile.TemporaryDirectory() as tmp:
            pkg = _make_mlpackage(tmp)
            _acquire_coreml_model(_FakeCt(tmp, touch_manifest=True), pkg, self.CU)  # MISS
            for _ in range(3):
                ct = _FakeCt(tmp, touch_manifest=True)
                model, _ = _acquire_coreml_model(ct, pkg, self.CU)
                self.assertIsInstance(model, _FakeCompiledMLModel)
                self.assertEqual(ct.mlmodel_calls, [])

    def test_changed_model_invalidates_cache_and_recompiles(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pkg = _make_mlpackage(tmp)
            _acquire_coreml_model(_FakeCt(tmp), pkg, self.CU)  # seed
            _write(
                os.path.join(pkg, "Data", "com.apple.CoreML", "model.mlmodel"),
                b"retrained weights (longer)",
            )
            ct = _FakeCt(tmp)
            model, spec = _acquire_coreml_model(ct, pkg, self.CU)
            self.assertIsInstance(model, _FakeMLModel)
            self.assertIs(spec, model.get_spec())
            self.assertEqual(ct.compiled_calls, [])
            self.assertEqual(len(ct.mlmodel_calls), 1)
            # Cache rewritten: a third spawn hits again.
            ct3 = _FakeCt(tmp)
            model3, _ = _acquire_coreml_model(ct3, pkg, self.CU)
            self.assertIsInstance(model3, _FakeCompiledMLModel)

    def test_compiled_load_failure_falls_back_to_plain_mlmodel(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pkg = _make_mlpackage(tmp)
            _acquire_coreml_model(_FakeCt(tmp), pkg, self.CU)  # seed
            ct = _FakeCt(tmp, fail_compiled=True)
            model, spec = _acquire_coreml_model(ct, pkg, self.CU)
            # HARD SAFETY: CompiledMLModel raising → plain MLModel path.
            self.assertIsInstance(model, _FakeMLModel)
            self.assertIs(spec, model.get_spec())
            self.assertEqual(ct.mlmodel_calls, [(pkg, self.CU)])

    def test_load_spec_failure_falls_back_to_plain_mlmodel(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pkg = _make_mlpackage(tmp)
            _acquire_coreml_model(_FakeCt(tmp), pkg, self.CU)  # seed
            ct = _FakeCt(tmp, fail_load_spec=True)
            model, spec = _acquire_coreml_model(ct, pkg, self.CU)
            self.assertIsInstance(model, _FakeMLModel)
            self.assertIs(spec, model.get_spec())

    def test_corrupt_stamp_json_falls_back_to_plain_mlmodel(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pkg = _make_mlpackage(tmp)
            _acquire_coreml_model(_FakeCt(tmp), pkg, self.CU)  # seed
            _, stamp = _coreml_cache_paths(pkg)
            _write(stamp, b"not json {{{")
            ct = _FakeCt(tmp)
            model, _ = _acquire_coreml_model(ct, pkg, self.CU)
            self.assertIsInstance(model, _FakeMLModel)
            self.assertEqual(ct.compiled_calls, [])

    def test_stamp_without_cache_dir_falls_back(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pkg = _make_mlpackage(tmp)
            _acquire_coreml_model(_FakeCt(tmp), pkg, self.CU)  # seed
            cache, _ = _coreml_cache_paths(pkg)
            import shutil as _shutil
            _shutil.rmtree(cache)
            ct = _FakeCt(tmp)
            model, _ = _acquire_coreml_model(ct, pkg, self.CU)
            self.assertIsInstance(model, _FakeMLModel)
            self.assertEqual(ct.compiled_calls, [])

    def test_persist_failure_still_returns_compiled_model(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            pkg = _make_mlpackage(tmp)
            ct = _FakeCt(tmp)

            def _boom() -> str:
                raise RuntimeError("no compiled path")

            # Force get_compiled_model_path to fail AFTER the compile — the
            # already-loaded model must still be returned (cache is best
            # effort only).
            orig_new = ct.models.MLModel.__new__

            class _MLModelNoCompiledPath:
                def __new__(cls, path: str, compute_units: object = None) -> _FakeMLModel:
                    m = orig_new(ct.models.MLModel, path, compute_units)
                    m.get_compiled_model_path = _boom
                    return m

            ct.models = types.SimpleNamespace(
                MLModel=_MLModelNoCompiledPath, CompiledMLModel=ct.models.CompiledMLModel,
            )
            model, spec = _acquire_coreml_model(ct, pkg, self.CU)
            self.assertIsInstance(model, _FakeMLModel)
            self.assertIs(spec, model.get_spec())
            _, stamp = _coreml_cache_paths(pkg)
            self.assertFalse(os.path.exists(stamp))

    def test_missing_model_path_raises_like_pre_cache_behavior(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            missing = os.path.join(tmp, "gone.mlpackage")

            class _RaisingMLModel:
                def __new__(cls, path: str, compute_units: object = None) -> object:
                    raise FileNotFoundError(path)

            ct = _FakeCt(tmp)
            ct.models = types.SimpleNamespace(
                MLModel=_RaisingMLModel, CompiledMLModel=ct.models.CompiledMLModel,
            )
            # Pre-cache, MLModel(path) raised for a missing model and the
            # load/replace command handlers reported it — the cache layer
            # must surface the SAME failure, not swallow it.
            with self.assertRaises(FileNotFoundError):
                _acquire_coreml_model(ct, missing, self.CU)


if __name__ == "__main__":
    unittest.main()
