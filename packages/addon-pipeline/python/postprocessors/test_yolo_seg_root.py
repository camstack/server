"""D737 — a YOLO26-seg ROOT decodes its boxes exactly like the plain detector
and keeps one mask per kept detection.

Run like the other postprocessor tests:
``PYTHONPATH=postprocessors:. python -m pytest postprocessors/`` from
``packages/addon-pipeline/python``.
"""
import base64

import numpy as np

from postprocessors.yolo import postprocess_yolo
from postprocessors.yolo_seg import postprocess_yolo_seg

LABELS = ["person", "car", "dog"]
CONFIG = {"labels": LABELS, "numClasses": 3, "confidence": 0.3, "inputSize": 64}
# A 1280x720 frame letterboxed into 64: scale 0.05, vertical pad 14.
ORIG_W, ORIG_H, SCALE, PAD = 1280, 720, 0.05, (0, 14)
PROTO = 16  # P x P prototype grid at the 64 input (4 px per cell)


def _protos(rng: np.random.Generator) -> np.ndarray:
    return rng.normal(size=(1, 32, PROTO, PROTO)).astype(np.float32)


def _post_nms_rows(rng: np.random.Generator) -> np.ndarray:
    """[1, 6, 38]: two overlapping persons (the end-to-end head keeps both),
    a car, one row under the floor and two padding rows (class -1)."""
    boxes = [
        [8, 20, 24, 44, 0.91, 0],
        [10, 22, 26, 46, 0.80, 0],
        [30, 30, 56, 48, 0.66, 1],
        [40, 18, 50, 28, 0.10, 2],
        [0, 0, 0, 0, 0.0, -1],
        [0, 0, 0, 0, 0.0, -1],
    ]
    coeffs = rng.normal(size=(len(boxes), 32))
    return np.concatenate([np.array(boxes, dtype=np.float32), coeffs], axis=1)[None].astype(np.float32)


def _raw_head(rng: np.random.Generator) -> np.ndarray:
    """[1, 4 + 3 + 32, 5] with LOGIT scores (YOLO26 raw), two overlapping."""
    cxcywh = np.array(
        [[16, 32, 16, 24], [18, 34, 16, 24], [43, 39, 26, 18], [45, 23, 10, 10], [5, 5, 4, 4]],
        dtype=np.float32,
    ).T
    logits = np.array(
        [[3.0, 2.0, -4, -4, -6], [-4, -4, 1.5, -4, -6], [-4, -4, -4, -2.0, -6]], dtype=np.float32
    )
    coeffs = rng.normal(size=(32, 5)).astype(np.float32)
    return np.concatenate([cxcywh, logits, coeffs], axis=0)[None]


def _boxes(out: dict) -> list[tuple]:
    return [(d["class"], d["score"], tuple(d["bbox"])) for d in out["detections"]]


def test_post_nms_head_boxes_equal_the_plain_detectors():
    rng = np.random.default_rng(1)
    rows = _post_nms_rows(rng)
    plain = postprocess_yolo({"output0": rows[..., :6].copy()}, dict(CONFIG), ORIG_W, ORIG_H, SCALE, PAD)
    seg = postprocess_yolo_seg(
        {"output0": rows, "output1": _protos(rng)}, dict(CONFIG), ORIG_W, ORIG_H, SCALE, PAD
    )
    assert _boxes(seg) == _boxes(plain)
    # The plain detector does not NMS an end-to-end head; neither does the seg root.
    assert len(seg["detections"]) == 3


def test_raw_head_boxes_equal_the_plain_detectors():
    rng = np.random.default_rng(2)
    head = _raw_head(rng)
    plain = postprocess_yolo({"output0": head[:, :7, :].copy()}, dict(CONFIG), ORIG_W, ORIG_H, SCALE, PAD)
    seg = postprocess_yolo_seg(
        {"output0": head.copy(), "output1": _protos(rng)}, dict(CONFIG), ORIG_W, ORIG_H, SCALE, PAD
    )
    assert _boxes(seg) == _boxes(plain)
    assert len(seg["detections"]) == 2  # the overlap is suppressed, the floor drops two


def test_same_nms_iou_knob_as_the_plain_detector():
    rng = np.random.default_rng(3)
    head = _raw_head(rng)
    loose = dict(CONFIG, nmsIouThreshold=0.95)
    plain = postprocess_yolo({"output0": head[:, :7, :].copy()}, loose, ORIG_W, ORIG_H, SCALE, PAD)
    seg = postprocess_yolo_seg(
        {"output0": head.copy(), "output1": _protos(rng)}, loose, ORIG_W, ORIG_H, SCALE, PAD
    )
    assert _boxes(seg) == _boxes(plain)
    assert len(seg["detections"]) == 3


def test_every_kept_detection_carries_its_own_mask_over_its_box():
    rng = np.random.default_rng(4)
    rows = _post_nms_rows(rng)
    protos = _protos(rng)
    out = postprocess_yolo_seg({"output0": rows, "output1": protos}, dict(CONFIG), ORIG_W, ORIG_H, SCALE, PAD)
    first = out["detections"][0]
    # Box [8,20,24,44] in the 64 input → proto cells [2,5,6,11] → 4 x 6.
    assert (first["maskWidth"], first["maskHeight"]) == (4, 6)
    raw = np.frombuffer(base64.b64decode(first["mask"]), dtype=np.uint8)
    assert raw.size == 4 * 6
    assert set(np.unique(raw)) <= {0, 255}
    # The mask IS sigmoid(coeffs @ protos) > 0.5 over that window, for this row.
    logits = rows[0, 0, 6:] @ protos[0][:, 5:11, 2:6].reshape(32, -1)
    expected = ((1 / (1 + np.exp(-logits))) > 0.5).astype(np.uint8) * 255
    assert np.array_equal(raw, expected)
    # Different rows → different coefficient vectors → masks are per instance.
    assert out["detections"][1]["mask"] != first["mask"]
