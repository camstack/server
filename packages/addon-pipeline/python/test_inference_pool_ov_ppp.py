"""Fix 2 — OpenVINO PrePostProcessor eligibility (`_ov_ppp_plan`) + the uint8
dimension helper (`_ov_dim_to_int`).

`_ov_ppp_plan` is the PURE decision (no OpenVINO / numpy) of WHETHER to fold
preprocessing into the compiled graph: only standard 3-channel NCHW
detectors/classifiers with a static spatial size qualify; grayscale CTC
recognizers and NHWC-native embedders (ArcFace/CLIP) keep the pure-Python float
path. Heavy deps are stubbed so the module imports in a minimal sandbox.

Run: python3 -m unittest test_inference_pool_ov_ppp -v
"""
import sys
import types
import unittest

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

from inference_pool import _ov_dim_to_int, _ov_ppp_plan  # noqa: E402


class _StaticDim:
    """Mimics an OpenVINO static Dimension: int() raises, get_length() works."""

    def __init__(self, length: int) -> None:
        self._length = length
        self.is_static = True

    def __int__(self) -> int:
        raise TypeError("Dimension is not directly int()-able")

    def get_length(self) -> int:
        return self._length


class _DynamicDim:
    is_static = False

    def __int__(self) -> int:
        raise TypeError("dynamic dimension")


class OvDimToIntTest(unittest.TestCase):
    def test_plain_int_passthrough(self) -> None:
        self.assertEqual(_ov_dim_to_int(640), 640)

    def test_static_dimension_uses_get_length(self) -> None:
        self.assertEqual(_ov_dim_to_int(_StaticDim(416)), 416)

    def test_dynamic_dimension_is_none(self) -> None:
        self.assertIsNone(_ov_dim_to_int(_DynamicDim()))

    def test_garbage_is_none(self) -> None:
        self.assertIsNone(_ov_dim_to_int(object()))


class OvPppPlanTest(unittest.TestCase):
    def test_standard_square_detector_folds_with_letterbox(self) -> None:
        plan = _ov_ppp_plan([1, 3, 640, 640], 3, "letterbox", None, True)
        self.assertIsNotNone(plan)
        assert plan is not None
        self.assertEqual((plan["inputW"], plan["inputH"], plan["size"]), (640, 640, 640))
        self.assertTrue(plan["letterbox"])
        self.assertEqual(plan["normalization"], "none")

    def test_non_letterbox_classifier_plan_is_plain_resize(self) -> None:
        plan = _ov_ppp_plan([1, 3, 224, 224], 3, "resize", "imagenet", True)
        assert plan is not None
        self.assertFalse(plan["letterbox"])
        self.assertEqual(plan["normalization"], "imagenet")

    def test_non_square_detector_uses_max_side_for_letterbox(self) -> None:
        # `_ov_ppp_plan` takes ALREADY-resolved int|None dims (the caller runs
        # `_ov_dim_to_int` over the OV Dimensions first — see _ov_dim_to_int
        # tests above). Non-square 384×640 → letterbox square uses the max side.
        plan = _ov_ppp_plan([1, 3, 384, 640], 3, "letterbox", None, True)
        assert plan is not None
        self.assertEqual((plan["inputW"], plan["inputH"]), (640, 384))
        self.assertEqual(plan["size"], 640)

    def test_disabled_returns_none(self) -> None:
        self.assertIsNone(_ov_ppp_plan([1, 3, 640, 640], 3, "letterbox", None, False))

    def test_grayscale_ctc_is_rejected(self) -> None:
        # Plate-OCR: channels==1 → keep the pure-Python EasyOCR path.
        self.assertIsNone(_ov_ppp_plan([1, 1, 64, 384], 1, "resize", None, True))

    def test_nhwc_native_embedder_is_rejected(self) -> None:
        # ArcFace/CLIP declare [N,H,W,C] → the NCHW channel slot holds a spatial
        # value (112), not 3 → rejected, embedder stays on the float NHWC path.
        self.assertIsNone(_ov_ppp_plan([1, 112, 112, 3], 3, "resize", None, True))

    def test_dynamic_spatial_is_rejected(self) -> None:
        self.assertIsNone(_ov_ppp_plan([1, 3, None, None], 3, "letterbox", None, True))

    def test_wrong_rank_is_rejected(self) -> None:
        self.assertIsNone(_ov_ppp_plan([3, 640, 640], 3, "letterbox", None, True))
        self.assertIsNone(_ov_ppp_plan(None, 3, "letterbox", None, True))


if __name__ == "__main__":
    unittest.main()
