"""Tests for the YOLO-NAS (flat NMS export) postprocessor.

plus catalog's YOLO-NAS ONNX exports (super-gradients ``model.export()`` with fused
batched NMS, the format plus catalog ships) emit ONE flat output tensor of shape
``[N, 7]`` where each row is ``(batch_index, x1, y1, x2, y2, score, class_id)``
in INPUT pixel space, post-NMS. Empty GPU slots carry a negative class id.
"""
import numpy as np

from postprocessors import POSTPROCESSORS
from postprocessors.yolonas import postprocess_yolonas


PLUS_CATALOG_LABELS = ["person", "car", "dog"]


def _run(output, config=None, orig_w=1280, orig_h=720, scale=0.25, pad=(0, 70)):
    cfg = {"labels": PLUS_CATALOG_LABELS, "confidence": 0.3}
    if config:
        cfg.update(config)
    return postprocess_yolonas({"output0": output}, cfg, orig_w, orig_h, scale, pad)


def test_registered_in_dispatch_table():
    assert POSTPROCESSORS["yolonas"] is postprocess_yolonas


def test_decodes_flat_rows_and_undoes_letterbox():
    # One person box at input-space (100, 120) → (200, 220), score 0.9.
    out = np.array(
        [
            [0, 100.0, 120.0, 200.0, 220.0, 0.9, 0],
        ],
        dtype=np.float32,
    )
    result = _run(out)
    assert result["kind"] == "detections"
    dets = result["detections"]
    assert len(dets) == 1
    det = dets[0]
    assert det["class"] == "person"
    assert det["score"] == 0.9
    # Undo letterbox: (x - pad_x) / scale, (y - pad_y) / scale
    x1, y1, x2, y2 = det["bbox"]
    assert x1 == 400.0  # (100 - 0) / 0.25
    assert y1 == 200.0  # (120 - 70) / 0.25
    assert x2 == 800.0
    assert y2 == 600.0


def test_drops_below_confidence_and_negative_class():
    out = np.array(
        [
            [0, 10, 10, 20, 20, 0.2, 0],  # below floor
            [0, 10, 10, 20, 20, 0.9, -1],  # empty slot (negative class)
            [0, 10, 10, 20, 20, 0.8, 1],  # kept
        ],
        dtype=np.float32,
    )
    dets = _run(out)["detections"]
    assert len(dets) == 1
    assert dets[0]["class"] == "car"


def test_accepts_batched_3d_shape():
    out = np.array([[[0, 10, 10, 20, 20, 0.8, 2]]], dtype=np.float32)
    dets = _run(out)["detections"]
    assert len(dets) == 1
    assert dets[0]["class"] == "dog"


def test_out_of_range_class_uses_index_string():
    out = np.array([[0, 10, 10, 20, 20, 0.8, 7]], dtype=np.float32)
    dets = _run(out)["detections"]
    assert dets[0]["class"] == "7"


def test_clamps_to_original_frame():
    out = np.array([[0, -50, 0, 5000, 5000, 0.9, 0]], dtype=np.float32)
    dets = _run(out)["detections"]
    x1, y1, x2, y2 = dets[0]["bbox"]
    assert x1 >= 0 and y1 >= 0
    assert x2 <= 1280 and y2 <= 720
