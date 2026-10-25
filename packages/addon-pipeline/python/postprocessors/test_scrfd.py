"""Pins SCRFD's anchor-center placement to InsightFace's upstream convention.

The production defect (2026-09-26 model-replacement spike,
docs/superpowers/specs/2026-09-26-replacement-models-spike.md §2.4-1): anchor
centers were computed as `(x + 0.5) * stride` (a "half-cell" YOLO-style
offset). Upstream InsightFace (`insightface/model_zoo/scrfd.py`) uses
`x * stride` — no half-cell. The offset shifted every box and landmark
down-and-right by half a stride (4/8/16 px at 640), degrading alignment and
therefore face-recognition accuracy on every install. Fixing it moved NME
(COCO eyes+nose GT) 0.352 → 0.115.

`unittest.TestCase`, not pytest-style: `scripts/test-python-pool.sh` classifies
test modules by content and runs the `unittest.TestCase` ones on the bare
interpreter (no pytest) — the path CI actually exercises
(`.github/workflows/ci.yml` `Test the inference pool (python)` step). Real
numpy when present; only `np.ceil` is stubbed on `ImportError` so `scrfd.py`
still imports and `_generate_anchors` (no ndarray ops, just scalar `np.ceil`)
still runs correctly — the anchor-formula regression is caught either way. The
fuller `postprocess_scrfd` round trip needs real ndarray behaviour a stub
cannot reasonably fake, so it is skipped (not silently passed) without real
numpy.
"""
import math
import sys
import types
import unittest

try:  # real numpy when the sandbox has it
    import numpy as _numpy_probe  # noqa: F401
except ImportError:
    _numpy_probe = None

# `import numpy` can SUCCEED against a MINIMAL STUB another test module in
# this same `python3 -m unittest` process already installed (this file's own
# `postprocessors/` subprocess currently runs alone, but this is the same
# defensive check `test_inference_pool_scrfd_normalization.py` needs — a bare
# "did the import raise" check is not reliable once more than one stubbing
# test module shares a process). `ndarray` is real-numpy-only.
_HAS_REAL_NUMPY = _numpy_probe is not None and hasattr(_numpy_probe, "ndarray")
if _numpy_probe is None:
    _np = types.ModuleType("numpy")
    _np.ceil = math.ceil  # the only numpy call `_generate_anchors` makes
    sys.modules["numpy"] = _np

from scrfd import _generate_anchors, postprocess_scrfd  # noqa: E402


class AnchorCentersHaveNoHalfCellOffsetTest(unittest.TestCase):
    """Numpy-independent: `_generate_anchors` only calls `np.ceil` on a
    scalar, so this runs — and catches the regression — with or without real
    numpy installed."""

    def test_first_anchor_sits_at_the_pixel_origin(self):
        # stride=8, input_size=16 → feat_size=2 → grid x,y in {0,1}. The FIRST
        # anchor center (grid cell 0,0) must sit at the pixel origin (0,0),
        # not at the half-cell (4,4) the old `(x+0.5)*stride` formula
        # produced.
        anchors = _generate_anchors(stride=8, input_size=16)
        self.assertEqual(anchors[0], (0.0, 0.0))
        self.assertEqual(anchors[1], (0.0, 0.0))  # NUM_ANCHORS_PER_STRIDE=2

    def test_anchor_centers_match_upstream_grid_exactly(self):
        stride, input_size = 16, 32  # feat_size = 2
        anchors = _generate_anchors(stride, input_size)
        # Upstream: anchor_centers = mgrid(feat, feat) * stride — plain
        # multiples of stride, row-major (y outer, x inner), 2 anchors/cell.
        expected = []
        for y in range(2):
            for x in range(2):
                expected.append((x * stride, y * stride))
                expected.append((x * stride, y * stride))
        self.assertEqual(anchors, expected)
        # The rejected half-cell formula would have placed the first center
        # at (8.0, 8.0), not (0.0, 0.0) — the exact regression this test
        # would catch if `_generate_anchors` reverted to `(x + 0.5) * stride`.
        self.assertNotEqual(anchors[0], (stride / 2, stride / 2))


def _single_anchor_output(np_mod, stride: int, input_size: int, box_offsets, kps_offsets=None):
    """Build a raw SCRFD-shaped output with exactly ONE live anchor (grid cell
    0,0, first of the two anchors), all others below threshold. Needs real
    ndarray behaviour, so only called from the real-numpy-gated tests below."""
    feat = int(np_mod.ceil(input_size / stride))
    n = feat * feat * 2
    scores = np_mod.zeros((n, 1), dtype=np_mod.float32)
    scores[0, 0] = 0.99
    bboxes = np_mod.zeros((n, 4), dtype=np_mod.float32)
    bboxes[0] = box_offsets
    out = {f"score_{stride}": scores, f"bbox_{stride}": bboxes}
    if kps_offsets is not None:
        kps = np_mod.zeros((n, 10), dtype=np_mod.float32)
        kps[0] = kps_offsets
        out[f"kps_{stride}"] = kps
    return out


@unittest.skipUnless(_HAS_REAL_NUMPY, "postprocess_scrfd round trip needs real ndarray ops")
class PostprocessScrfdRoundTripTest(unittest.TestCase):
    def setUp(self):
        import numpy as np

        self.np = np

    def test_box_position_uses_unshifted_anchor_center(self):
        # Grid cell (0,0) at stride 8 → anchor center (0,0) after the fix. A
        # symmetric box offset of 5 stride-units around the anchor center
        # lands the box at [0, 0, 40, 40] pre-clamp on the un-clamped side.
        stride, input_size = 8, 640
        raw = _single_anchor_output(self.np, stride, input_size, box_offsets=[5.0, 5.0, 5.0, 5.0])
        out = postprocess_scrfd(
            raw,
            {"confidence": 0.5, "inputSize": input_size, "strides": [stride]},
            orig_w=1000,
            orig_h=1000,
            scale=1.0,
            pad=(0, 0),
        )
        dets = out["detections"]
        self.assertEqual(len(dets), 1)
        _x1, _y1, x2, y2 = dets[0]["bbox"]
        self.assertEqual(x2, 40.0)  # 0 + 5*8
        self.assertEqual(y2, 40.0)
        # With the OLD (x+0.5)*stride formula the anchor center would have
        # been (4, 4) and x2/y2 would be 44.0, not 40.0 — the regression
        # guard.
        self.assertNotEqual(x2, 44.0)

    def test_landmarks_use_unshifted_anchor_center(self):
        stride, input_size = 16, 640
        kps = [1.0, 1.0] * 5  # 5 landmarks, each offset (1,1) stride-units
        raw = _single_anchor_output(
            self.np, stride, input_size, box_offsets=[1.0, 1.0, 1.0, 1.0], kps_offsets=kps
        )
        out = postprocess_scrfd(
            raw,
            {"confidence": 0.5, "inputSize": input_size, "strides": [stride]},
            orig_w=1000,
            orig_h=1000,
            scale=1.0,
            pad=(0, 0),
        )
        dets = out["detections"]
        self.assertEqual(len(dets), 1)
        for p in dets[0]["landmarks"]:
            # anchor (0,0) + 1*stride = 16, not 8 (the half-cell) + 16 = 24.
            self.assertEqual(p["x"], 16.0)
            self.assertEqual(p["y"], 16.0)


if __name__ == "__main__":
    unittest.main()
