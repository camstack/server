"""YOLO v8/v9/v11 postprocessor.

Input: raw predictions dict from CoreML/OpenVINO/ONNX
Output: {"kind": "detections", "detections": [{"class", "score", "bbox": [x1,y1,x2,y2]}]}

Handles both standard and built-in NMS outputs.
"""
import numpy as np

COCO_80 = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck",
    "boat", "traffic light", "fire hydrant", "stop sign", "parking meter", "bench",
    "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra",
    "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove",
    "skateboard", "surfboard", "tennis racket", "bottle", "wine glass", "cup",
    "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
    "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
    "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink",
    "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier",
    "toothbrush",
]


def _iou(a: tuple, b: tuple) -> float:
    """IoU between two boxes (x1, y1, x2, y2)."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    if inter == 0:
        return 0.0
    area_a = (ax2 - ax1) * (ay2 - ay1)
    area_b = (bx2 - bx1) * (by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _nms(boxes: list[dict], iou_threshold: float = 0.45) -> list[dict]:
    """Non-maximum suppression. Input: list of {bbox, score, class}."""
    if not boxes:
        return []
    sorted_boxes = sorted(boxes, key=lambda b: b["score"], reverse=True)
    kept = []
    suppressed = set()
    for i, box in enumerate(sorted_boxes):
        if i in suppressed:
            continue
        kept.append(box)
        for j in range(i + 1, len(sorted_boxes)):
            if j in suppressed:
                continue
            if _iou(box["_xyxy"], sorted_boxes[j]["_xyxy"]) > iou_threshold:
                suppressed.add(j)
    return kept


# The raw YOLOX head of the `yolox-tiny-plate` Edge TPU build (D710): the
# graph stops before YOLOX's grid decode (an `Exp` and a coordinate Concat would
# share one int8 scale between pixel coordinates and probabilities) and emits,
# per stride s, `reg_s` = (dx, dy, log w, log h) in stride units and
# `score_s` = obj*cls, NHWC as the TFLite file stores them. Decoded here to the
# YOLOv8 layout every other build of the model already emits, so the rest of
# this postprocessor is shared. Only the Edge TPU file carries these names.
YOLOX_HEAD_STRIDES: tuple[int, ...] = (8, 16, 32)


def yolox_head_keys() -> list[str]:
    return [f"{kind}_{s}" for s in YOLOX_HEAD_STRIDES for kind in ("reg", "score")]


def yolox_head_to_v8(predictions: dict, input_size: int) -> "np.ndarray | None":
    """``[1, 5, N]`` (cx, cy, w, h, score) from a raw YOLOX head, or ``None``
    when ``predictions`` is not one. RAISES on a head sized for another input:
    decoding it would put every prior in the wrong cell."""
    if not all(k in predictions for k in yolox_head_keys()):
        return None
    columns = []
    for s in YOLOX_HEAD_STRIDES:
        n = input_size // s
        reg = np.asarray(predictions[f"reg_{s}"], dtype=np.float32).reshape(-1)
        score = np.asarray(predictions[f"score_{s}"], dtype=np.float32).reshape(-1)
        if reg.size != n * n * 4 or score.size != n * n:
            raise ValueError(
                f"yolox head: stride {s} has {reg.size} reg / {score.size} score values, "
                f"expected {n * n * 4} / {n * n} for inputSize {input_size}"
            )
        reg = reg.reshape(n, n, 4)
        rows, cols = np.meshgrid(np.arange(n, dtype=np.float32), np.arange(n, dtype=np.float32), indexing="ij")
        cx = (reg[..., 0] + cols) * s
        cy = (reg[..., 1] + rows) * s
        w = np.exp(reg[..., 2]) * s
        h = np.exp(reg[..., 3]) * s
        columns.append(np.stack([cx, cy, w, h, score.reshape(n, n)], axis=0).reshape(5, -1))
    return np.concatenate(columns, axis=1)[np.newaxis]


def _postprocess_coreml_nms(
    predictions: dict,
    config: dict,
    orig_w: int,
    orig_h: int,
    input_size: int,
) -> dict:
    """Handle CoreML models with built-in NMS.

    CoreML NMS output has two tensors:
      - 'confidence': (N, numClasses) — class scores post-NMS
      - 'coordinates': (N, 4) — [cx, cy, w, h] normalized to input image size
    """
    conf_threshold = float(config.get("confidence", 0))
    labels = config.get("labels", COCO_80)

    confidence = np.array(predictions["confidence"])
    coordinates = np.array(predictions["coordinates"])

    if confidence.ndim == 1:
        confidence = confidence.reshape(1, -1)
    if coordinates.ndim == 1:
        coordinates = coordinates.reshape(1, -1)

    detections = []
    for i in range(confidence.shape[0]):
        best_class = int(np.argmax(confidence[i]))
        best_score = float(confidence[i, best_class])

        if best_score < conf_threshold:
            continue

        # CoreML coordinates: [cx, cy, w, h] normalized to input_size
        cx, cy, bw, bh = coordinates[i]
        # Scale to input pixel coords
        cx_px = cx * input_size
        cy_px = cy * input_size
        bw_px = bw * input_size
        bh_px = bh * input_size

        x1 = cx_px - bw_px / 2
        y1 = cy_px - bh_px / 2
        x2 = cx_px + bw_px / 2
        y2 = cy_px + bh_px / 2

        # Map back to original image coords (undo letterbox)
        # CoreML imageType with letterbox: the model sees the padded image
        # so we need to figure out the letterbox transform
        scale = input_size / max(orig_w, orig_h)
        new_w = int(orig_w * scale)
        new_h = int(orig_h * scale)
        pad_x = (input_size - new_w) / 2
        pad_y = (input_size - new_h) / 2

        ox1 = max(0, min(orig_w, (x1 - pad_x) / scale))
        oy1 = max(0, min(orig_h, (y1 - pad_y) / scale))
        ox2 = max(0, min(orig_w, (x2 - pad_x) / scale))
        oy2 = max(0, min(orig_h, (y2 - pad_y) / scale))

        label = labels[best_class] if best_class < len(labels) else str(best_class)
        detections.append({
            "class": label,
            "score": round(best_score, 4),
            "bbox": [round(ox1, 1), round(oy1, 1), round(ox2, 1), round(oy2, 1)],
        })

    return {"kind": "detections", "detections": detections}


def _postprocess_yolo11_nms(
    output: np.ndarray,
    config: dict,
    orig_w: int,
    orig_h: int,
    scale: float,
    pad: tuple[int, int],
) -> dict:
    """Handle YOLO11/v26 post-NMS output: [N, 6] — (x1, y1, x2, y2, score, class_id).

    Coordinates are in input pixel space (0..inputSize). Already post-NMS.
    """
    rows = decode_yolo11_nms_rows(output, config, orig_w, orig_h, scale, pad)
    return {"kind": "detections", "detections": [d for _, d in rows]}


def decode_yolo11_nms_rows(
    output: np.ndarray,
    config: dict,
    orig_w: int,
    orig_h: int,
    scale: float,
    pad: tuple[int, int],
) -> list[tuple[int, dict]]:
    """The post-NMS box decode, each kept detection paired with its ROW in
    ``output``. Only the first 6 columns are read, so a seg head's
    ``[N, 6 + 32]`` rows decode exactly like the plain detector's ``[N, 6]``
    (D737) and the row index finds the detection's mask coefficients."""
    conf_threshold = float(config.get("confidence", 0))
    labels = config.get("labels", COCO_80)

    detections: list[tuple[int, dict]] = []
    for i in range(output.shape[0]):
        x1, y1, x2, y2, score, class_id = output[i][:6]
        score = float(score)
        if score < conf_threshold:
            continue
        class_id = int(class_id)
        if class_id < 0:
            continue

        # Transform from letterbox pixel coords to original image
        ox1 = max(0, min(orig_w, (float(x1) - pad[0]) / scale))
        oy1 = max(0, min(orig_h, (float(y1) - pad[1]) / scale))
        ox2 = max(0, min(orig_w, (float(x2) - pad[0]) / scale))
        oy2 = max(0, min(orig_h, (float(y2) - pad[1]) / scale))

        label = labels[class_id] if class_id < len(labels) else str(class_id)
        detections.append((i, {
            "class": label,
            "score": round(score, 4),
            "bbox": [round(ox1, 1), round(oy1, 1), round(ox2, 1), round(oy2, 1)],
        }))

    return detections


