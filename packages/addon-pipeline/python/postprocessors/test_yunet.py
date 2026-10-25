"""Pins the YuNet decoder: prior layout, box/landmark decode, landmark order.

YuNet out of the box found 0 faces on 413 person crops through the SCRFD
decoder (2026-09-26 model-replacement spike, §2.2): one prior per cell instead
of two, centre+exp(size) boxes instead of anchor distances, and a score split
across `cls_*` and `obj_*`. Each class below pins one of those.

`unittest.TestCase`, not pytest-style: `scripts/test-python-pool.sh` runs the
`unittest.TestCase` modules on CI's bare interpreter — the self-hosted runner
has NO numpy. So everything that decides is plain Python and tested here
without it: prior layout, decode, landmark order, the score, NMS, the top-K cap,
and the output gate (`check_outputs` runs before `postprocess_yunet` touches
numpy, so its refusals are exercised through `postprocess_yunet` itself).

What genuinely needs real numpy, and is SKIPPED (named) without it: the
vectorised pre-filter (`np.maximum(cls, obj) >= conf`), and the decode of a
live prior through `postprocess_yunet` end to end (flatten/reshape of the
tensors, the cap applied inside it). Those run wherever numpy is installed —
every pool host — and in the spike harness.
"""
import math
import sys
import types
import unittest

try:  # real numpy when the sandbox has it
    import numpy as _numpy_probe  # noqa: F401
except ImportError:
    _numpy_probe = None

# `ndarray` is real-numpy-only: a stub another module installed would import.
_HAS_REAL_NUMPY = _numpy_probe is not None and hasattr(_numpy_probe, "ndarray")

# Without numpy, `yunet.py`'s `import numpy` is satisfied by an EMPTY stub for
# the duration of the import only, and the stub is removed again at once: a
# stub left in `sys.modules` would be picked up by the next test module in the
# same `python3 -m unittest` process (test_scrfd needs `np.ceil` from its OWN
# stub), making the result depend on module order. `yunet` keeps its own
# reference; nothing it runs here touches it.
if _numpy_probe is None:
    sys.modules["numpy"] = types.ModuleType("numpy")
    try:
        import yunet  # noqa: F401
    finally:
        del sys.modules["numpy"]

from yunet import (  # noqa: E402
    NUM_LANDMARKS,
    STRIDES,
    TOP_K,
    cap_top_k,
    check_outputs,
    decode_prior,
    grid_cols,
    missing_outputs,
    nms,
    postprocess_yunet,
    prior_cell,
    score_of,
    to_source,
    value_count,
)


class PriorLayoutTest(unittest.TestCase):
    """One prior per cell, row-major — NOT SCRFD's two anchors per cell."""

    def test_grid_is_one_prior_per_cell_at_640(self):
        self.assertEqual([grid_cols(s, 640) for s in STRIDES], [80, 40, 20])
        # 6400 + 1600 + 400. SCRFD's layout would be twice this (16800).
        self.assertEqual(sum(grid_cols(s, 640) ** 2 for s in STRIDES), 8400)

    def test_index_is_row_major(self):
        cols = grid_cols(8, 640)
        self.assertEqual(prior_cell(0, cols), (0, 0))
        self.assertEqual(prior_cell(1, cols), (0, 1))  # SCRFD: index 1 is still cell (0,0)
        self.assertEqual(prior_cell(cols + 2, cols), (1, 2))
        self.assertEqual(prior_cell(cols * cols - 1, cols), (cols - 1, cols - 1))


