"""YOLOv9 Edge TPU build with ALL strides concatenated (the community plus catalog export).

The EdgeTPU-compiled YOLOv9 detectors the plus catalog community publishes
(`dbro/frigate-detector-edgetpu-yolo9`, releases v1.0 and v1.5) were read with
a flatbuffer dump of the files themselves (2026-10-22):

  yolov9-s-relu6-best_320_int8_edgetpu.tflite (v1.0)
    in : serving_default_images:0  [1, 320, 320, 3] uint8  scale 1/255 zp 0
    out: PartitionedCall:1          [1, 2100, 17]   int8   scale 0.027195 zp 19   (class LOGITS)
         PartitionedCall:0          [1, 2100, 64]   int8   scale 0.079690 zp -45  (DFL l,t,r,b × 16)
  yolov9-s-relu6-tpumax_512_int8_edgetpu.tflite (v1.5)
    out: [1, 5376, 64] int8, [1, 5376, 17] int8, and a THIRD [1, 5376, 1] int8

N is the three strides CONCATENATED, 8 then 16 then 32, each row-major
(2100 = 40² + 20² + 10²; 5376 = 64² + 32² + 16²) — not one tensor pair per
stride like the plugin catalog export `test_yolo_split_dfl.py` pins. The anchor of
cell (gx, gy) is ((gx + 0.5) · s, (gy + 0.5) · s); a box is anchor ∓ ltrb · s.

Every fixture below is QUANTISED with the real file's scale/zero-point and
dequantised through `edgetpu_dequant` exactly as the pool's edgetpu predict
closure does; the expected boxes are computed by hand in the comments.

Pure lists — runs on CI's bare interpreter (no numpy).
"""
from __future__ import annotations

import math
import os
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))  # edgetpu_dequant lives one level up

from edgetpu_dequant import dequant_edgetpu_output  # noqa: E402
from yolo_split_dfl import postprocess_yolo_split_dfl  # noqa: E402

# The real quantisation of yolov9-s-relu6-best_320_int8_edgetpu.tflite.
CLS_SCALE, CLS_ZP = 0.027195103466510773, 19
BOX_SCALE, BOX_ZP = 0.07969039678573608, -45

COCO17 = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
    "boat", "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear",
]

Q_HOT, Q_COLD = 127, -128  # int8 extremes: DFL bin logits 13.7 / -6.6 after dequant


def _dfl(l: int, t: int, r: int, b: int) -> list[int]:
    out: list[int] = []
    for bin_index in (l, t, r, b):
        out += [Q_HOT if i == bin_index else Q_COLD for i in range(16)]
    return out


def _sigmoid(q: int) -> float:
    return 1.0 / (1.0 + math.exp(-((q - CLS_ZP) * CLS_SCALE)))


def _quantised_outputs(cells: dict[int, tuple[tuple[int, int, int, int], int, int]], n: int) -> tuple[list, list]:
    """cells: candidate index → (ltrb bins, class id, quantised class logit)."""
    box = [[_dfl(0, 0, 0, 0) for _ in range(n)]]
    cls = [[[Q_COLD] * len(COCO17) for _ in range(n)]]
    for idx, (ltrb, class_id, q) in cells.items():
        box[0][idx] = _dfl(*ltrb)
        cls[0][idx][class_id] = q
    return box, cls


def _dequant_cls(cls: list) -> list:
    return dequant_edgetpu_output(cls, dtype_name="int8", scale=CLS_SCALE, zero_point=CLS_ZP)


def _dequant_box(box: list) -> list:
    return dequant_edgetpu_output(box, dtype_name="int8", scale=BOX_SCALE, zero_point=BOX_ZP)


CONFIG = {
    "labels": COCO17,
    "confidence": 0.5,
    "preprocessMode": "letterbox",
    "inputSize": 320,
    "inputWidth": 320,
    "inputHeight": 320,
    "nmsIouThreshold": 0.45,
}

# 640×480 frame letterboxed to 320: scale 0.5, content 320×240, pad (0, 40).
ORIG_W, ORIG_H, SCALE, PAD = 640, 480, 0.5, (0, 40)

# Stride 16 (grid 20, offset 40² = 1600), cell (gx 5, gy 7) → idx 1600 + 7·20 + 5 = 1745.
#   anchor (5.5·16, 7.5·16) = (88, 120); ltrb (2, 3, 4, 1) → (56, 72)-(152, 136) input px
#   → original ((56-0)/0.5, (72-40)/0.5, (152-0)/0.5, (136-40)/0.5) = (112, 64, 304, 192). car.
CAR_IDX, CAR_Q = 1745, 99
# Its neighbour (gx 6) → idx 1746, anchor (104, 120); ltrb (3, 3, 3, 1) → the SAME box,
# a weaker score: NMS must keep only the car above.
DUP_IDX, DUP_Q = 1746, 60
# Stride 32 (grid 10, offset 1600 + 400 = 2000), cell (gx 3, gy 2) → idx 2000 + 2·10 + 3 = 2023.
#   anchor (3.5·32, 2.5·32) = (112, 80); ltrb (1, 1, 2, 2) → (80, 48)-(176, 144) input px
#   → original (160, 16, 352, 208). person.
PERSON_IDX, PERSON_Q = 2023, 127

CELLS = {
    CAR_IDX: ((2, 3, 4, 1), 2, CAR_Q),
    DUP_IDX: ((3, 3, 3, 1), 2, DUP_Q),
    PERSON_IDX: ((1, 1, 2, 2), 0, PERSON_Q),
}


class YoloV9EdgeTpuConcatenatedStrides(unittest.TestCase):
    def _decode(self, predictions: dict) -> list[dict]:
        out = postprocess_yolo_split_dfl(predictions, CONFIG, ORIG_W, ORIG_H, SCALE, PAD)
        self.assertEqual(out["kind"], "detections")
        return sorted(out["detections"], key=lambda d: d["class"])

    def _assert_expected(self, dets: list[dict]) -> None:
        self.assertEqual([d["class"] for d in dets], ["car", "person"])
        car, person = dets
        self.assertEqual(car["bbox"], [112.0, 64.0, 304.0, 192.0])
        self.assertEqual(person["bbox"], [160.0, 16.0, 352.0, 208.0])
        self.assertEqual(car["score"], round(_sigmoid(CAR_Q), 4))
        self.assertEqual(person["score"], round(_sigmoid(PERSON_Q), 4))

    def test_v1_0_two_tensors_scores_first(self) -> None:
        box, cls = _quantised_outputs(CELLS, 2100)
        # Positional keys in the file's output order: scores, then boxes.
        self._assert_expected(self._decode({"0": _dequant_cls(cls), "1": _dequant_box(box)}))

    def test_v1_5_third_single_channel_tensor_is_not_the_class_tensor(self) -> None:
        box, cls = _quantised_outputs(CELLS, 2100)
        # The v1.5 files add a [1, N, 1] output AFTER the class tensor. Read as the
        # class tensor it would score every candidate on ONE cold channel.
        aux = [[[Q_COLD] for _ in range(2100)]]
        preds = {"0": _dequant_box(box), "1": _dequant_cls(cls), "2": _dequant_cls(aux)}
        self._assert_expected(self._decode(preds))

    def test_a_concatenated_n_that_matches_no_input_size_is_refused(self) -> None:
        box, cls = _quantised_outputs({}, 2101)
        with self.assertRaises(ValueError):
            self._decode({"0": _dequant_cls(cls), "1": _dequant_box(box)})


if __name__ == "__main__":
    unittest.main()
