"""RF-DETR decode contract — the four ways this postprocessor silently breaks.

Run (from `packages/addon-pipeline/python/postprocessors`):

    python -m pytest test_rfdetr.py -q

Each test pins one property that produced (or would produce) an empty/wrong
detection list without any error being raised.
"""
import math

import numpy as np

from rfdetr import postprocess_rfdetr

# One query, one real class ⇒ `labels` is [1, N, 2]: column 0 = no-object,
# column 1 = package.
_CONFIG = {"labels": ["package"], "confidence": 0.5}


def _logit(p: float) -> float:
    return math.log(p / (1.0 - p))


def _outputs(boxes: list, logits: list) -> dict:
    """`dets` [1,N,4] cxcywh normalised + `labels` [1,N,2] RAW logits."""
    return {
        "dets": np.array([boxes], dtype=np.float32),
        "labels": np.array([logits], dtype=np.float32),
    }


def test_decodes_a_package_query_to_pixel_bbox():
    # Centred box, half the frame per side ⇒ 25% of the area (a real parcel).
    out = postprocess_rfdetr(
        _outputs([[0.5, 0.5, 0.5, 0.5]], [[_logit(0.01), _logit(0.93)]]),
        dict(_CONFIG),
        orig_w=200,
        orig_h=200,
        scale=1.0,
        pad=(0, 0),
    )
    assert len(out["detections"]) == 1
    det = out["detections"][0]
    assert det["class"] == "package"
    assert det["score"] == 0.93
    assert det["bbox"] == [50.0, 50.0, 150.0, 150.0]
    # The NMS scratch key never leaks into the StepOutput.
    assert "_xyxy" not in det


def test_column_zero_is_the_dead_no_object_slot():
    """THE trap: the upstream helper slices `logits[..., :-1]` (drops the LAST
    column). On this 2-wide head that keeps background and throws away package.

    A query whose BACKGROUND logit is high and whose PACKAGE logit is low must
    decode to nothing. If the slice were `[:-1]` this returns a 0.99 detection.
    """
    out = postprocess_rfdetr(
        _outputs([[0.5, 0.5, 0.3, 0.3]], [[_logit(0.99), _logit(0.02)]]),
        dict(_CONFIG),
        orig_w=200,
        orig_h=200,
        scale=1.0,
        pad=(0, 0),
    )
    assert out["detections"] == []


def test_out_of_range_normalised_box_is_clamped_not_dropped():
    """cxcywh is normalised but NOT sigmoid-bounded — edge queries exceed 1.0
    and go below 0. The box must clamp to the frame, not vanish and not produce
    negative / over-frame pixels."""
    out = postprocess_rfdetr(
        # cx 0.9, w 0.6 ⇒ x2 = 1.2 (> 1); cy 0.1, h 0.4 ⇒ y1 = -0.1 (< 0)
        _outputs([[0.9, 0.1, 0.6, 0.4]], [[_logit(0.01), _logit(0.80)]]),
        dict(_CONFIG),
        orig_w=100,
        orig_h=100,
        scale=1.0,
        pad=(0, 0),
    )
    assert len(out["detections"]) == 1
    x1, y1, x2, y2 = out["detections"][0]["bbox"]
    assert (x1, y1, x2, y2) == (60.0, 0.0, 100.0, 30.0)


def test_fully_out_of_frame_box_is_dropped():
    out = postprocess_rfdetr(
        _outputs([[1.6, 0.5, 0.2, 0.2]], [[_logit(0.01), _logit(0.90)]]),
        dict(_CONFIG),
        orig_w=100,
        orig_h=100,
        scale=1.0,
        pad=(0, 0),
    )
    assert out["detections"] == []