class DecodeTest(unittest.TestCase):
    def test_box_is_centre_plus_exp_size_from_the_cell_corner(self):
        # cell (row 1, col 2) at stride 8; centre offset (0.5, 0.5) → centre
        # ((2+.5)*8, (1+.5)*8) = (20, 12); log size 0 → 8×8.
        box, _ = decode_prior(8, 1, 2, [0.5, 0.5, 0.0, 0.0], [0.0] * 10)
        self.assertEqual(box, (16.0, 8.0, 24.0, 16.0))

    def test_size_is_exponential(self):
        box, _ = decode_prior(16, 0, 0, [0.0, 0.0, math.log(3.0), math.log(2.0)], [0.0] * 10)
        x1, y1, x2, y2 = box
        self.assertAlmostEqual(x2 - x1, 48.0, places=4)  # 3 * 16
        self.assertAlmostEqual(y2 - y1, 32.0, places=4)  # 2 * 16

    def test_landmarks_are_cell_relative_in_stride_units(self):
        kps = [0.25, 0.5, 0.75, 0.5, 0.5, 1.0, 0.25, 1.5, 0.75, 1.5]
        _, points = decode_prior(32, 3, 4, [0.0, 0.0, 0.0, 0.0], kps)
        self.assertEqual(len(points), NUM_LANDMARKS)
        self.assertEqual(points[0], ((4 + 0.25) * 32, (3 + 0.5) * 32))
        self.assertEqual(points[2], ((4 + 0.5) * 32, (3 + 1.0) * 32))

    def test_score_is_geometric_mean_of_clamped_cls_and_obj(self):
        self.assertAlmostEqual(score_of(0.81, 1.0), 0.9)
        self.assertAlmostEqual(score_of(0.64, 0.25), 0.4)
        self.assertEqual(score_of(1.3, 1.0), 1.0)
        self.assertEqual(score_of(-0.2, 1.0), 0.0)

    def test_to_source_undoes_the_letterbox(self):
        # 320×160 crop letterboxed into 640: scale 2, pad (0, 160).
        self.assertEqual(to_source(100.0, 260.0, 2.0, (0, 160)), (50.0, 50.0))


class LandmarkOrderTest(unittest.TestCase):
    """YuNet emits the SUBJECT's right eye first = image-LEFT eye, which is
    the order `face-align.ts` maps onto ARCFACE_TEMPLATE_112. The decoder must
    pass the five points through in model order — a sort or a swap here
    mirrors every aligned face."""

    def test_points_keep_model_order(self):
        # A frontal face: image-left eye, image-right eye, nose, mouth L, mouth R.
        kps = [0.2, 0.3, 0.8, 0.3, 0.5, 0.55, 0.3, 0.8, 0.7, 0.8]
        _, points = decode_prior(8, 0, 0, [0.5, 0.5, 0.0, 0.0], kps)
        xs = [p[0] for p in points]
        self.assertLess(xs[0], xs[1])  # eye 0 is image-left
        self.assertLess(xs[3], xs[4])  # mouth 3 is image-left
        self.assertEqual([round(x, 3) for x in xs], [1.6, 6.4, 4.0, 2.4, 5.6])


class MissingOutputsTest(unittest.TestCase):
    """Name-only matching: a model without YuNet's twelve named tensors is
    refused, not decoded as "no faces"."""

    def test_all_twelve_present(self):
        names = [f"{k}_{s}" for k in ("cls", "obj", "bbox", "kps") for s in STRIDES]
        self.assertEqual(missing_outputs(names), [])

    def test_names_what_is_missing(self):
        names = [f"{k}_{s}" for k in ("cls", "bbox", "kps") for s in STRIDES]
        self.assertEqual(missing_outputs(names), ["obj_8", "obj_16", "obj_32"])

    def test_scrfd_style_outputs_are_refused(self):
        names = [f"{k}_{s}" for k in ("score", "bbox", "kps") for s in STRIDES]
        self.assertIn("cls_8", missing_outputs(names))


def _list_outputs(input_size=640, drop=()):
    """Correctly-SHAPED outputs as nested lists — no numpy needed."""
    out = {}
    for s in STRIDES:
        n = grid_cols(s, input_size) ** 2
        for kind, width in (("cls", 1), ("obj", 1), ("bbox", 4), ("kps", 10)):
            if f"{kind}_{s}" not in drop:
                out[f"{kind}_{s}"] = [[[0.0] * width for _ in range(n)]]
    return out


