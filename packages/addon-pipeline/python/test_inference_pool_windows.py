"""inference_pool.py must import and serve its seams on a machine with no
`fcntl` and no `resource` — which is what Windows is.

The first test is the gate: it removes both modules from the importer's world
(`sys.modules[name] = None` makes `import name` raise ImportError) and imports a
fresh copy of the pool. A top-level `import fcntl` fails it, exactly as it
failed the first Windows boot.

Run: python3 -m unittest test_inference_pool_windows -v
"""
from __future__ import annotations

import importlib
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

try:
    import numpy  # noqa: F401
except ImportError:
    _np = types.ModuleType("numpy")
    _np.float32 = float
    _np.array = lambda values, dtype=None: values  # noqa: E731
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

from test_pool_platform import FakeMsvcrt  # noqa: E402


def import_pool_without_posix_modules() -> types.ModuleType:
    sys.modules.pop("inference_pool", None)
    with mock.patch.dict(sys.modules, {"fcntl": None, "resource": None}):
        return importlib.import_module("inference_pool")


class WindowsImportTest(unittest.TestCase):
    def test_imports_with_no_fcntl_and_no_resource(self) -> None:
        pool = import_pool_without_posix_modules()
        self.assertTrue(callable(pool.compile_cache_lock))

    def test_compile_lock_uses_the_windows_range_lock(self) -> None:
        pool = import_pool_without_posix_modules()
        fake = FakeMsvcrt()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(
            sys.modules, {"msvcrt": fake}
        ), mock.patch.object(sys, "platform", "win32"):
            with pool.compile_cache_lock(os.path.join(tmp, "cache"), "model") as held:
                self.assertTrue(held)
        self.assertEqual([c[1:] for c in fake.calls], [(2, 1), (0, 1)])

    def test_compile_lock_gives_up_after_the_timeout_when_it_is_held(self) -> None:
        pool = import_pool_without_posix_modules()
        fake = FakeMsvcrt(busy=True)
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(
            sys.modules, {"msvcrt": fake}
        ), mock.patch.object(sys, "platform", "win32"):
            with pool.compile_cache_lock(tmp, "model", timeout_sec=0.1) as held:
                self.assertFalse(held)

    def test_memory_read_on_windows_comes_from_psapi_and_skips_proc(self) -> None:
        pool = import_pool_without_posix_modules()
        sample = {"rssKb": 1024, "maxRssKb": 2048}
        with mock.patch.object(sys, "platform", "win32"), mock.patch.object(
            pool.pool_platform, "read_windows_memory", return_value=sample
        ), mock.patch("builtins.open", side_effect=AssertionError("must not read /proc")):
            self.assertEqual(pool._read_self_memory(), sample)


if __name__ == "__main__":
    unittest.main()
