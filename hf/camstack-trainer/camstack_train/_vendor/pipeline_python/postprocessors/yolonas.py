"""YOLO-NAS postprocessor — flat batched-NMS ONNX export.

plus catalog ``yolonas`` models (and any super-gradients ``model.export()`` with
fused NMS in FLAT format) emit ONE output tensor of shape ``[N, 7]`` where each
row is ``(batch_index, x1, y1, x2, y2, score, class_id)``:

  - coordinates are in INPUT pixel space (0..inputSize), post-NMS,
  - GPU exports pad unused slots with a NEGATIVE class id (skip them),
  - class ids index the model's own label map (plus catalog label set or COCO-80).

Output matches the yolo postprocessor:
``{"kind": "detections", "detections": [{"class", "score", "bbox": [x1,y1,x2,y2]}]}``
with pixel bboxes re-projected to ORIGINAL frame coordinates (letterbox undone
via the pool-provided ``scale`` + ``pad``).
"""
from __future__ import annotations

import numpy as np

from .yolo import COCO_80


def postprocess_yolonas(
    predictions: dict,
    config: dict,
    orig_w: int,
    orig_h: int,
    scale: float,
    pad: tuple[int, int],
) -> dict:
    conf_threshold = float(config.get("confidence", 0))
    labels = config.get("labels", COCO_80)

    output = np.asarray(list(predictions.values())[0])
    # Accept [1, N, 7] batched exports by squeezing the batch axis.
    if output.ndim == 3:
        output = output.reshape(-1, output.shape[-1])
    if output.ndim != 2 or output.shape[-1] != 7:
        raise ValueError(
            f"yolonas postprocessor expects a flat [N, 7] output, got shape {output.shape}"
        )

    detections = []
    for row in output:
        _batch_idx, x1, y1, x2, y2, score, class_id = row
        score = float(score)
        class_id = int(class_id)
        if class_id < 0:
            continue
        if score < conf_threshold:
            continue

        ox1 = max(0.0, min(float(orig_w), (float(x1) - pad[0]) / scale))
        oy1 = max(0.0, min(float(orig_h), (float(y1) - pad[1]) / scale))
        ox2 = max(0.0, min(float(orig_w), (float(x2) - pad[0]) / scale))
        oy2 = max(0.0, min(float(orig_h), (float(y2) - pad[1]) / scale))

        label = labels[class_id] if class_id < len(labels) else str(class_id)
        detections.append(
            {
                "class": label,
                "score": round(score, 4),
                "bbox": [round(ox1, 1), round(oy1, 1), round(ox2, 1), round(oy2, 1)],
            }
        )

    return {"kind": "detections", "detections": detections}