class OutputGateTest(unittest.TestCase):
    """`check_outputs` runs before any numpy call, so these go through
    `postprocess_yunet` itself on the bare interpreter."""

    def test_missing_output_raises_instead_of_reporting_no_faces(self):
        raw = _list_outputs(drop=("obj_32",))
        with self.assertRaises(ValueError) as ctx:
            postprocess_yunet(raw, {"confidence": 0.5}, 640, 640, 1.0, (0, 0))
        self.assertIn("obj_32", str(ctx.exception))

    def test_wrong_input_size_raises(self):
        raw = _list_outputs(input_size=320)
        with self.assertRaises(ValueError) as ctx:
            postprocess_yunet(raw, {"confidence": 0.5, "inputSize": 640}, 640, 640, 1.0, (0, 0))
        self.assertIn("does not match the model", str(ctx.exception))

    def test_correct_outputs_pass_the_gate(self):
        check_outputs(_list_outputs(), 640)  # no raise

    def test_value_count_of_nested_lists(self):
        self.assertEqual(value_count([[[0.0] * 4 for _ in range(3)]]), 12)
        self.assertEqual(value_count(7.0), 1)


class TopKCapTest(unittest.TestCase):
    """The pure-Python NMS is O(n·kept): 5000 disjoint candidates took 2.8 s.
    At most TOP_K, the best by score, may reach it."""

    def _cands(self, n):
        return [{"score": (i % 997) / 997.0, "_xyxy": (i, 0, i + 1, 1)} for i in range(n)]

    def test_under_the_cap_is_untouched(self):
        cands = self._cands(10)
        kept, dropped = cap_top_k(cands)
        self.assertIs(kept, cands)
        self.assertEqual(dropped, 0)

    def test_over_the_cap_keeps_the_best_k(self):
        cands = self._cands(TOP_K + 250)
        kept, dropped = cap_top_k(cands)
        self.assertEqual(len(kept), TOP_K)
        self.assertEqual(dropped, 250)
        worst_kept = min(c["score"] for c in kept)
        best_dropped = max(c["score"] for c in cands if c not in kept)
        self.assertGreaterEqual(worst_kept, best_dropped)

    def test_cap_is_well_below_upstream_and_above_real_frames(self):
        # upstream 5000 (C++ NMS); measured max 110 candidates/frame at 0.1.
        self.assertLessEqual(TOP_K, 5000)
        self.assertGreaterEqual(TOP_K, 110 * 5)


class NmsTest(unittest.TestCase):
    def test_keeps_best_of_overlapping_and_disjoint(self):
        cands = [
            {"score": 0.6, "_xyxy": (0, 0, 10, 10)},
            {"score": 0.9, "_xyxy": (1, 1, 11, 11)},
            {"score": 0.7, "_xyxy": (50, 50, 60, 60)},
        ]
        kept = nms(cands, 0.45)
        self.assertEqual([k["score"] for k in kept], [0.9, 0.7])


def _outputs(np, input_size=640, live=None):
    """Raw YuNet-shaped outputs, all priors dead except `live`:
    {stride: (index, cls, obj, bbox4, kps10)}."""
    out = {}
    for s in STRIDES:
        n = grid_cols(s, input_size) ** 2
        out[f"cls_{s}"] = np.zeros((1, n, 1), np.float32)
        out[f"obj_{s}"] = np.zeros((1, n, 1), np.float32)
        out[f"bbox_{s}"] = np.zeros((1, n, 4), np.float32)
        out[f"kps_{s}"] = np.zeros((1, n, 10), np.float32)
    for s, (index, cls, obj, bbox, kps) in (live or {}).items():
        out[f"cls_{s}"][0, index, 0] = cls
        out[f"obj_{s}"][0, index, 0] = obj
        out[f"bbox_{s}"][0, index] = bbox
        out[f"kps_{s}"][0, index] = kps
    return out


