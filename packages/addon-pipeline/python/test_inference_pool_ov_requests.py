"""Unit tests for `_ov_request_count` — how many InferRequests a model holds.

The failure this guards: the sizing used to be `max(optimal, 4)`, a FLOOR of
four rather than the fallback the comment beside it described. Every loaded
model then held four GPU-resident InferRequests for ever, per pool, while an
Intel iGPU under PERFORMANCE_HINT=LATENCY was asking for one or two and the GPU
sat 92% idle. Creating a VAAPI device for an HEVC decode failed with ENOMEM
because of it.

Pure-python: stubs numpy / PIL / postprocessors so the module imports without
the ML runtime installed.

Run: python3 -m unittest test_inference_pool_ov_requests -v
"""
from __future__ import annotations

import sys
import types
import unittest

try:  # real numpy when the sandbox has it — a blind stub POISONS the whole
    import numpy  # noqa: F401  # pytest session for every sibling that needs it
except ImportError:
    _np = types.ModuleType("numpy")
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

from inference_pool import (  # noqa: E402
    OV_DEFAULT_CONCURRENCY,
    OV_MIN_CONCURRENCY,
    _ov_request_count,
)


class OvRequestCountTest(unittest.TestCase):
    def test_honours_what_the_device_asked_for(self):
        # The whole point: a device that says 2 gets 2, not 4.
        self.assertEqual(_ov_request_count(2), 2)
        self.assertEqual(_ov_request_count(5), 5)
        self.assertEqual(_ov_request_count(8), 8)

    def test_a_device_asking_for_one_still_gets_the_floor(self):
        # One request means a frame cannot be prepared while another infers.
        # Two is the floor; it is not four.
        self.assertEqual(_ov_request_count(1), OV_MIN_CONCURRENCY)
        self.assertEqual(OV_MIN_CONCURRENCY, 2)

    def test_UNKNOWN_is_not_small_and_keeps_the_old_default(self):
        # Models load lazily, so at dispatcher-sizing time the device has not
        # been asked at all. Absent is not zero (D393): that case keeps the
        # measured default rather than guessing low and starving the pool.
        self.assertEqual(_ov_request_count(0), OV_DEFAULT_CONCURRENCY)
        self.assertEqual(_ov_request_count(-1), OV_DEFAULT_CONCURRENCY)
        self.assertEqual(OV_DEFAULT_CONCURRENCY, 4)

    def test_is_never_a_floor_of_the_default(self):
        # The defect, stated as a test: the old expression was
        # `max(optimal, OV_DEFAULT_CONCURRENCY)`, so a device asking for 2 got
        # 4. If this ever goes back to a floor, this fails.
        self.assertLess(_ov_request_count(2), OV_DEFAULT_CONCURRENCY)


if __name__ == "__main__":
    unittest.main()
