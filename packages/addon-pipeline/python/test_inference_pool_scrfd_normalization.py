"""Pins the SCRFD input-normalization contract (`inputNormalization: 'scrfd'`).

The production defect (2026-09-26 model-replacement spike,
docs/superpowers/specs/2026-09-26-replacement-models-spike.md §2.4-2): the
pool fed SCRFD the historical plain `/255` ([0,1]) tensor, but upstream
InsightFace expects `(pixel - 127.5) / 128` ([-0.996, 0.996]). The re-hosted
ONNX/OpenVINO/CoreML artifacts are unmodified upstream graphs (first op is a
Conv — nothing absorbs the shift), so this has to be threaded through the
runtime preprocessor rather than baked into the graph (contrast with
AuraFace/CLIP, whose graphs bake their own normalization).

This one contract, `_apply_normalization`, is the SAME function the ONNX path
and the CoreML `multiArrayType` path both call — verified 2026-09-26 that the
hosted `camstack-scrfd-2.5g.mlpackage`'s input is `multiArrayType`, not
`imageType`, so it goes through this same function. The OpenVINO PPP fast
path (`_build_ov_ppp_model`) folds the identical scale/mean/scale sequence
into the compiled graph instead (covered separately, without needing a real
OpenVINO install, by `test_inference_pool_ov_ppp_scrfd.py`), and is mutually
exclusive with `_apply_normalization` (`_preprocess` returns early on the PPP
fast path, `inference_pool.py` ~1828) — so there is no double application on
any backend.

`unittest.TestCase`, not pytest-style: `scripts/test-python-pool.sh` runs the
`unittest.TestCase` modules on the bare interpreter (no pytest) — the path CI
actually exercises. Heavy deps (numpy/PIL/postprocessors) are stubbed on
`ImportError`, the same pattern as `test_inference_pool_ov_ppp.py`, so the
module always imports; the tests that need real ndarray arithmetic are
skipped (not silently passed) without real numpy, while the ones that don't
(the constants pin, and `_ov_ppp_plan`'s pure config threading) always run.

Run: python3 -m unittest test_inference_pool_scrfd_normalization -v
"""
import sys
import types
import unittest

try:  # real numpy when the sandbox has it — a blind stub POISONS the whole
    import numpy as _numpy_probe  # noqa: F401  # session for every sibling that needs it
except ImportError:
    _numpy_probe = None

# `import numpy` can SUCCEED against a MINIMAL STUB another test module in
# this same `python3 -m unittest` process already installed into
# `sys.modules['numpy']` (`test_inference_pool_ov_ppp.py` and siblings do the
# same guard) — a bare "did the import raise" check would then wrongly treat
# that stub as real numpy and crash on the first `arr.ndim` access. `ndarray`
# is real-numpy-only (no stub in this file tree defines it), so check for it
# instead of trusting import success alone.
_HAS_REAL_NUMPY = _numpy_probe is not None and hasattr(_numpy_probe, "ndarray")
if _numpy_probe is None:
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

import inference_pool  # noqa: E402
from inference_pool import (  # noqa: E402
    _SCRFD_MEAN,
    _SCRFD_STD,
    _apply_normalization,
    _ov_ppp_plan,
)


class ScrfdNormalizationConstantsTest(unittest.TestCase):
    """Plain floats, no ndarray ops — always runs, with or without numpy."""

    def test_constants_match_upstream_formula(self):
        # _SCRFD_MEAN/_SCRFD_STD are the pool's own pre-divided-by-255
        # constants; cross-check them against the raw-pixel upstream formula
        # `(pixel - 127.5) / 128` directly, so a future edit to either
        # constant is caught here rather than only in the end-to-end face
        # count.
        self.assertAlmostEqual(_SCRFD_MEAN, 127.5 / 255.0)
        self.assertAlmostEqual(_SCRFD_STD, 128.0 / 255.0)


class OvPppPlanThreadsScrfdTest(unittest.TestCase):
    """`_ov_ppp_plan` is pure Python (no numpy) — always runs."""

    def test_scrfd_normalization_reaches_the_plan(self):
        plan = _ov_ppp_plan(
            dims=[1, 3, 640, 640],
            input_channels=3,
            preprocess_mode="letterbox",
            normalization="scrfd",
            enabled=True,
        )
        self.assertIsNotNone(plan)
        self.assertEqual(plan["normalization"], "scrfd")


@unittest.skipUnless(_HAS_REAL_NUMPY, "_apply_normalization needs real ndarray ops")
class ApplyNormalizationScrfdTest(unittest.TestCase):
    def setUp(self):
        import numpy as np

        self.np = np

    def _flat_hwc(self, value: float):
        """A 1x1 HWC array holding a single already-`/255` pixel value."""
        return self.np.array([[[value, value, value]]], dtype=self.np.float32)

    def test_scrfd_mode_matches_upstream_formula_at_pixel_extremes(self):
        # Upstream, on raw pixels: (pixel - 127.5) / 128.
        # pixel=0   → -0.99609375 ; pixel=255 → 0.99609375 ; pixel=127.5 → 0.0
        for pixel, expected in [(0.0, -0.99609375), (255.0, 0.99609375), (127.5, 0.0)]:
            arr = self._flat_hwc(pixel / 255.0)
            out = _apply_normalization(arr, {"inputNormalization": "scrfd"})
            self.assertEqual(out.shape, arr.shape)
            self.assertAlmostEqual(float(out[0, 0, 0]), expected, places=6)

    def test_absent_and_none_and_zero_one_are_unchanged(self):
        arr = self._flat_hwc(0.6)
        for config in ({}, {"inputNormalization": "none"}, {"inputNormalization": "zero-one"}):
            out = _apply_normalization(arr, config)
            self.assertTrue(self.np.array_equal(out, arr))

    def test_imagenet_mode_is_unaffected_by_the_scrfd_branch(self):
        # Regression guard: adding the 'scrfd' branch must not perturb the
        # existing 'imagenet' branch (animal/vehicle classifiers).
        arr = self._flat_hwc(0.5)
        out = _apply_normalization(arr, {"inputNormalization": "imagenet"})
        expected = (arr - inference_pool._IMAGENET_MEAN) / inference_pool._IMAGENET_STD
        self.assertTrue(self.np.allclose(out, expected))


if __name__ == "__main__":
    unittest.main()
