"""Unit tests for the mem_stats diagnostics (PoolCounters, backpressure
snapshot, _read_self_memory, _mem_stats_payload).

Pure-python: stubs numpy / PIL / postprocessors in sys.modules so the module
imports without the ML runtime installed (same harness as
test_inference_pool_backpressure.py).

Run: python3 -m unittest test_inference_pool_memstats -v
"""
from __future__ import annotations

import sys
import types
import unittest

# ---------------------------------------------------------------------------
# Stub the heavy third-party imports BEFORE importing inference_pool.
# ---------------------------------------------------------------------------

try:  # real numpy when the sandbox has it — a blind stub POISONS the whole
    import numpy  # noqa: F401  # pytest session for every sibling that needs it
except ImportError:
    # The stub must satisfy inference_pool's MODULE-LEVEL numpy usage
    # (_IMAGENET_MEAN/_IMAGENET_STD = np.array([...], dtype=np.float32));
    # a bare ModuleType broke this harness when those constants were added.
    _np = types.ModuleType("numpy")
    _np.float32 = float
    _np.array = lambda values, dtype=None: values
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
    ModelBackpressure,
    PoolCounters,
    _malloc_arena_count,
    _mem_stats_payload,
    _read_self_memory,
)


class PoolCountersTest(unittest.TestCase):
    def test_as_dict_shape_and_total(self) -> None:
        c = PoolCounters()
        c.infer_jpeg = 3
        c.infer_raw = 5
        c.infer_batch = 1
        c.infer_cached = 2
        c.commands = 7
        c.frames_cached = 4
        d = c.as_dict()
        self.assertEqual(d["inferJpeg"], 3)
        self.assertEqual(d["inferRaw"], 5)
        self.assertEqual(d["inferBatch"], 1)
        self.assertEqual(d["inferCached"], 2)
        self.assertEqual(d["commands"], 7)
        self.assertEqual(d["framesCached"], 4)
        self.assertEqual(d["totalInference"], 11)


class BackpressureSnapshotTest(unittest.TestCase):
    def test_snapshot_reports_running_and_pending(self) -> None:
        bp = ModelBackpressure(max_running=1, max_pending=4)
        bp.admit(0, "a")  # runs
        bp.admit(0, "b")  # queued
        bp.admit(0, "c")  # queued
        bp.admit(2, "d")  # runs on another model
        snap = bp.snapshot()
        self.assertEqual(snap["0"], {"running": 1, "pending": 2})
        self.assertEqual(snap["2"], {"running": 1, "pending": 0})

    def test_snapshot_does_not_mutate(self) -> None:
        bp = ModelBackpressure(max_running=1, max_pending=4)
        bp.admit(0, "a")
        before = bp.snapshot()
        after = bp.snapshot()
        self.assertEqual(before, after)


class ReadSelfMemoryTest(unittest.TestCase):
    def test_reports_max_rss_on_posix(self) -> None:
        mem = _read_self_memory()
        # getrusage exists on every platform this pool supports.
        self.assertIn("maxRssKb", mem)
        self.assertIsInstance(mem["maxRssKb"], int)
        self.assertGreater(mem["maxRssKb"], 0)
        if sys.platform.startswith("linux"):
            # /proc fields must be present on the fleet's OS.
            self.assertIn("rssKb", mem)
            self.assertIn("vmKb", mem)
            self.assertIn("threads", mem)


class MallocArenaCountTest(unittest.TestCase):
    def test_never_raises_and_type_is_optional_int(self) -> None:
        count = _malloc_arena_count()
        if sys.platform.startswith("linux"):
            # glibc containers must produce a real count (>= 1 main arena);
            # musl returns None via the exception guard.
            self.assertTrue(count is None or count >= 1)
        else:
            self.assertIsNone(count)


class MemStatsPayloadTest(unittest.TestCase):
    def test_payload_shape(self) -> None:
        class SlotStub:
            def __init__(self, loaded: bool) -> None:
                self.loaded = loaded

        counters = PoolCounters()
        counters.infer_raw = 9
        bp = ModelBackpressure(max_running=1, max_pending=4)
        bp.admit(0, "a")
        payload = _mem_stats_payload(
            [SlotStub(True), SlotStub(False), SlotStub(True)],
            counters,
            bp,
            frame_cache_len=2,
            preprocess_cache_len=3,
            bench_cache_len=1,
            uptime_sec=120,
        )
        self.assertEqual(payload["cmd"], "mem_stats")
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(payload["modelsLoaded"], 2)
        self.assertEqual(payload["frameCacheEntries"], 2)
        self.assertEqual(payload["preprocessCacheEntries"], 3)
        self.assertEqual(payload["benchPreprocessCacheEntries"], 1)
        self.assertEqual(payload["uptimeSec"], 120)
        self.assertEqual(payload["counters"]["inferRaw"], 9)
        self.assertEqual(payload["backpressure"]["0"], {"running": 1, "pending": 0})
        self.assertIsInstance(payload["memory"], dict)
        self.assertEqual(len(payload["gcCounts"]), 3)


if __name__ == "__main__":
    unittest.main()
