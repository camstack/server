"""RF-DETR postprocessor (DETR-style query decode).

Used by the `rfdetr-package` parcel detector on the `package-detection` step
(per-model `postprocessor: 'rfdetr'` override — the step default is `yolo`).

Model contract, verified on the shipped export (onnx / openvino / coreml all
agree to |d| <= 0.005 in sigmoid space):

    input   "input"  [1, 3, 576, 576]  float, square RESIZE (no letterbox),
                                       ImageNet mean/std normalised
                                       (catalog: preprocessMode 'resize' +
                                       inputNormalization 'imagenet')
    output  "dets"   [1, 300, 4]       cxcywh, NORMALISED to the input image
    output  "labels" [1, 300, 2]       RAW logits; sigmoid -> per-query prob.

Three things differ from the `yolo` postprocessor and every one of them is a
way to get zero detections while looking correct:

1. **Column 0 is the no-object slot; the real classes start at 1.**
   The upstream rfdetr helper slices `logits[..., :-1]` — it drops the LAST
   column. On this checkpoint (`num_classes=1` ⇒ head width 2) that would throw
   away the `package` column and keep the background one, so every frame
   decodes as "nothing, forever". We slice `[..., 1:]`. Measured: the
   background column never exceeded 0.003 on any test frame, parcel or not.

2. **No letterbox, so `scale`/`pad` are unused.** Boxes map onto the original
   crop by multiplying the normalised cxcywh by orig_w / orig_h directly. The
   normalised coords are NOT sigmoid-bounded and DO exceed 1.0 (and go below 0)
   on edge queries — they are clamped to the frame, and a box that clamps to
   nothing is dropped.

3. **300 independent queries, no objectness.** NMS still runs (near-duplicate
   queries do occur) but the model is not anchor-based, so the default IoU is
   looser (0.50) than the yolo default on purpose.

DEGENERATE-BOX GUARD (measured, not theoretical): on a parcel-free crop
dominated by one large dark rectangle (the doormat) the top query becomes a box
spanning ~the whole crop at 0.33. Every real parcel detection was <= 25% of the
crop area. Rejecting boxes covering more than `maxAreaFraction` of the crop
removes that failure mode without touching a single true positive.

Output matches the yolo postprocessor:
``{"kind": "detections", "detections": [{"class", "score", "bbox":[x1,y1,x2,y2]}]}``
with pixel bboxes in ORIGINAL frame coordinates.
"""
from __future__ import annotations

import numpy as np

# Fraction of the input crop above which a box is treated as the degenerate
# whole-crop query rather than a parcel. Config key: `maxAreaFraction`.
DEFAULT_MAX_AREA_FRACTION = 0.60
# DETR queries are not anchors, so duplicates overlap less tightly than a yolo
# grid does. Config key: `nmsIouThreshold` (shared with the yolo decoder).
DEFAULT_NMS_IOU = 0.50


def _iou(a: tuple, b: tuple) -> float:
    """IoU between two boxes (x1, y1, x2, y2)."""
    ix1 = max(a[0], b[0])
    iy1 = max(a[1], b[1])
    ix2 = min(a[2], b[2])
    iy2 = min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter == 0:
        return 0.0
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _nms(boxes: list, iou_threshold: float) -> list:
    """Greedy non-maximum suppression over `_xyxy`, highest score first."""
    kept: list = []
    for box in sorted(boxes, key=lambda b: b["score"], reverse=True):
        if all(_iou(box["_xyxy"], k["_xyxy"]) <= iou_threshold for k in kept):
            kept.append(box)
    return kept


def _resolve_outputs(predictions: dict) -> tuple:
    """(dets, labels) by NAME, falling back to shape when the names are stripped.

    The onnx / openvino / coreml exports all keep the `dets` + `labels` names;
    the shape fallback covers a re-export that renames them (the boxes tensor is
    the one whose last dim is 4).
    """
    if "dets" in predictions and "labels" in predictions:
        return np.asarray(predictions["dets"]), np.asarray(predictions["labels"])
    arrays = [np.asarray(v) for v in predictions.values()]
    dets = next((a for a in arrays if a.shape[-1] == 4), None)
    labels = next((a for a in arrays if a.shape[-1] != 4), None)
    return dets, labels


def postprocess_rfdetr(
    predictions: dict,
    config: dict,
    orig_w: int,
    orig_h: int,
    scale: float,
    pad: tuple,
) -> dict:
    """Decode RF-DETR query output to original-frame detections.

    `scale` / `pad` are accepted for signature parity with the other
    postprocessors and deliberately UNUSED: this model is a square resize, not a
    letterbox, so there is no padding to invert.
    """
    conf_threshold = float(config.get("confidence", 0) or 0)
    labels_map = config.get("labels") or ["package"]
    nms_iou = float(config.get("nmsIouThreshold", DEFAULT_NMS_IOU) or DEFAULT_NMS_IOU)
    max_area = float(config.get("maxAreaFraction", DEFAULT_MAX_AREA_FRACTION) or DEFAULT_MAX_AREA_FRACTION)

    dets, logits = _resolve_outputs(predictions)
    if dets is None or logits is None:
        return {"kind": "detections", "detections": []}

    dets = dets[0] if dets.ndim == 3 else dets
    logits = logits[0] if logits.ndim == 3 else logits
    if dets.ndim != 2 or logits.ndim != 2 or logits.shape[1] < 2:
        # A single-column `labels` would be the no-object slot alone — nothing
        # to decode, and slicing it would raise instead of saying so.
        return {"kind": "detections", "detections": []}

    probs = 1.0 / (1.0 + np.exp(-logits.astype(np.float32)))
    # Column 0 is the DETR background / no-object slot — NOT the last column.
    # See the module docstring: dropping the wrong end silently yields zero
    # detections on every frame.
    class_probs = probs[:, 1:]
    best_class = class_probs.argmax(axis=1)
    best_score = class_probs.max(axis=1)

    frame_area = float(orig_w * orig_h)
    if frame_area <= 0:
        return {"kind": "detections", "detections": []}

    candidates: list = []
    for i in np.nonzero(best_score >= conf_threshold)[0]:
        cx, cy, w, h = (float(v) for v in dets[i][:4])
        # Normalised, NOT sigmoid-bounded: edge queries exceed [0,1] and are
        # clamped to the frame rather than dropped.
        x1 = max(0.0, (cx - w / 2.0) * orig_w)
        y1 = max(0.0, (cy - h / 2.0) * orig_h)
        x2 = min(float(orig_w), (cx + w / 2.0) * orig_w)
        y2 = min(float(orig_h), (cy + h / 2.0) * orig_h)
        if x2 <= x1 or y2 <= y1:
            continue
        if ((x2 - x1) * (y2 - y1)) / frame_area > max_area:
            continue  # degenerate whole-crop query (the doormat failure mode)
        cls = int(best_class[i])
        candidates.append({
            "class": labels_map[cls] if cls < len(labels_map) else str(cls),
            "score": round(float(best_score[i]), 4),
            "bbox": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
            "_xyxy": (x1, y1, x2, y2),
        })

    kept = _nms(candidates, nms_iou)
    for box in kept:
        box.pop("_xyxy", None)
    return {"kind": "detections", "detections": kept}
