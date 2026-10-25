"""YOLO-seg postprocessor (YOLO26-seg instance segmentation).

Input: raw predictions dict with two outputs:
  - detections: post-NMS ``[1, 300, 6 + 32]`` rows
    ``[x1, y1, x2, y2, conf, class_id, coeff_0..coeff_31]``, or a raw head
    ``[1, 4 + numClasses + 32, numBoxes]`` (one column per candidate)
  - prototypes: ``[1, 32, P, P]`` (P = 160 at a 640 input)

Output: ``{"kind": "detections", "detections": [{..., "mask": "<b64>",
"maskWidth": N, "maskHeight": N}]}`` — the mask is the detection's box region
of the prototype grid, thresholded to 0/255 bytes, row-major, base64.

The BOXES are decoded by the plain detector's own functions
(``yolo.decode_yolo11_nms_rows`` / ``yolo.decode_raw_yolo_columns``): same
confidence floor, same sigmoid detection, same NMS (and none on a post-NMS
head, exactly like ``yolo``), same letterbox inversion and rounding. A seg
model chosen as the camera ROOT therefore produces the detections a plain
detector would from the same tensors, plus a mask on each (D737). Masks are
computed only for the detections that survive, and only over their box.
"""
import base64

import numpy as np

from .yolo import COCO_80, decode_raw_yolo_columns, decode_yolo11_nms_rows

NUM_MASK_COEFFS = 32
PROTO_SIZE = 160


def _sigmoid(x: np.ndarray) -> np.ndarray:
    """Numerically stable sigmoid."""
    return np.where(x >= 0, 1 / (1 + np.exp(-x)), np.exp(x) / (1 + np.exp(x)))


def _as_prototypes(arr: np.ndarray) -> np.ndarray | None:
    """``[32, P, P]`` when ``arr`` is a prototype tensor, else ``None``."""
    squeezed = arr
    while squeezed.ndim > 3 and squeezed.shape[0] == 1:
        squeezed = squeezed[0]
    if squeezed.ndim == 3 and squeezed.shape[0] == NUM_MASK_COEFFS and squeezed.shape[1] == squeezed.shape[2]:
        return squeezed
    if arr.size == NUM_MASK_COEFFS * PROTO_SIZE * PROTO_SIZE:
        return arr.reshape(NUM_MASK_COEFFS, PROTO_SIZE, PROTO_SIZE)
    return None


def _find_tensors(predictions: dict, num_classes: int) -> tuple[np.ndarray, np.ndarray]:
    """Locate the detection tensor and prototype tensor from model outputs.

    Returns (detections, prototypes) as numpy arrays.
    detections: [num_dets, channels] row-major
    prototypes: [32, P, P]
    """
    det_tensor = None
    proto_tensor = None

    for _key, val in predictions.items():
        arr = np.array(val, dtype=np.float32)

        protos = _as_prototypes(arr)
        if protos is not None and proto_tensor is None:
            proto_tensor = protos
            continue

        # Skip tiny tensors
        if arr.size < 10:
            continue

        # Detection tensor: the other large tensor
        if det_tensor is None:
            det_tensor = arr

    if det_tensor is None:
        raise ValueError("YOLO-seg postprocessor: could not find detection tensor")
    if proto_tensor is None:
        raise ValueError("YOLO-seg postprocessor: could not find prototype tensor")

    # Normalize detection tensor to [num_dets, channels]
    while det_tensor.ndim > 2:
        det_tensor = det_tensor[0]  # strip batch dim

    # NMS format: [300, 38] — rows are detections
    # Raw format: [4+nc+32, N] — cols are detections, needs transpose
    nms_cols = 6 + NUM_MASK_COEFFS  # 38
    raw_cols = 4 + num_classes + NUM_MASK_COEFFS

    if det_tensor.shape[1] == nms_cols:
        pass  # already [N, 38]
    elif det_tensor.shape[0] == nms_cols:
        det_tensor = det_tensor.T
    elif det_tensor.shape[1] == raw_cols:
        pass  # already [N, raw_cols]
    elif det_tensor.shape[0] == raw_cols:
        det_tensor = det_tensor.T
    elif det_tensor.shape[0] < det_tensor.shape[1]:
        det_tensor = det_tensor.T  # likely [C, N] -> [N, C]

    return det_tensor, proto_tensor


