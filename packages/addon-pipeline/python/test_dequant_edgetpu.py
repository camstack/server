"""Dequant of EdgeTPU integer outputs — the contract every full-integer graph needs.

SSD graphs emit float32 from ``TFLite_Detection_PostProcess`` and must pass
through unchanged. Classifiers and plugin catalog YOLOv9 TFLite emit int8/uint8 and
must become float32 via ``(q - zero_point) * scale`` before any postprocessor
sees them. Without this, softmax scores and DFL logits are garbage.
"""
from __future__ import annotations

import math
import unittest

from edgetpu_dequant import dequant_edgetpu_output


class DequantEdgetpuOutput(unittest.TestCase):
    def test_float32_passes_through_unchanged(self) -> None:
        # SSD Detection_PostProcess already emits float — do not touch.
        raw = [[0.1, 0.2, 0.3, 0.4]]
        out = dequant_edgetpu_output(raw, dtype_name="float32", scale=0.0, zero_point=0)
        self.assertEqual(out, raw)

    def test_uint8_prob_dequants_with_bird_scale(self) -> None:
        # Coral AIY Birds: scale 1/256, zp 0 — a raw 128 must become 0.5.
        raw = [0, 128, 255]
        out = dequant_edgetpu_output(raw, dtype_name="uint8", scale=1.0 / 256.0, zero_point=0)
        self.assertIsInstance(out, list)
        self.assertAlmostEqual(out[0], 0.0, places=6)
        self.assertAlmostEqual(out[1], 0.5, places=6)
        self.assertAlmostEqual(out[2], 255.0 / 256.0, places=6)

    def test_int8_logit_dequants(self) -> None:
        # plugin catalog full-int8 head: (q - zp) * scale.
        raw = [-128, 0, 127]
        out = dequant_edgetpu_output(
            raw, dtype_name="int8", scale=0.14899, zero_point=110
        )
        self.assertAlmostEqual(out[0], (-128 - 110) * 0.14899, places=5)
        self.assertAlmostEqual(out[1], (0 - 110) * 0.14899, places=5)
        self.assertAlmostEqual(out[2], (127 - 110) * 0.14899, places=5)

    def test_zero_scale_leaves_integer_as_float_cast(self) -> None:
        # No quantization params → cast only (do not invent a scale).
        raw = [1, 2, 3]
        out = dequant_edgetpu_output(raw, dtype_name="uint8", scale=0.0, zero_point=0)
        self.assertEqual(out, [1.0, 2.0, 3.0])

    def test_nested_lists_dequant_recursively(self) -> None:
        raw = [[[10, 20], [30, 40]]]
        out = dequant_edgetpu_output(raw, dtype_name="uint8", scale=0.5, zero_point=10)
        self.assertAlmostEqual(out[0][0][0], 0.0, places=6)
        self.assertAlmostEqual(out[0][0][1], 5.0, places=6)
        self.assertAlmostEqual(out[0][1][0], 10.0, places=6)
        self.assertAlmostEqual(out[0][1][1], 15.0, places=6)

    def test_scale_matches_sigmoid_gate_resolution(self) -> None:
        # 1/256 resolution is enough vs softmax.py's 0.01 floor.
        step = dequant_edgetpu_output([1], dtype_name="uint8", scale=1.0 / 256.0, zero_point=0)[0]
        self.assertLess(step, 0.01)
        self.assertGreater(step, 0.0)
        self.assertTrue(math.isfinite(step))


if __name__ == "__main__":
    unittest.main()
