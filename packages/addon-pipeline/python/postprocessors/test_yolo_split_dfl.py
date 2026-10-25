"""yolo-split-dfl — plugin catalog YOLOv9 TFLite 6-tensor DFL split-head decode.

plugin catalog's TFLite exports emit SIX tensors, not the ONNX ``[1, 7, 2100]`` layout:

  box × strides: [1, N, 64]  (4 × reg_max=16 DFL)
  cls × strides: [1, N, 3]   (person/vehicle/animal)

Pure-list fixtures so CI's bare interpreter covers the math. A fixture of real
plugin catalog tensors can join later; fakes alone are not proof on Coral hardware.
"""
from __future__ import annotations

import unittest

from yolo_split_dfl import postprocess_yolo_split_dfl


def _one_hot_dfl(bin_index: int, reg_max: int = 16) -> list[float]:
    logits = [-20.0] * reg_max
    logits[bin_index] = 20.0
    return logits


def _empty_box(n: int) -> list:
    return [[[-20.0] * 64 for _ in range(n)]]


def _empty_cls(n: int, num_classes: int = 3) -> list:
    return [[[-20.0] * num_classes for _ in range(n)]]


def _synthetic_predictions(
    *,
    grid: int,
    cell_x: int,
    cell_y: int,
    ltrb: tuple[int, int, int, int],
    class_id: int,
    num_classes: int = 3,
) -> dict:
    n = grid * grid
    box = _empty_box(n)
    cls = _empty_cls(n, num_classes)
    idx = cell_y * grid + cell_x
    l, t, r, b = ltrb
    box[0][idx] = _one_hot_dfl(l) + _one_hot_dfl(t) + _one_hot_dfl(r) + _one_hot_dfl(b)
    cls[0][idx] = [-20.0] * num_classes
    cls[0][idx][class_id] = 20.0

    # Sibling empty strides + shuffled keys — decoder must pair by shared N.
    return {
        "0": _empty_box(400),
        "1": box,
        "2": _empty_box(100),
        "3": _empty_cls(400),
        "4": cls,
        "5": _empty_cls(100),
    }


class YoloSplitDfl(unittest.TestCase):
    def test_registered_in_dispatch_table_source(self) -> None:
        # Loading ``postprocessors`` as a package needs the parent on sys.path
        # and numpy for sibling imports (yolo.py). On the bare CI path we pin
        # registration by reading the dispatch table source instead.
        from pathlib import Path

        init_src = (Path(__file__).resolve().parent / "__init__.py").read_text(encoding="utf-8")
        self.assertIn('"yolo-split-dfl": postprocess_yolo_split_dfl', init_src)
        self.assertIn("from .yolo_split_dfl import postprocess_yolo_split_dfl", init_src)

    def test_decodes_dfl_box_on_resize_preprocess(self) -> None:
        # Stride = 320/40 = 8. Cell (10,10) → centre 84,84.
        # ltrb bins (2,2,2,2) → ±16 px → box (68,68)-(100,100) input space.
        # resize on 640×480 → ×2 / ×1.5.
        preds = _synthetic_predictions(
            grid=40, cell_x=10, cell_y=10, ltrb=(2, 2, 2, 2), class_id=0
        )
        cfg = {
            "labels": ["person", "vehicle", "animal"],
            "confidence": 0.25,
            "preprocessMode": "resize",
            "inputSize": 320,
            "inputWidth": 320,
            "inputHeight": 320,
            "nmsIouThreshold": 0.45,
        }
        out = postprocess_yolo_split_dfl(preds, cfg, 640, 480, 1.0, (0, 0))
        self.assertEqual(out["kind"], "detections")
        self.assertEqual(len(out["detections"]), 1)
        det = out["detections"][0]
        self.assertEqual(det["class"], "person")
        self.assertGreater(det["score"], 0.9)
        x1, y1, x2, y2 = det["bbox"]
        self.assertAlmostEqual(x1, 68.0 * 640 / 320, places=0)
        self.assertAlmostEqual(y1, 68.0 * 480 / 320, places=0)
        self.assertAlmostEqual(x2, 100.0 * 640 / 320, places=0)
        self.assertAlmostEqual(y2, 100.0 * 480 / 320, places=0)

    def test_respects_confidence_floor(self) -> None:
        preds = _synthetic_predictions(
            grid=40, cell_x=5, cell_y=5, ltrb=(1, 1, 1, 1), class_id=1
        )
        cfg = {
            "labels": ["person", "vehicle", "animal"],
            "confidence": 0.99,
            "preprocessMode": "resize",
            "inputSize": 320,
        }
        preds["4"][0][5 * 40 + 5][1] = -5.0
        out = postprocess_yolo_split_dfl(preds, cfg, 320, 320, 1.0, (0, 0))
        self.assertEqual(out["detections"], [])

    def test_letterbox_undo_when_scale_pad_provided(self) -> None:
        preds = _synthetic_predictions(
            grid=40, cell_x=10, cell_y=10, ltrb=(2, 2, 2, 2), class_id=2
        )
        cfg = {
            "labels": ["person", "vehicle", "animal"],
            "confidence": 0.25,
            "preprocessMode": "letterbox",
            "inputSize": 320,
        }
        out = postprocess_yolo_split_dfl(preds, cfg, 640, 480, 0.5, (0, 40))
        det = out["detections"][0]
        self.assertEqual(det["class"], "animal")
        x1, y1, x2, y2 = det["bbox"]
        self.assertAlmostEqual(x1, (68.0 - 0) / 0.5, places=0)
        self.assertAlmostEqual(y1, (68.0 - 40) / 0.5, places=0)
        self.assertAlmostEqual(x2, (100.0 - 0) / 0.5, places=0)
        self.assertAlmostEqual(y2, (100.0 - 40) / 0.5, places=0)


if __name__ == "__main__":
    unittest.main()