@unittest.skipUnless(_HAS_REAL_NUMPY, "postprocess_yunet round trip needs real ndarray ops")
class PostprocessYunetRoundTripTest(unittest.TestCase):
    def setUp(self):
        import numpy as np

        self.np = np

    def test_one_live_prior_decodes_to_source_pixels(self):
        cols = grid_cols(16, 640)
        index = 10 * cols + 20  # row 10, col 20
        kps = [0.2, 0.3, 0.8, 0.3, 0.5, 0.55, 0.3, 0.8, 0.7, 0.8]
        raw = _outputs(self.np, live={16: (index, 0.81, 1.0, [0.5, 0.5, math.log(4), math.log(4)], kps)})
        # 1280×640 frame letterboxed into 640: scale 0.5, pad (0, 160).
        out = postprocess_yunet(raw, {"confidence": 0.5, "inputSize": 640}, 1280, 640, 0.5, (0, 160))
        dets = out["detections"]
        self.assertEqual(len(dets), 1)
        d = dets[0]
        self.assertEqual(d["class"], "face")
        self.assertAlmostEqual(d["score"], 0.9, places=3)
        # network centre (328, 168), size 64 → [296,136,360,200] → source /0.5, y-160.
        self.assertEqual(d["bbox"], [592.0, 0.0, 720.0, 80.0])
        self.assertEqual(len(d["landmarks"]), NUM_LANDMARKS)
        self.assertEqual(d["landmarks"][0], {"x": round((20.2 * 16) / 0.5, 1), "y": round((10.3 * 16 - 160) / 0.5, 1)})
        self.assertLess(d["landmarks"][0]["x"], d["landmarks"][1]["x"])

    def test_score_uses_both_tensors(self):
        cols = grid_cols(8, 640)
        # cls alone high, obj low → sqrt(0.9*0.1)=0.3 < 0.5: dropped.
        raw = _outputs(self.np, live={8: (cols + 1, 0.9, 0.1, [0.5, 0.5, 1.0, 1.0], [0.0] * 10)})
        out = postprocess_yunet(raw, {"confidence": 0.5}, 640, 640, 1.0, (0, 0))
        self.assertEqual(out["detections"], [])

    def test_prior_with_low_cls_but_high_obj_still_passes(self):
        # sqrt(0.45 * 0.95) = 0.654 >= 0.5 although cls alone is under it: a
        # prefilter on ONE tensor would drop a real face here.
        cols = grid_cols(32, 640)
        raw = _outputs(self.np, live={32: (cols + 3, 0.45, 0.95, [0.5, 0.5, 0.0, 0.0], [0.0] * 10)})
        out = postprocess_yunet(raw, {"confidence": 0.5}, 640, 640, 1.0, (0, 0))
        self.assertEqual(len(out["detections"]), 1)
        self.assertAlmostEqual(out["detections"][0]["score"], 0.6538, places=3)

    def test_cap_applies_inside_postprocess(self):
        # TOP_K + 50 disjoint live priors on the stride-8 grid: all pass the
        # score gate, none overlap, so only the cap can remove any.
        n = grid_cols(8, 640) ** 2
        raw = _outputs(self.np)
        live = list(range(0, n, 2))[: TOP_K + 50]
        raw["cls_8"][0, live, 0] = 0.9
        raw["obj_8"][0, live, 0] = 0.9
        raw["bbox_8"][0, live] = [0.5, 0.5, -1.0, -1.0]  # ~3 px boxes, disjoint
        out = postprocess_yunet(raw, {"confidence": 0.5}, 640, 640, 1.0, (0, 0))
        self.assertEqual(len(out["detections"]), TOP_K)


if __name__ == "__main__":
    unittest.main()