def test_whole_crop_query_is_rejected_by_the_area_guard():
    """The measured doormat failure mode: one query spanning ~the whole crop at
    0.33. Every real parcel was <= 25% of the crop, so > 60% is degenerate."""
    whole_crop = _outputs([[0.5, 0.5, 1.0, 1.0]], [[_logit(0.01), _logit(0.90)]])
    out = postprocess_rfdetr(
        whole_crop, dict(_CONFIG), orig_w=200, orig_h=200, scale=1.0, pad=(0, 0)
    )
    assert out["detections"] == []

    # …and the guard is config-driven, not a hard-coded reject: raise it above
    # 1.0 and the same query survives (proves the guard is what removed it).
    permissive = postprocess_rfdetr(
        whole_crop,
        dict(_CONFIG, maxAreaFraction=1.01),
        orig_w=200,
        orig_h=200,
        scale=1.0,
        pad=(0, 0),
    )
    assert len(permissive["detections"]) == 1


def test_confidence_threshold_is_applied_in_sigmoid_space():
    """Raw logits are NEGATIVE for a 0.6 probability — a decoder that compared
    the logit to the threshold would drop this. The gate runs post-sigmoid."""
    below = _outputs([[0.5, 0.5, 0.3, 0.3]], [[_logit(0.01), _logit(0.60)]])
    assert (
        postprocess_rfdetr(
            below, dict(_CONFIG, confidence=0.7), orig_w=200, orig_h=200, scale=1.0, pad=(0, 0)
        )["detections"]
        == []
    )
    kept = postprocess_rfdetr(
        below, dict(_CONFIG, confidence=0.5), orig_w=200, orig_h=200, scale=1.0, pad=(0, 0)
    )
    assert len(kept["detections"]) == 1
    assert kept["detections"][0]["score"] == 0.6


def test_duplicate_queries_are_suppressed_and_the_iou_is_config_driven():
    # A = xyxy(60,60,140,140), B = xyxy(70,70,150,150) ⇒ IoU ≈ 0.47.
    dup = _outputs(
        [[0.5, 0.5, 0.4, 0.4], [0.55, 0.55, 0.4, 0.4]],
        [[_logit(0.01), _logit(0.90)], [_logit(0.01), _logit(0.80)]],
    )
    default = postprocess_rfdetr(
        dup, dict(_CONFIG), orig_w=200, orig_h=200, scale=1.0, pad=(0, 0)
    )
    assert len(default["detections"]) == 1
    assert default["detections"][0]["score"] == 0.9

    loose = postprocess_rfdetr(
        dup, dict(_CONFIG, nmsIouThreshold=0.9), orig_w=200, orig_h=200, scale=1.0, pad=(0, 0)
    )
    assert len(loose["detections"]) == 2


def test_outputs_resolve_by_shape_when_the_names_are_stripped():
    named = _outputs([[0.5, 0.5, 0.4, 0.4]], [[_logit(0.01), _logit(0.90)]])
    anonymous = {"var_1": named["dets"], "var_2": named["labels"]}
    out = postprocess_rfdetr(
        anonymous, dict(_CONFIG), orig_w=200, orig_h=200, scale=1.0, pad=(0, 0)
    )
    assert len(out["detections"]) == 1


def test_a_labels_tensor_with_only_the_no_object_column_decodes_to_nothing():
    """A 1-wide head is background-only — slicing it must return empty, not raise."""
    out = postprocess_rfdetr(
        {
            "dets": np.array([[[0.5, 0.5, 0.4, 0.4]]], dtype=np.float32),
            "labels": np.array([[[_logit(0.99)]]], dtype=np.float32),
        },
        dict(_CONFIG),
        orig_w=200,
        orig_h=200,
        scale=1.0,
        pad=(0, 0),
    )
    assert out["detections"] == []


def test_registered_in_the_dispatch_table():
    """`inference_pool.py` resolves `slot_config['postprocessor']` through this
    table — an unregistered decoder raises "Unknown postprocessor: rfdetr" and
    the catalog entry is inert no matter how correct the decode is.

    Both sides import through the PACKAGE (`postprocessors.rfdetr`); the flat
    `from rfdetr import …` this file uses elsewhere is a distinct module object.
    """
    from postprocessors import POSTPROCESSORS
    from postprocessors.rfdetr import postprocess_rfdetr as registered

    assert POSTPROCESSORS["rfdetr"] is registered
