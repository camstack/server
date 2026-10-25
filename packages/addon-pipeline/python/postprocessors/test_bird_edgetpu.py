"""Pins the bird-classifier Coral build on REAL output tensors (D710 enforcement).

`bird-classifier` ships a `tflite` format compiled for the Edge TPU
(`bird-classifier_edgetpu.tflite`). Its single output is `[1,965] uint8`,
scale 1/256, zero point 0, with the softmax ALREADY in the graph. Two things
must hold for the step to emit the species the ONNX survivor emits:

- the edgetpu predict closure dequantises the tensor (`edgetpu_dequant`) —
  read raw, the top-1 "probability" is a byte count in the hundreds and every
  confidence gate passes everything;
- the softmax postprocessor consumes it verbatim (`outputProbabilities`) —
  re-softmaxing a 1/256-step distribution flattens it below the 0.6 gate.

The fixture (`testdata/bird_classifier_int8_outputs.json`) holds the raw
outputs of the integer graph the Edge TPU file is compiled from, on two bird
crops (detector boxes) and one 48-px crop whose top-1 is `background`, next
to the ONNX survivor's top-1 on the same crop. Produced by
`scripts/build-bird-classifier-edgetpu.py`; its `producedBy` says how.

`unittest.TestCase`: the dequant cases run on CI's bare interpreter (no
numpy); the postprocessor cases need numpy (`softmax.py` imports it) and are
skipped, by name, without it.
"""
import json
import os
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))  # edgetpu_dequant lives one level up

from edgetpu_dequant import dequant_edgetpu_output  # noqa: E402

try:
    import numpy as _numpy_probe
except ImportError:
    _numpy_probe = None
_HAS_REAL_NUMPY = _numpy_probe is not None and hasattr(_numpy_probe, "ndarray")

with open(os.path.join(_HERE, "testdata", "bird_classifier_int8_outputs.json"), encoding="utf-8") as _fh:
    _FIXTURE = json.load(_fh)

_OUT = _FIXTURE["output"]
_BACKGROUND = _FIXTURE["backgroundIndex"]
_STEP_GATE = 0.6  # STEP_BIRD_CLASSIFIER.defaultConfidence
_SPECIES = [f for f in _FIXTURE["frames"] if f["onnxTop1Index"] != _BACKGROUND]
_BACKGROUND_FRAMES = [f for f in _FIXTURE["frames"] if f["onnxTop1Index"] == _BACKGROUND]
# One crop's ONNX vs int8 top-1 difference is quantisation noise, not a defect;
# the parity pass of the build script measured p95 of max |dp| at 0.12.
_SCORE_TOLERANCE = 0.05


def _dequant(frame):
    return dequant_edgetpu_output(
        [frame["raw"]], dtype_name=_OUT["dtype"], scale=_OUT["scale"], zero_point=_OUT["zeroPoint"],
    )


class BirdEdgetpuDequant(unittest.TestCase):
    def test_fixture_is_the_shipped_contract(self):
        self.assertEqual(_OUT["shape"], [1, 965])
        self.assertEqual(_OUT["dtype"], "uint8")
        self.assertAlmostEqual(_OUT["scale"], 1.0 / 256.0, places=9)
        self.assertEqual(_OUT["zeroPoint"], 0)
        self.assertGreaterEqual(len(_SPECIES), 2)
        self.assertEqual(len(_BACKGROUND_FRAMES), 1)

    def test_raw_tensor_is_not_a_probability(self):
        # The defect the dequant closes: read raw, the top-1 is far above 1.
        for frame in _SPECIES:
            self.assertGreater(max(frame["raw"]), 200)

    def test_dequantised_tensor_is_the_in_graph_softmax(self):
        for frame in _FIXTURE["frames"]:
            probs = _dequant(frame)[0]
            self.assertEqual(len(probs), 965)
            # Mass below one step (1/256) quantises to 0, so the sum lands a
            # little under 1 — the flatter the distribution, the more is lost
            # (0.71 on the background crop, 0.92+ on the species) — never above.
            self.assertGreater(sum(probs), 0.6)
            self.assertLessEqual(sum(probs), 1.0 + 1e-6)
            self.assertTrue(all(0.0 <= p <= 1.0 for p in probs))

    def test_dequantised_top1_is_the_onnx_survivors(self):
        for frame in _SPECIES:
            probs = _dequant(frame)[0]
            top = max(range(len(probs)), key=probs.__getitem__)
            self.assertEqual(top, frame["onnxTop1Index"], frame["crop"])
            self.assertAlmostEqual(probs[top], frame["onnxTop1Score"], delta=_SCORE_TOLERANCE)
            self.assertGreaterEqual(probs[top], _STEP_GATE)


@unittest.skipUnless(_HAS_REAL_NUMPY, "softmax.py needs numpy")
class BirdEdgetpuSoftmax(unittest.TestCase):
    def _classify(self, frame, output_probabilities=True):
        import numpy as np
        from softmax import postprocess_softmax

        tensor = np.array(_dequant(frame), dtype=np.float32)
        config = {"labels": [str(i) for i in range(965)], "outputProbabilities": output_probabilities}
        return postprocess_softmax({"0": tensor}, config, 224, 224, 1.0, (0, 0))["classifications"]

    def test_species_crop_emits_the_onnx_species_above_the_step_gate(self):
        for frame in _SPECIES:
            top = self._classify(frame)[0]
            self.assertEqual(top["class"], str(frame["onnxTop1Index"]), frame["crop"])
            self.assertGreaterEqual(top["score"], _STEP_GATE)

    def test_background_crop_tops_out_as_background(self):
        # The step rejects `background` downstream (rejectClasses); the
        # postprocessor must still name it, not a species.
        top = self._classify(_BACKGROUND_FRAMES[0])[0]
        self.assertEqual(top["class"], str(_BACKGROUND))

    def test_re_softmax_would_sink_every_species_below_the_gate(self):
        # Why the catalog sets outputProbabilities on this entry.
        for frame in _SPECIES:
            # Flattened so far that nothing clears the postprocessor's 0.01 floor.
            ranked = self._classify(frame, output_probabilities=False)
            self.assertTrue(all(c["score"] < _STEP_GATE for c in ranked))


if __name__ == "__main__":
    unittest.main()
