"""The compile-cache lock: one worker compiles, the others wait and HIT.

Measured on the operator's Mac on 2026-09-19, over three hours: **59 cache
HITs, 55 MISSes and 5 persist failures**. Half the loads were recompiling a
model that was already on disk, and the failures all named a path INSIDE the
cache bundle:

    CoreML: could not persist compiled-model cache
    ([Errno 2] No such file or directory: '.../camstack-yolov9m-320.mlmodelc/weights')

Both come from the same place. A pool is several python PROCESSES; they start
together, all miss the cache because nobody has written it yet, all compile,
and then all try to replace the same directory. `_persist_coreml_compiled`
removes the old cache and renames its temp copy into place, so one worker
walks a directory that another is swapping under it — and `rmtree` fails on a
child that has just ceased to exist. `weights` is a subdirectory of the
`.mlmodelc` bundle.

So the lock is not belt-and-braces: it is what stops N workers paying N
compiles for one model, and the only thing that makes "replace the cache" a
single-writer operation.

Run: python3 -m unittest test_inference_pool_cache_lock -v
"""
from __future__ import annotations

import multiprocessing
import os
import shutil
import sys
import tempfile
import time
import types
import unittest

# Stub the heavy third-party imports BEFORE importing inference_pool — the
# same shape as `test_inference_pool_coreml_cache.py`: the REAL module when the
# sandbox has it, because a blind stub poisons every sibling test in the
# session.
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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import inference_pool  # noqa: E402


def _hold_lock(root: str, stem: str, hold_sec: float, started, done) -> None:
    """Child process: take the lock, signal, hold it, release."""
    with inference_pool.compile_cache_lock(root, stem):
        started.set()
        time.sleep(hold_sec)
    done.set()


class TestCompileCacheLock(unittest.TestCase):
    def test_lock_is_exclusive_across_processes(self) -> None:
        # The pool is processes, not threads: a lock that only worked in-process
        # would leave the very race it exists to remove.
        with tempfile.TemporaryDirectory() as root:
            ctx = multiprocessing.get_context("spawn")
            started = ctx.Event()
            done = ctx.Event()
            child = ctx.Process(target=_hold_lock, args=(root, "model", 1.0, started, done))
            child.start()
            try:
                self.assertTrue(started.wait(10), "child never took the lock")
                began = time.monotonic()
                with inference_pool.compile_cache_lock(root, "model"):
                    waited = time.monotonic() - began
                # It had to WAIT for the holder rather than proceeding beside it.
                self.assertGreater(waited, 0.5)
            finally:
                child.join(15)

    def test_two_models_do_not_block_each_other(self) -> None:
        # The lock is per model: compiling the detector must not serialise
        # behind the embedder, which is a different file entirely.
        with tempfile.TemporaryDirectory() as root:
            with inference_pool.compile_cache_lock(root, "detector"):
                began = time.monotonic()
                with inference_pool.compile_cache_lock(root, "embedder"):
                    pass
                self.assertLess(time.monotonic() - began, 0.5)

    def test_it_gives_up_rather_than_hanging_the_pool(self) -> None:
        # A holder that died mid-compile must not take the pool with it: the
        # wait is bounded and a timeout COMPILES, which is the pre-lock
        # behaviour — slower, never stuck.
        with tempfile.TemporaryDirectory() as root:
            ctx = multiprocessing.get_context("spawn")
            started = ctx.Event()
            done = ctx.Event()
            child = ctx.Process(target=_hold_lock, args=(root, "model", 3.0, started, done))
            child.start()
            try:
                self.assertTrue(started.wait(10), "child never took the lock")
                began = time.monotonic()
                with inference_pool.compile_cache_lock(root, "model", timeout_sec=0.3) as held:
                    waited = time.monotonic() - began
                self.assertFalse(held, "it should report that it did NOT get the lock")
                self.assertLess(waited, 2.0)
            finally:
                child.join(15)

    def test_an_unusable_lock_directory_does_not_stop_a_compile(self) -> None:
        # The cache is an optimisation. If the lock cannot even be created the
        # model still has to load — a cache failure that refused to serve a
        # camera would be worse than every miss it prevents.
        with inference_pool.compile_cache_lock("/proc/nonexistent-cache-root", "model") as held:
            self.assertFalse(held)


if __name__ == "__main__":
    unittest.main()


class TestPersistToleratesAConcurrentSwap(unittest.TestCase):
    """The persist step is the OTHER half of the same race.

    Measured on the Mac, 2026-09-19: five `could not persist compiled-model
    cache ([Errno 2] ... /yolov9m-320.mlmodelc/weights)` in three hours. The
    path is INSIDE the old cache bundle, which is `shutil.rmtree` walking a
    directory another worker is swapping out from under it. The lock makes
    that rare; it must also be harmless, because a worker that dies between
    taking the lock and replacing the cache leaves exactly this state behind.
    """

    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="cs-persist-race-")
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_a_vanishing_previous_cache_does_not_fail_the_persist(self) -> None:
        compiled_src = os.path.join(self.root, "fresh.mlmodelc")
        os.makedirs(compiled_src)
        with open(os.path.join(compiled_src, "weights"), "w", encoding="utf-8") as fh:
            fh.write("new")

        cache_path = os.path.join(self.root, "cache", "model.mlmodelc")
        stamp_path = os.path.join(self.root, "cache", "model.stamp.json")
        os.makedirs(cache_path)
        with open(os.path.join(cache_path, "weights"), "w", encoding="utf-8") as fh:
            fh.write("old")

        real_rmtree = shutil.rmtree
        vanished: list[str] = []

        def rmtree_after_someone_else_won(path, *args, **kwargs):
            # Another worker replaced the cache between our exists() and our
            # rmtree — the directory we are about to walk is already gone.
            if path == cache_path and not vanished:
                vanished.append(path)
                real_rmtree(path)
            return real_rmtree(path, *args, **kwargs)

        inference_pool.shutil.rmtree = rmtree_after_someone_else_won
        try:
            inference_pool._persist_coreml_compiled(
                compiled_src, cache_path, stamp_path, {"kind": "file"}
            )
        finally:
            inference_pool.shutil.rmtree = real_rmtree

        self.assertTrue(vanished, "the test did not exercise the race it describes")
        with open(os.path.join(cache_path, "weights"), encoding="utf-8") as fh:
            self.assertEqual(fh.read(), "new")
        self.assertTrue(os.path.isfile(stamp_path))
