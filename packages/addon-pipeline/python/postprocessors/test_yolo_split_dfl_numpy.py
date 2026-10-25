"""yolo-split-dfl — the vectorised (numpy) decode is the list decode, faster.

The pool hands the decoder float32 ndarrays (``edgetpu_dequant`` dequantises
vectorised). Walking them as nested lists cost ~5 ms per frame at 320² and
~12 ms at 512² on a desktop core (N = 2100 / 5376 cells × 81 values), the
largest N-dependent share of the Coral YOLOv9 step (2026-10-22). The numpy
path must produce EXACTLY the list path's output: every fixture of
``test_yolo_split_dfl`` and ``test_yolov9_edgetpu_concat``, plus dense
random scenes, is decoded both ways and compared field for field.

Skipped on a bare interpreter (no numpy): there the list path is the only
path and the two sibling modules pin it.
"""
from __future__ import annotations

import os
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))  # edgetpu_dequant lives one level up

try:
    import numpy as np
except ImportError:  # pragma: no cover - the bare CI interpreter
    np = None
if np is not None and not hasattr(np, "ndarray"):
    np = None  # a sibling test's stand-in module, not numpy

from edgetpu_dequant import dequant_edgetpu_output  # noqa: E402
from yolo_split_dfl import postprocess_yolo_split_dfl  # noqa: E402
import test_yolo_split_dfl as plugin_catalog  # noqa: E402
import test_yolov9_edgetpu_concat as coral  # noqa: E402

if np is not None:

    class _NoListWalk(np.ndarray):
        """An ndarray that refuses to be walked as nested Python lists."""

        def tolist(self):  # noqa: D401 - mirrors ndarray.tolist
            raise AssertionError("yolo-split-dfl walked a whole tensor as Python lists")


def _as_lists(preds: dict) -> dict:
    return {k: v.tolist() for k, v in preds.items()}


def _float32(preds: dict) -> dict:
    return {k: np.asarray(v, dtype=np.float32) for k, v in preds.items()}


def _guarded(preds: dict) -> dict:
    return {k: np.asarray(v).view(_NoListWalk) for k, v in preds.items()}


PLUGIN_CATALOG_CASES = (
    # (fixture kwargs, config, orig_w, orig_h, scale, pad)
    (
        dict(grid=40, cell_x=10, cell_y=10, ltrb=(2, 2, 2, 2), class_id=0),
        {"labels": ["person", "vehicle", "animal"], "confidence": 0.25, "preprocessMode": "resize",
         "inputSize": 320, "inputWidth": 320, "inputHeight": 320, "nmsIouThreshold": 0.45},
        640, 480, 1.0, (0, 0),
    ),
    (
        dict(grid=40, cell_x=10, cell_y=10, ltrb=(2, 2, 2, 2), class_id=2),
        {"labels": ["person", "vehicle", "animal"], "confidence": 0.25, "preprocessMode": "letterbox",
         "inputSize": 320},
        640, 480, 0.5, (0, 40),
    ),
    (
        dict(grid=40, cell_x=5, cell_y=5, ltrb=(1, 1, 1, 1), class_id=1),
        {"labels": ["person", "vehicle", "animal"], "confidence": 0.99, "preprocessMode": "resize",
         "inputSize": 320},
        320, 320, 1.0, (0, 0),
    ),
)


def _random_coral(n: int, hot: int, seed: int) -> dict:
    rng = np.random.default_rng(seed)
    cls = rng.integers(-128, -60, size=(1, n, 17), dtype=np.int8)
    box = rng.integers(-128, 128, size=(1, n, 64), dtype=np.int8)
    for i in rng.choice(n, size=hot, replace=False):
        cls[0, i, rng.integers(0, 17)] = rng.integers(0, 128)
    return {
        "0": dequant_edgetpu_output(cls, dtype_name="int8", scale=coral.CLS_SCALE, zero_point=coral.CLS_ZP),
        "1": dequant_edgetpu_output(box, dtype_name="int8", scale=coral.BOX_SCALE, zero_point=coral.BOX_ZP),
    }