def postprocess_yolo(
    predictions: dict,
    config: dict,
    orig_w: int,
    orig_h: int,
    scale: float,
    pad: tuple[int, int],
) -> dict:
    """Postprocess YOLO output to structured detections.

    Handles two formats:
    1. Raw tensor (ONNX/OpenVINO): [4+numClasses, numBoxes] — needs NMS
    2. CoreML built-in NMS: 'confidence' + 'coordinates' tensors — already post-NMS
    """
    labels = config.get("labels", COCO_80)
    num_classes = config.get("numClasses", len(labels))

    yolox = yolox_head_to_v8(predictions, int(config.get("inputSize", 640)))
    if yolox is not None:
        predictions = {"output0": yolox}

    # Detect CoreML NMS output format
    if "confidence" in predictions and "coordinates" in predictions:
        input_size = config.get("inputSize", 640)
        return _postprocess_coreml_nms(predictions, config, orig_w, orig_h, input_size)

    # Detect YOLO11/v26 post-NMS format: [batch, N, 6] — (x1, y1, x2, y2, score, class_id)
    first_arr = np.array(list(predictions.values())[0])
    if first_arr.ndim == 3:
        first_arr = first_arr[0]  # remove batch dim
    if first_arr.ndim == 2 and first_arr.shape[1] == 6:
        return _postprocess_yolo11_nms(first_arr, config, orig_w, orig_h, scale, pad)

    # Raw tensor path (ONNX / OpenVINO / CoreML without NMS)
    output = None
    for key, val in predictions.items():
        arr = np.array(val)
        if arr.ndim >= 2 and any(d in (4 + num_classes, 84, 116, 144) for d in arr.shape):
            output = arr
            break
    if output is None:
        output = np.array(list(predictions.values())[0])

    # Handle various shapes
    if output.ndim == 3:
        output = output[0]  # remove batch dim

    # YOLO output: [4+numClasses, numBoxes] or [numBoxes, 4+numClasses]
    if output.shape[0] == 4 + num_classes:
        pass  # already [C, N]
    elif output.shape[1] == 4 + num_classes:
        output = output.T  # transpose to [C, N]
    else:
        # Try to infer
        if output.shape[0] < output.shape[1]:
            pass  # likely [C, N]
        else:
            output = output.T

    rows = decode_raw_yolo_columns(output, config, orig_w, orig_h, scale, pad)
    return {"kind": "detections", "detections": [d for _, d in rows]}


