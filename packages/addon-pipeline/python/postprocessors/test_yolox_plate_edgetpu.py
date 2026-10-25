"""Pins the YOLOX-tiny plate Coral build on REAL output tensors (D710 enforcement).

`yolox-tiny-plate` ships a `tflite` format compiled for the Edge TPU
(`camstack-yolox-tiny-plate_edgetpu.tflite`). Unlike its other builds — which
bake YOLOX's grid decode into the graph and emit the YOLOv8 layout — the Coral
graph stops at the raw head (an `Exp` and a coordinate Concat would share one
int8 scale between pixels and probabilities): per stride, `reg_s` (dx, dy,
log w, log h) and `score_s` (obj*cls), NHWC, int8. Three things must hold for
the step to emit the box the ONNX build emits:

- the edgetpu predict closure keys the `yolo` postprocessor's outputs by
  tensor NAME (`edgetpu_output_keys`) — the head is found by its names;
- every output is dequantised (`edgetpu_dequant`);
- `yolo.py`'s `yolox_head_to_v8` decodes the head (row-major cells, centre =
  (offset + cell) * stride, size = exp(log) * stride) into the layout the rest
  of the postprocessor already reads.

The fixture (`testdata/yolox_plate_int8_outputs.json`) holds the raw outputs of
the int8 graph the Edge TPU file is compiled from, on the public
`reference-images/1-car-plate.jpg` letterboxed to 640, and the published ONNX
build's detections on the same frame. Produced by
`scripts/build-yolox-plate-edgetpu.py`.

`unittest.TestCase`: the key and dequant cases run on CI's bare interpreter;
the decode cases need numpy and are skipped, by name, without it.
"""
import base64
import json
import os
import sys
import unittest
import zlib

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))  # edgetpu_dequant lives one level up

from edgetpu_dequant import dequant_edgetpu_output, edgetpu_output_keys  # noqa: E402

try:
    import numpy as _numpy_probe
except ImportError:
    _numpy_probe = None
_HAS_REAL_NUMPY = _numpy_probe is not None and hasattr(_numpy_probe, "ndarray")

with open(os.path.join(_HERE, "testdata", "yolox_plate_int8_outputs.json"), encoding="utf-8") as _fh:
    _FIXTURE = json.load(_fh)

_OUTPUTS = _FIXTURE["outputs"]
_FRAME = _FIXTURE["frame"]
_STEP_GATE = 0.5  # plate-detection.defaultConfidence
_HEAD = ["reg_8", "score_8", "reg_16", "score_16", "reg_32", "score_32"]


def _raw(name):
    data = zlib.decompress(base64.b64decode(_OUTPUTS[name]["zlibB64"]))
    return [b - 256 if b > 127 else b for b in data]


def _iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


class YoloxPlateEdgetpuContract(unittest.TestCase):
    def test_fixture_is_the_shipped_contract(self):
        self.assertEqual(sorted(_OUTPUTS), sorted(_HEAD))
        self.assertEqual(_OUTPUTS["reg_8"]["shape"], [1, 80, 80, 4])
        self.assertEqual(_OUTPUTS["score_32"]["shape"], [1, 20, 20, 1])
        for name, o in _OUTPUTS.items():
            self.assertEqual(o["dtype"], "int8", name)
        self.assertEqual(len(_FIXTURE["onnxDetections"]), 1)

    def test_the_yolo_postprocessor_gets_named_outputs_on_the_coral(self):
        listed = list(_OUTPUTS)
        self.assertEqual(edgetpu_output_keys(listed, "yolo"), listed)

    def test_dequantised_scores_are_probabilities(self):
        for name in ("score_8", "score_16", "score_32"):
            o = _OUTPUTS[name]
            probs = dequant_edgetpu_output(_raw(name), dtype_name="int8", scale=o["scale"], zero_point=o["zeroPoint"])
            self.assertTrue(all(-1e-6 <= p <= 1.0 + 1e-6 for p in probs), name)


@unittest.skipUnless(_HAS_REAL_NUMPY, "yolo.py needs numpy")
class YoloxPlateEdgetpuDecode(unittest.TestCase):
    def _decode(self, keys):
        import numpy as np
        from yolo import postprocess_yolo

        preds = {}
        for key, name in zip(keys, _OUTPUTS):
            o = _OUTPUTS[name]
            raw = np.array(_raw(name), dtype=np.int8).reshape(o["shape"])
            preds[key] = dequant_edgetpu_output(raw, dtype_name="int8", scale=o["scale"], zero_point=o["zeroPoint"])
        config = {"confidence": _STEP_GATE, "labels": ["plate"], "numClasses": 1, "nmsIouThreshold": 0.45,
                  "inputSize": 640}
        return postprocess_yolo(preds, config, _FRAME["w"], _FRAME["h"], _FRAME["scale"],
                                tuple(_FRAME["pad"]))["detections"]

    def test_the_int8_head_decodes_to_the_onnx_plate(self):
        got = self._decode(edgetpu_output_keys(list(_OUTPUTS), "yolo"))
        ref = _FIXTURE["onnxDetections"]
        self.assertEqual(len(got), len(ref))
        self.assertEqual(got[0]["class"], "plate")
        self.assertGreaterEqual(_iou(got[0]["bbox"], ref[0]["bbox"]), 0.9)
        self.assertAlmostEqual(got[0]["score"], ref[0]["score"], delta=0.05)

    def test_a_head_sized_for_another_input_is_refused(self):
        import numpy as np
        from yolo import yolox_head_to_v8

        preds = {name: np.zeros(_OUTPUTS[name]["shape"], dtype=np.float32) for name in _OUTPUTS}
        with self.assertRaises(ValueError):
            yolox_head_to_v8(preds, 416)

    def test_positional_keys_never_reach_the_head_decode(self):
        from yolo import yolox_head_to_v8

        self.assertIsNone(yolox_head_to_v8({str(i): None for i in range(6)}, 640))


if __name__ == "__main__":
    unittest.main()
