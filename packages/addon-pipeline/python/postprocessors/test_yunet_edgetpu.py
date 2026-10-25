"""Pins the YuNet Coral build on REAL output tensors (D710 enforcement).

`yunet-2023mar` ships a `tflite` format compiled for the Edge TPU
(`camstack-yunet-2023mar_edgetpu.tflite`). Its twelve outputs are int8, each
with its own scale and zero point, and `cls_*`/`obj_*` have identical shapes.
Three things must hold for the face step to emit what the ONNX build emits:

- the edgetpu predict closure keys this postprocessor's outputs by tensor NAME
  (`edgetpu_output_keys`) — keyed "0".."11" the decoder cannot tell `cls_8`
  from `obj_8` and refuses the frame;
- every output is dequantised (`edgetpu_dequant`) — read raw, a "probability"
  is an integer in [-128, 127];
- the `yunet` decoder, at the model's own gate (0.85, D662), then finds the
  ONNX build's faces, boxes AND landmarks (face-align depends on them).

The fixture (`testdata/yunet_int8_outputs.json`) holds the raw outputs of the
int8 graph the Edge TPU file is compiled from, on the public
`reference-images/3-persons.jpg` letterboxed to 640, and the ONNX build's
detections on the same frame. Produced by `scripts/build-yunet-edgetpu.py`.

`unittest.TestCase`: the key and dequant cases run on CI's bare interpreter;
the decode cases need numpy (`yunet.py` imports it) and are skipped, by name,
without it.
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

with open(os.path.join(_HERE, "testdata", "yunet_int8_outputs.json"), encoding="utf-8") as _fh:
    _FIXTURE = json.load(_fh)

_OUTPUTS = _FIXTURE["outputs"]
_FRAME = _FIXTURE["frame"]
_STEP_GATE = 0.85  # yunet-2023mar.defaultConfidence (D662)
_NAMES = [f"{k}_{s}" for k in ("cls", "obj", "bbox", "kps") for s in (8, 16, 32)]


def _raw(name):
    """The int8 tensor as a flat list of ints — no numpy needed."""
    data = zlib.decompress(base64.b64decode(_OUTPUTS[name]["zlibB64"]))
    return [b - 256 if b > 127 else b for b in data]


def _dequant_list(name):
    o = _OUTPUTS[name]
    return dequant_edgetpu_output(_raw(name), dtype_name=o["dtype"], scale=o["scale"], zero_point=o["zeroPoint"])


def _iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


class YunetEdgetpuContract(unittest.TestCase):
    def test_fixture_is_the_shipped_contract(self):
        self.assertEqual(sorted(_OUTPUTS), sorted(_NAMES))
        for name, o in _OUTPUTS.items():
            self.assertEqual(o["dtype"], "int8", name)
        self.assertEqual(_OUTPUTS["cls_8"]["shape"], [1, 6400, 1])
        self.assertEqual(_OUTPUTS["kps_32"]["shape"], [1, 400, 10])
        self.assertGreaterEqual(len(_FIXTURE["onnxDetections"]), 3)

    def test_yunet_outputs_are_keyed_by_name(self):
        # The order the TFLite file lists them in is not the ONNX order.
        listed = list(_OUTPUTS)
        self.assertEqual(edgetpu_output_keys(listed, "yunet"), listed)

    def test_ssd_keeps_its_positional_keys(self):
        # ssd.py reads "0".."3"; TFLite_Detection_PostProcess names carry ":1".
        names = ["TFLite_Detection_PostProcess", "TFLite_Detection_PostProcess:1",
                 "TFLite_Detection_PostProcess:2", "TFLite_Detection_PostProcess:3"]
        self.assertEqual(edgetpu_output_keys(names, "ssd"), ["0", "1", "2", "3"])

    def test_unnamed_or_duplicate_outputs_stay_positional(self):
        self.assertEqual(edgetpu_output_keys(["cls_8", ""], "yunet"), ["0", "1"])
        self.assertEqual(edgetpu_output_keys(["cls_8", "cls_8"], "yunet"), ["0", "1"])

    def test_dequantised_probabilities_are_probabilities(self):
        for name in ("cls_8", "obj_8", "cls_32", "obj_32"):
            raw = _raw(name)
            self.assertLess(min(raw), 0, name)  # raw int8 is not a probability
            probs = _dequant_list(name)
            self.assertTrue(all(-1e-6 <= p <= 1.0 + 1e-6 for p in probs), name)


@unittest.skipUnless(_HAS_REAL_NUMPY, "yunet.py needs numpy")
class YunetEdgetpuDecode(unittest.TestCase):
    def _decode(self, keys):
        import numpy as np
        from yunet import postprocess_yunet

        preds = {}
        for key, name in zip(keys, _OUTPUTS):
            o = _OUTPUTS[name]
            raw = np.array(_raw(name), dtype=np.int8).reshape(o["shape"])
            preds[key] = dequant_edgetpu_output(raw, dtype_name="int8", scale=o["scale"], zero_point=o["zeroPoint"])
        config = {"confidence": _STEP_GATE, "inputSize": 640, "nmsIouThreshold": 0.45}
        return postprocess_yunet(preds, config, _FRAME["w"], _FRAME["h"], _FRAME["scale"],
                                 tuple(_FRAME["pad"]))["detections"]

    def test_the_int8_build_finds_the_onnx_faces(self):
        got = self._decode(edgetpu_output_keys(list(_OUTPUTS), "yunet"))
        ref = _FIXTURE["onnxDetections"]
        self.assertEqual(len(got), len(ref))
        for r in ref:
            best = max(got, key=lambda g: _iou(g["bbox"], r["bbox"]))
            self.assertGreaterEqual(_iou(best["bbox"], r["bbox"]), 0.9)
            self.assertAlmostEqual(best["score"], r["score"], delta=0.03)
            diag = ((r["bbox"][2] - r["bbox"][0]) ** 2 + (r["bbox"][3] - r["bbox"][1]) ** 2) ** 0.5
            errors = [((p["x"] - q["x"]) ** 2 + (p["y"] - q["y"]) ** 2) ** 0.5
                      for p, q in zip(best["landmarks"], r["landmarks"])]
            # face-align reads these. The build's parity pass measured a mean
            # point error of 1.1% of the face diagonal (p95 2.8%) on 110 faces.
            self.assertLess(sum(errors) / len(errors), 0.03 * diag)
            self.assertLess(max(errors), 0.05 * diag)

    def test_positional_keys_are_refused_not_misdecoded(self):
        with self.assertRaises(ValueError):
            self._decode([str(i) for i in range(len(_OUTPUTS))])

    def test_a_vectorised_dequant_matches_the_list_walk(self):
        import numpy as np

        o = _OUTPUTS["bbox_8"]
        arr = dequant_edgetpu_output(np.array(_raw("bbox_8"), dtype=np.int8), dtype_name="int8",
                                     scale=o["scale"], zero_point=o["zeroPoint"])
        self.assertEqual(str(arr.dtype), "float32")
        self.assertTrue(np.allclose(arr, np.array(_dequant_list("bbox_8"), dtype=np.float32), atol=1e-6))


if __name__ == "__main__":
    unittest.main()
