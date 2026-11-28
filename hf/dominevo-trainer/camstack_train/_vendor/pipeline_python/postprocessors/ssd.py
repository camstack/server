"""SSD / EfficientDet-Lite postprocessor (TFLite_Detection_PostProcess op).

Used by the EdgeTPU (Coral USB Edge TPU) runtime with the Coral model-zoo
SSD MobileNet V2 and EfficientDet-Lite detectors. Those models embed the
``TFLite_Detection_PostProcess`` op, so the 4 output tensors are ALREADY
decoded (boxes + per-box class + score, post-NMS):

    output 0  boxes    [1, N, 4]  (ymin, xmin, ymax, xmax) normalised 0..1
    output 1  classes  [1, N]     float class indices (COCO 90-class map,
                                     or the model's own label list when the
                                     descriptor carries one)
    output 2  scores   [1, N]     float 0..1
    output 3  count    [1]        number of valid detections

The inference_pool ``edgetpu`` predict closure returns them keyed by their
positional output index ("0".."3"). Output matches the yolo postprocessor:
``{"kind": "detections", "detections": [{"class", "score", "bbox":[x1,y1,x2,y2]}]}``
with pixel bboxes in ORIGINAL frame coordinates.

The same layout, verified per model on the upstream graph (2026-09-26):

    ssd-mobilenet-v2-coco-edgetpu    300x300 uint8, N=20
    efficientdet-lite0-edgetpu       320x320 uint8, N=25
    ssdlite-mobiledet-coco-edgetpu   320x320 uint8, N=100, 91 score columns
                                     (background + COCO-90), so the emitted
                                     class index is already 0-based: 0 = person

The decode is plain Python over nested lists. Each tensor is turned into a list
once (``ndarray.tolist()``), so this module needs no numpy: CI's self-hosted
runner has none, and the MobileDet fixture test (``test_ssd.py``) must run
there, not be skipped there. Measured: ~85 µs per frame against ~14 µs for
the old numpy decode (about 6×), under 1% of a core at 100 fps and small next
to a ~9 ms Coral invoke.
"""
from __future__ import annotations

from typing import Any

# Coral COCO 90-class label map (github.com/google-coral/test_data coco_labels.txt).
# The "n/a" placeholders keep the raw model class indices aligned and are skipped.
COCO_90 = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
    "boat", "traffic light", "fire hydrant", "n/a", "stop sign", "parking meter",
    "bench", "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear",
    "zebra", "giraffe", "n/a", "backpack", "umbrella", "n/a", "n/a", "handbag",
    "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite",
    "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
    "bottle", "n/a", "wine glass", "cup", "fork", "knife", "spoon", "bowl",
    "banana", "apple", "sandwich", "orange", "broccoli", "carrot", "hot dog",
    "pizza", "donut", "cake", "chair", "couch", "potted plant", "bed", "n/a",
    "dining table", "n/a", "n/a", "toilet", "n/a", "tv", "laptop", "mouse",
    "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "n/a", "book", "clock", "vase", "scissors", "teddy bear",
    "hair drier", "toothbrush",
]


def _as_list(value: Any) -> Any:
    """A tensor as nested Python lists (a scalar stays a scalar)."""
    return value.tolist() if hasattr(value, "tolist") else value


def _shape(value: Any) -> tuple:
    """numpy-style shape of a nested list; ``()`` for a scalar."""
    dims: list[int] = []
    while isinstance(value, (list, tuple)):
        dims.append(len(value))
        if not value:
            break
        value = value[0]
    return tuple(dims)


def _flatten(value: Any) -> list:
    """Every scalar of a nested list, in row-major order (``reshape(-1)``)."""
    if not isinstance(value, (list, tuple)):
        return [value]
    flat: list = []
    for item in value:
        flat.extend(_flatten(item))
    return flat


def _rows_of_4(value: Any) -> list:
    """``reshape(-1, 4)`` of a nested list; refuses a size numpy would refuse."""
    flat = _flatten(value)
    if len(flat) % 4 != 0:
        raise ValueError(f"cannot reshape {len(flat)} box values into rows of 4")
    return [flat[i:i + 4] for i in range(0, len(flat), 4)]


