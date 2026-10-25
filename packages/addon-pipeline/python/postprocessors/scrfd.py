"""SCRFD face detection postprocessor.

Multi-stride anchor-based face detector (strides 8, 16, 32).
Originally ported from packages/addon-vision/src/shared/postprocess/scrfd.ts,
whose Node.js raw-tensor onnxruntime path was retired in favour of doing all
postprocessing here, in the Python inference pool — that TS file, and the
addon-vision package it lived in, no longer exist (see the header comment in
packages/addon-pipeline/src/detection-pipeline/postprocess/dispatch.ts). This
module is now the sole SCRFD decoder in the repo.

Output: {"kind": "detections", "detections": [{"class": "face", "score", "bbox": [x1,y1,x2,y2], "landmarks?"}]}
"""

from __future__ import annotations
import numpy as np


STRIDES = [8, 16, 32]
NUM_ANCHORS_PER_STRIDE = 2


def _generate_anchors(stride: int, input_size: int) -> list[tuple[float, float]]:
    """Generate anchor centers for a given stride.

    Anchor centers are `(x * stride, y * stride)` — NO half-cell `+0.5` offset.
    This matches upstream InsightFace's reference decoder exactly
    (`insightface/model_zoo/scrfd.py`: `anchor_centers = np.stack([anchor_centers_x,
    anchor_centers_y], axis=-1).astype(np.float32)`, built from a raw
    `np.mgrid[:h, :w]` and then `anchor_centers * stride` — no `+0.5` anywhere
    in that path). The previous `(x + 0.5) * stride` formula shifted every box
    and landmark down-and-right by half a stride (4/8/16 px at 640), which is a
    large fraction of a face after the letterbox upscale from a person crop.
    Fixing this moved NME (COCO eyes+nose vs GT) 0.352 → 0.115 and AuraFace
    self-consistency cosine 0.79 → 0.91 (2026-09-26 model-replacement spike,
    docs/superpowers/specs/2026-09-26-replacement-models-spike.md §2.4-1).
    """
    feat_size = int(np.ceil(input_size / stride))
    anchors = []
    for y in range(feat_size):
        for x in range(feat_size):
            for _ in range(NUM_ANCHORS_PER_STRIDE):
                anchors.append((x * stride, y * stride))
    return anchors


def _iou(a: tuple, b: tuple) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    if inter == 0:
        return 0.0
    union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter
    return inter / union if union > 0 else 0.0


def _nms(boxes: list[dict], iou_threshold: float = 0.45) -> list[dict]:
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


def _match_outputs_to_strides(
    raw_outputs: dict[str, np.ndarray],
    strides: list[int],
    input_size: int,
) -> dict[int, dict]:
    """Match model output tensors to strides.

    Handles two naming conventions:
    1. Named keys: 'score_8', 'bbox_8', 'kps_8' (ONNX/OpenVINO)
    2. Generic keys: 'var_732' etc. — matched by shape (CoreML)

    For CoreML, each stride has 3 tensors with num_anchors matching the stride:
      stride 8  → ceil(input/8)^2 * 2 anchors → shapes (1, N, 1), (1, N, 4), (1, N, 10)
      stride 16 → ceil(input/16)^2 * 2
      stride 32 → ceil(input/32)^2 * 2
    """
    result: dict[int, dict] = {}

    # Try named keys first
    flat = {k: v.flatten() for k, v in raw_outputs.items()}
    for stride in strides:
        score_key = bbox_key = kps_key = None
        for k in flat:
            if f"score_{stride}" in k or f"_{stride}_score" in k:
                score_key = k
            elif f"bbox_{stride}" in k or f"_{stride}_bbox" in k:
                bbox_key = k
            elif f"kps_{stride}" in k or f"_{stride}_kps" in k:
                kps_key = k
        if score_key and bbox_key:
            result[stride] = {
                "scores": flat[score_key],
                "bboxes": flat[bbox_key],
                "kps": flat.get(kps_key),
            }

    if len(result) == len(strides):
        return result

    # Fallback: match by shape (CoreML generic names)
    # Group outputs by last dimension: 1=scores, 4=bboxes, 10=landmarks
    scores_by_n: dict[int, np.ndarray] = {}
    bboxes_by_n: dict[int, np.ndarray] = {}
    kps_by_n: dict[int, np.ndarray] = {}

    for _k, arr in raw_outputs.items():
        if arr.ndim == 3:
            arr = arr[0]  # remove batch dim → (N, C)
        elif arr.ndim == 1:
            continue
        n, c = arr.shape
        if c == 1:
            scores_by_n[n] = arr.flatten()
        elif c == 4:
            bboxes_by_n[n] = arr.flatten()
        elif c == 10:
            kps_by_n[n] = arr.flatten()

    result = {}
    for stride in strides:
        feat = int(np.ceil(input_size / stride))
        expected_n = feat * feat * NUM_ANCHORS_PER_STRIDE
        if expected_n in scores_by_n and expected_n in bboxes_by_n:
            result[stride] = {
                "scores": scores_by_n[expected_n],
                "bboxes": bboxes_by_n[expected_n],
                "kps": kps_by_n.get(expected_n),
            }

    return result


