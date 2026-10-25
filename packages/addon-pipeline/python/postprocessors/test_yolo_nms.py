"""NMS IoU threshold is config-driven (#4), with the 0.45 literal as fallback."""
import numpy as np
from yolo import postprocess_yolo


def _two_overlapping_persons() -> dict:
    """A raw YOLO tensor [4+numClasses, numBoxes] with numClasses=1 (person).

    Two heavily-overlapping person boxes:
      A = xyxy(30,30,70,70) score 0.9
      B = xyxy(35,35,75,75) score 0.8
    IoU(A,B) = 1225 / 1975 ≈ 0.62 → suppressed at 0.45, kept at 0.9.
    """
    # rows: cx, cy, w, h, person_score ; cols: 2 boxes
    tensor = np.array(
        [
            [50.0, 55.0],  # cx
            [50.0, 55.0],  # cy
            [40.0, 40.0],  # w
            [40.0, 40.0],  # h
            [0.9, 0.8],    # person score (already in [0,1] → no sigmoid)
        ],
        dtype=np.float32,
    )
    return {"output": tensor}


_CONFIG_BASE = {"labels": ["person"], "numClasses": 1, "confidence": 0}


def test_default_nms_iou_suppresses_overlap():
    # No nmsIouThreshold in config → the 0.45 literal fallback → B is suppressed.
    out = postprocess_yolo(
        _two_overlapping_persons(), dict(_CONFIG_BASE), orig_w=200, orig_h=200, scale=1.0, pad=(0, 0)
    )
    assert len(out["detections"]) == 1


def test_high_nms_iou_keeps_both_boxes():
    # A high threshold (0.9) exceeds the ~0.62 overlap → both boxes survive.
    cfg = dict(_CONFIG_BASE, nmsIouThreshold=0.9)
    out = postprocess_yolo(
        _two_overlapping_persons(), cfg, orig_w=200, orig_h=200, scale=1.0, pad=(0, 0)
    )
    assert len(out["detections"]) == 2