@unittest.skipIf(np is None, "numpy not installed — the list path is the only path")
class YoloSplitDflVectorised(unittest.TestCase):
    def _assert_same(self, preds: dict, cfg: dict, w: int, h: int, scale: float, pad: tuple) -> dict:
        expected = postprocess_yolo_split_dfl(_as_lists(preds), cfg, w, h, scale, pad)
        actual = postprocess_yolo_split_dfl(_guarded(preds), cfg, w, h, scale, pad)
        self.assertEqual(actual, expected)
        return actual

    def test_a_tensor_is_not_walked_as_python_lists(self) -> None:
        box, cls = coral._quantised_outputs(coral.CELLS, 2100)
        preds = _guarded({
            "0": dequant_edgetpu_output(np.asarray(cls, dtype=np.int8), dtype_name="int8",
                                        scale=coral.CLS_SCALE, zero_point=coral.CLS_ZP),
            "1": dequant_edgetpu_output(np.asarray(box, dtype=np.int8), dtype_name="int8",
                                        scale=coral.BOX_SCALE, zero_point=coral.BOX_ZP),
        })
        out = postprocess_yolo_split_dfl(preds, coral.CONFIG, coral.ORIG_W, coral.ORIG_H, coral.SCALE, coral.PAD)
        self.assertEqual(sorted(d["class"] for d in out["detections"]), ["car", "person"])

    def test_the_plugin_catalog_six_tensor_fixtures_decode_identically(self) -> None:
        for kwargs, cfg, w, h, scale, pad in PLUGIN_CATALOG_CASES:
            with self.subTest(kwargs=kwargs, mode=cfg["preprocessMode"]):
                preds = plugin_catalog._synthetic_predictions(**kwargs)
                if cfg["confidence"] == 0.99:
                    preds["4"][0][5 * 40 + 5][1] = -5.0
                self._assert_same(_float32(preds), cfg, w, h, scale, pad)

    def test_the_coral_concatenated_fixtures_decode_identically(self) -> None:
        box, cls = coral._quantised_outputs(coral.CELLS, 2100)
        aux = [[[coral.Q_COLD] for _ in range(2100)]]

        def dq(q: list, s: float, zp: int):
            return dequant_edgetpu_output(np.asarray(q, dtype=np.int8), dtype_name="int8", scale=s, zero_point=zp)

        v10 = {"0": dq(cls, coral.CLS_SCALE, coral.CLS_ZP), "1": dq(box, coral.BOX_SCALE, coral.BOX_ZP)}
        v15 = {**v10, "2": dq(aux, coral.CLS_SCALE, coral.CLS_ZP)}
        for preds in (v10, v15):
            out = self._assert_same(preds, coral.CONFIG, coral.ORIG_W, coral.ORIG_H, coral.SCALE, coral.PAD)
            self.assertEqual(len(out["detections"]), 2)

    def test_dense_random_scenes_decode_identically(self) -> None:
        cases = (
            (320, 2100, 0.3, "letterbox", 1280, 720),
            (512, 5376, 0.25, "letterbox", 1920, 1080),
            (320, 2100, 0.5, "resize", 640, 480),
        )
        for seed, (res, n, conf, mode, w, h) in enumerate(cases):
            with self.subTest(res=res, mode=mode):
                scale = res / max(w, h)
                pad = ((res - round(w * scale)) // 2, (res - round(h * scale)) // 2)
                cfg = {"labels": coral.COCO17, "confidence": conf, "preprocessMode": mode,
                       "inputSize": res, "inputWidth": res, "inputHeight": res, "nmsIouThreshold": 0.45}
                out = self._assert_same(_random_coral(n, 400, seed), cfg, w, h, scale, pad)
                self.assertGreater(len(out["detections"]), 10)

    def test_a_tensor_pair_that_matches_no_layout_is_still_refused(self) -> None:
        box, cls = coral._quantised_outputs({}, 2101)
        with self.assertRaises(ValueError):
            postprocess_yolo_split_dfl(
                _guarded(_float32({"0": cls, "1": box})), coral.CONFIG,
                coral.ORIG_W, coral.ORIG_H, coral.SCALE, coral.PAD,
            )


if __name__ == "__main__":
    unittest.main()