def postprocess_scrfd(
    predictions: dict,
    config: dict,
    orig_w: int,
    orig_h: int,
    scale: float,
    pad: tuple[int, int],
) -> dict:
    """Postprocess SCRFD output to structured face detections."""
    conf_threshold = float(config.get("confidence", 0.5) or 0.5)
    input_size = config.get("inputSize", 640)
    strides = config.get("strides", STRIDES)
    # NMS IoU from the step config (operator slider); the 0.45 literal stays as
    # the fallback so an unset value is byte-identical to today (#4).
    nms_iou = float(config.get("nmsIouThreshold", 0.45))

    # Letterbox transform: scale and pad are passed from inference_pool
    # scale = input_size / max(orig_w, orig_h)
    # pad = ((input_size - orig_w*scale)//2, (input_size - orig_h*scale)//2)

    # Convert all outputs to numpy arrays (keep ndim)
    raw_outputs = {k: np.array(v) for k, v in predictions.items()}

    # Match outputs to strides — by named key or by shape
    stride_data = _match_outputs_to_strides(raw_outputs, strides, input_size)

    candidates = []

    for stride in strides:
        data = stride_data.get(stride)
        if data is None:
            continue

        scores = data["scores"]
        bboxes = data["bboxes"]
        kps = data.get("kps")
        anchors = _generate_anchors(stride, input_size)

        n = len(anchors)
        for i in range(n):
            if i >= len(scores):
                break
            score = float(scores[i])
            if score < conf_threshold:
                continue

            cx, cy = anchors[i]

            # Bbox: offsets from anchor center, scaled by stride
            x1 = cx - float(bboxes[i * 4]) * stride
            y1 = cy - float(bboxes[i * 4 + 1]) * stride
            x2 = cx + float(bboxes[i * 4 + 2]) * stride
            y2 = cy + float(bboxes[i * 4 + 3]) * stride

            # Transform from letterbox coords to original image
            ox1 = max(0, min(orig_w, (x1 - pad[0]) / scale))
            oy1 = max(0, min(orig_h, (y1 - pad[1]) / scale))
            ox2 = max(0, min(orig_w, (x2 - pad[0]) / scale))
            oy2 = max(0, min(orig_h, (y2 - pad[1]) / scale))

            if (ox2 - ox1) < 1 or (oy2 - oy1) < 1:
                continue

            det = {
                "class": "face",
                "score": round(score, 4),
                "bbox": [round(ox1, 1), round(oy1, 1), round(ox2, 1), round(oy2, 1)],
                "_xyxy": (ox1, oy1, ox2, oy2),
            }

            # Landmarks (5 points × 2 coords)
            if kps is not None and (i * 10 + 9) < len(kps):
                landmarks = []
                for p in range(5):
                    raw_lx = cx + float(kps[i * 10 + p * 2]) * stride
                    raw_ly = cy + float(kps[i * 10 + p * 2 + 1]) * stride
                    lx = (raw_lx - pad[0]) / scale
                    ly = (raw_ly - pad[1]) / scale
                    landmarks.append({"x": round(lx, 1), "y": round(ly, 1)})
                det["landmarks"] = landmarks

            candidates.append(det)

    kept = _nms(candidates, nms_iou)
    for d in kept:
        del d["_xyxy"]

    return {"kind": "detections", "detections": kept}
