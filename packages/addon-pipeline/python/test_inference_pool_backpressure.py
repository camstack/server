"""Unit tests for the per-model in-flight bound (ModelBackpressure).

Pure-python: stubs numpy / PIL / postprocessors in sys.modules so the module
imports without the ML runtime installed (inference_pool uses
`from __future__ import annotations`, so annotations never touch the stubs).

Run: python3 -m unittest test_inference_pool_backpressure -v
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

from inference_pool import MAX_PENDING_PER_MODEL, ModelBackpressure


class ModelBackpressureTest(unittest.TestCase):
    def test_runs_immediately_below_max_running(self) -> None:
        bp = ModelBackpressure(max_running=2, max_pending=2)
        self.assertEqual(bp.admit(0, "a"), (["a"], []))
        self.assertEqual(bp.admit(0, "b"), (["b"], []))

    def test_queues_when_running_slots_full(self) -> None:
        bp = ModelBackpressure(max_running=1, max_pending=2)
        self.assertEqual(bp.admit(0, "a"), (["a"], []))
        # Running slot taken — next arrivals wait, nothing dropped yet.
        self.assertEqual(bp.admit(0, "b"), ([], []))
        self.assertEqual(bp.admit(0, "c"), ([], []))

    def test_drops_oldest_beyond_max_pending(self) -> None:
        bp = ModelBackpressure(max_running=1, max_pending=2)
        bp.admit(0, "running")
        bp.admit(0, "old")
        bp.admit(0, "mid")
        # Pending full (old, mid) — a new arrival sheds the OLDEST.
        to_run, to_drop = bp.admit(0, "new")
        self.assertEqual(to_run, [])
        self.assertEqual(to_drop, ["old"])
        # And again — "mid" is now the oldest.
        to_run, to_drop = bp.admit(0, "newer")
        self.assertEqual(to_drop, ["mid"])

    def test_complete_promotes_oldest_pending(self) -> None:
        bp = ModelBackpressure(max_running=1, max_pending=2)
        bp.admit(0, "a")
        bp.admit(0, "b")
        bp.admit(0, "c")
        # "a" finishes — "b" (oldest waiting) takes the freed slot.
        self.assertEqual(bp.complete(0), ["b"])
        self.assertEqual(bp.complete(0), ["c"])
        self.assertEqual(bp.complete(0), [])

    def test_slot_freed_by_complete_is_reusable(self) -> None:
        bp = ModelBackpressure(max_running=1, max_pending=1)
        bp.admit(0, "a")
        self.assertEqual(bp.complete(0), [])
        # Slot free again — the next arrival runs immediately.
        self.assertEqual(bp.admit(0, "b"), (["b"], []))

    def test_models_are_bounded_independently(self) -> None:
        bp = ModelBackpressure(max_running=1, max_pending=0)
        self.assertEqual(bp.admit(0, "m0-a"), (["m0-a"], []))
        # Model 0 saturated, but model 1 has its own slots.
        self.assertEqual(bp.admit(1, "m1-a"), (["m1-a"], []))
        # Model 0 overload does not shed model 1 frames.
        _, dropped = bp.admit(0, "m0-b")
        self.assertEqual(dropped, ["m0-b"])
        self.assertEqual(bp.complete(1), [])

    def test_zero_pending_rejects_overload_arrival_immediately(self) -> None:
        bp = ModelBackpressure(max_running=1, max_pending=0)
        bp.admit(0, "a")
        to_run, to_drop = bp.admit(0, "b")
        self.assertEqual(to_run, [])
        self.assertEqual(to_drop, ["b"])

    def test_running_count_never_goes_negative(self) -> None:
        bp = ModelBackpressure(max_running=1, max_pending=1)
        # Spurious complete on an idle model must not corrupt the state.
        self.assertEqual(bp.complete(0), [])
        self.assertEqual(bp.admit(0, "a"), (["a"], []))
        self.assertEqual(bp.admit(0, "b"), ([], []))

    def test_minimum_bounds_are_enforced(self) -> None:
        # max_running clamps to >= 1 so a model can always make progress.
        bp = ModelBackpressure(max_running=0, max_pending=-3)
        self.assertEqual(bp.admit(0, "a"), (["a"], []))
        # max_pending clamps to >= 0 — overload arrival sheds immediately.
        to_run, to_drop = bp.admit(0, "b")
        self.assertEqual(to_run, [])
        self.assertEqual(to_drop, ["b"])

    def test_default_pending_constant_is_small(self) -> None:
        # The whole point is that queue wait stays bounded to a couple of
        # frames — a large buffer would re-create the invisible latency.
        self.assertGreaterEqual(MAX_PENDING_PER_MODEL, 1)
        self.assertLessEqual(MAX_PENDING_PER_MODEL, 4)


if __name__ == "__main__":
    unittest.main()