def _split_outputs(predictions: dict) -> tuple:
    """Resolve (boxes, classes, scores, count) from the raw prediction dict.

    Primary path: positional keys "0".."3" (the edgetpu predict closure).
    Fallback: shape-based identification for name-keyed / reordered exports.
    """
    if all(k in predictions for k in ("0", "1", "2", "3")):
        return (
            _as_list(predictions["0"]),
            _as_list(predictions["1"]),
            _as_list(predictions["2"]),
            _as_list(predictions["3"]),
        )
    vals = [_as_list(v) for v in predictions.values()]
    boxes = count = None
    two_d: list = []
    for v in vals:
        shape = _shape(v)
        ndim = len(shape)
        if ndim >= 2 and shape[-1] == 4:
            boxes = v
        elif ndim == 1 or (ndim == 2 and shape[-1] == 1):
            count = v
        elif ndim == 2:
            two_d.append(v)
    # TFLite_Detection_PostProcess emits classes BEFORE scores.
    classes = two_d[0] if len(two_d) > 0 else None
    scores = two_d[1] if len(two_d) > 1 else None
    return boxes, classes, scores, count


def label_for_class(cls: int, labels: list | None = None) -> str:
    """Class name for a raw index; default map is COCO-90 when labels is absent/empty."""
    if labels:
        return labels[cls] if 0 <= cls < len(labels) else str(cls)
    return COCO_90[cls] if 0 <= cls < len(COCO_90) else str(cls)


def postprocess_ssd(
    predictions: dict,
    config: dict,
    orig_w: int,
    orig_h: int,
    scale: float,
    pad: tuple,
) -> dict:
    """Decode SSD/EfficientDet postprocess outputs to original-frame detections."""
    conf_threshold = float(config.get("confidence", 0.4) or 0.4)
    input_size = int(config.get("inputSize", 300) or 300)
    raw_labels = config.get("labels")
    label_map: list | None = (
        list(raw_labels) if isinstance(raw_labels, list) and len(raw_labels) > 0 else None
    )

    boxes, classes, scores, count = _split_outputs(predictions)
    if boxes is None or scores is None:
        return {"kind": "detections", "detections": []}

    boxes = _rows_of_4(boxes)
    scores = _flatten(scores)
    classes = _flatten(classes) if classes is not None else [0.0] * len(scores)
    n = len(scores)
    count_flat = _flatten(count) if count is not None else []
    if count_flat:
        n = min(n, int(count_flat[0]))
    n = min(n, len(boxes), len(classes))

    pad_x, pad_y = pad
    is_letterbox = not (abs(scale - 1.0) < 1e-6 and pad_x == 0 and pad_y == 0)

    detections = []
    for i in range(n):
        score = float(scores[i])
        if score < conf_threshold:
            continue
        ymin, xmin, ymax, xmax = (float(v) for v in boxes[i])
        if is_letterbox:
            # Invert letterbox: normalised -> input px -> remove pad -> unscale.
            x1 = (xmin * input_size - pad_x) / scale
            y1 = (ymin * input_size - pad_y) / scale
            x2 = (xmax * input_size - pad_x) / scale
            y2 = (ymax * input_size - pad_y) / scale
        else:
            # Plain resize: normalised coords map linearly to the original frame.
            x1, y1, x2, y2 = xmin * orig_w, ymin * orig_h, xmax * orig_w, ymax * orig_h
        x1 = max(0.0, min(x1, orig_w))
        x2 = max(0.0, min(x2, orig_w))
        y1 = max(0.0, min(y1, orig_h))
        y2 = max(0.0, min(y2, orig_h))
        if x2 <= x1 or y2 <= y1:
            continue
        label = label_for_class(int(classes[i]), label_map)
        if label == "n/a":
            continue
        detections.append({
            "class": label,
            "score": round(score, 4),
            "bbox": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
        })

    return {"kind": "detections", "detections": detections}