def _instance_mask(
    coeffs: np.ndarray,
    protos: np.ndarray,
    bbox: list[float],
    scale: float,
    pad: tuple[int, int],
    input_size: int,
    mask_threshold: float,
) -> tuple[str, int, int]:
    """The detection's mask over its OWN box: the emitted (original-image)
    bbox mapped back into the letterboxed input, then onto the prototype grid.
    Only that window of ``coeffs @ protos`` is computed."""
    proto_size = protos.shape[-1]
    proto_scale = proto_size / input_size
    ox1, oy1, ox2, oy2 = bbox
    px1 = max(0, int(np.floor((ox1 * scale + pad[0]) * proto_scale)))
    py1 = max(0, int(np.floor((oy1 * scale + pad[1]) * proto_scale)))
    px2 = min(proto_size, int(np.ceil((ox2 * scale + pad[0]) * proto_scale)))
    py2 = min(proto_size, int(np.ceil((oy2 * scale + pad[1]) * proto_scale)))
    crop_w = max(1, px2 - px1)
    crop_h = max(1, py2 - py1)
    window = protos[:, py1:py1 + crop_h, px1:px1 + crop_w]
    h, w = window.shape[1], window.shape[2]
    if h == 0 or w == 0:
        binary = np.zeros((crop_h, crop_w), dtype=np.uint8)
    else:
        logits = coeffs.astype(np.float32) @ window.reshape(NUM_MASK_COEFFS, -1)
        binary = (_sigmoid(logits.reshape(h, w)) > mask_threshold).astype(np.uint8) * 255
        crop_h, crop_w = h, w
    return base64.b64encode(binary.tobytes()).decode("ascii"), crop_w, crop_h


def postprocess_yolo_seg(
    predictions: dict,
    config: dict,
    orig_w: int,
    orig_h: int,
    scale: float,
    pad: tuple[int, int],
) -> dict:
    """Postprocess YOLO-seg output to detections with per-instance masks.

    Handles:
    1. NMS-enabled export: [N, 6+32] with [x1,y1,x2,y2,conf,class_id,...coeffs]
    2. Raw export: [4+numClasses+32, N] standard YOLO transposed format
    """
    labels = config.get("labels", COCO_80)
    num_classes = config.get("numClasses", len(labels))
    input_size = int(config.get("inputSize", 640))
    mask_threshold = float(config.get("maskThreshold", 0.5))

    det_tensor, proto_tensor = _find_tensors(predictions, num_classes)

    if det_tensor.shape[1] == 6 + NUM_MASK_COEFFS:
        kept = decode_yolo11_nms_rows(det_tensor, config, orig_w, orig_h, scale, pad)
        coeffs = det_tensor[:, 6:6 + NUM_MASK_COEFFS]
    else:
        # The raw decode reads [C, N] and may sigmoid its class rows in place:
        # hand it its own copy so the coefficients below stay untouched.
        kept = decode_raw_yolo_columns(
            np.ascontiguousarray(det_tensor.T), config, orig_w, orig_h, scale, pad
        )
        coeffs = det_tensor[:, 4 + num_classes:4 + num_classes + NUM_MASK_COEFFS]

    detections = []
    for index, det in kept:
        mask_b64, mask_w, mask_h = _instance_mask(
            coeffs[index], proto_tensor, det["bbox"], scale, pad, input_size, mask_threshold
        )
        detections.append({**det, "mask": mask_b64, "maskWidth": mask_w, "maskHeight": mask_h})

    return {"kind": "detections", "detections": detections}