def decode_raw_yolo_columns(
    output: np.ndarray,
    config: dict,
    orig_w: int,
    orig_h: int,
    scale: float,
    pad: tuple[int, int],
) -> list[tuple[int, dict]]:
    """The raw-head box decode (``[4 + numClasses (+ extra), numBoxes]``, one
    COLUMN per candidate): sigmoid when the scores are logits, confidence
    floor, NMS. Each kept detection is paired with its column in ``output``.
    Rows past ``4 + numClasses`` are never read, so a seg head's mask
    coefficients ride along untouched and decode exactly like the plain
    detector (D737). May apply the sigmoid IN PLACE on the class rows."""
    conf_threshold = float(config.get("confidence", 0))
    labels = config.get("labels", COCO_80)
    num_classes = config.get("numClasses", len(labels))
    # NMS IoU from the step config (operator slider); the 0.45 literal stays as
    # the fallback so an unset value is byte-identical to today (#4).
    nms_iou = float(config.get("nmsIouThreshold", 0.45))

    num_boxes = output.shape[1]

    # Detect if scores are raw logits (YOLO11/v26) vs sigmoid-activated (YOLOv8/v9).
    # Sigmoid-activated scores are in [0, 1]. If any class score exceeds 1.0,
    # the model outputs raw logits and we need to apply sigmoid.
    sample_scores = output[4:4 + num_classes, :min(100, num_boxes)]
    needs_sigmoid = float(np.max(sample_scores)) > 1.0 or float(np.min(sample_scores)) < 0.0
    if needs_sigmoid:
        # Apply sigmoid to all class scores in-place (rows 4..4+numClasses)
        output[4:4 + num_classes, :] = 1.0 / (1.0 + np.exp(-np.clip(output[4:4 + num_classes, :], -50, 50)))

    # Vectorised candidate extraction — replaces the per-box Python loop
    # that took ~20ms on 8400 boxes. Pure numpy: ~0.5ms.
    class_scores = output[4:4 + num_classes, :]            # (C, N)
    best_classes = np.argmax(class_scores, axis=0)         # (N,)
    best_scores = class_scores[best_classes, np.arange(num_boxes)]  # (N,)
    mask = best_scores >= conf_threshold
    if not np.any(mask):
        return []

    # Gather only above-threshold boxes
    idxs = np.nonzero(mask)[0]
    cx = output[0, idxs]
    cy = output[1, idxs]
    bw = output[2, idxs]
    bh = output[3, idxs]
    sc = best_scores[idxs]
    cl = best_classes[idxs]

    # Centre → corner, letterbox → original coords
    x1 = np.clip((cx - bw / 2 - pad[0]) / scale, 0, orig_w)
    y1 = np.clip((cy - bh / 2 - pad[1]) / scale, 0, orig_h)
    x2 = np.clip((cx + bw / 2 - pad[0]) / scale, 0, orig_w)
    y2 = np.clip((cy + bh / 2 - pad[1]) / scale, 0, orig_h)

    candidates = []
    for k in range(len(idxs)):
        ci = int(cl[k])
        candidates.append({
            "class": labels[ci] if ci < len(labels) else str(ci),
            "score": round(float(sc[k]), 4),
            "bbox": [round(float(x1[k]), 1), round(float(y1[k]), 1), round(float(x2[k]), 1), round(float(y2[k]), 1)],
            "_xyxy": (float(x1[k]), float(y1[k]), float(x2[k]), float(y2[k])),
            "_col": int(idxs[k]),
        })

    kept = _nms(candidates, nms_iou)
    # Remove the internal fields; the column travels beside the detection.
    out: list[tuple[int, dict]] = []
    for d in kept:
        del d["_xyxy"]
        out.append((d.pop("_col"), d))
    return out
