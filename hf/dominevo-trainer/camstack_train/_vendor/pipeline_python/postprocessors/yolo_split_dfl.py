"""YOLO split-head DFL postprocessor (YOLOv9 TFLite / EdgeTPU).

Two split layouts reach it, neither the ONNX ``[1, 7, 2100]`` packed one:

* plugin catalog's TFLite builds emit SIX tensors (3 strides × box+cls):

    box: [1, H·W, 4·reg_max] with ``reg_max=16`` (DFL distances l,t,r,b)
    cls: [1, H·W, C]          logits over person/vehicle/animal (C=3)

* The community plus catalog EdgeTPU export (``dbro/frigate-detector-edgetpu-yolo9``,
  read from the published files) emits ONE pair with the strides
  CONCATENATED, 8 then 16 then 32, each row-major:

    box: [1, N, 64]  cls: [1, N, C]   N = Σ (H/s)·(W/s) — 2100 at 320², 5376 at 512²

  and its v1.5 files add a third ``[1, N, 1]`` tensor that is NOT the class
  tensor: the widest non-box tensor of a given ``N`` is.

Pairs are matched by shared spatial length ``N`` (1600/400/100 for 320²), not
by positional key order — TFLite output order has drifted between exports.
Coordinates are decoded in INPUT pixel space, then mapped back to the original
frame: stretch when ``preprocessMode == 'resize'`` (plugin catalog default), else
letterbox undo via the pool's ``scale`` + ``pad``.

Two implementations of ONE decode. A live ndarray from the pool (always, in
production: ``edgetpu_dequant`` returns float32 arrays) is decoded VECTORISED
with numpy — walking 2100 / 5376 cells × 81 values as nested Python lists cost
~5 / ~12 ms a frame on a desktop core, the largest N-dependent share of the
Coral YOLOv9 step (2026-10-22). Nested lists, and any interpreter without
numpy (CI's bare one), take the pure-list path, same discipline as ``ssd.py``.
Both produce the same output, field for field: the vectorised path keeps the
list path's operation order (sequential sums, the same sigmoid branches), its
candidate order and its NMS, and ``test_yolo_split_dfl_numpy.py`` holds them
equal.
"""
from __future__ import annotations

import math
from typing import Any

try:
    import numpy as _np
except ImportError:  # the bare CI interpreter: the list path is the only path
    _np = None
if _np is not None and not hasattr(_np, "ndarray"):
    _np = None  # a test's stand-in module, not numpy

REG_MAX = 16


def _as_list(value: Any) -> Any:
    return value.tolist() if hasattr(value, "tolist") else value


def _is_array(value: Any) -> bool:
    return _np is not None and isinstance(value, _np.ndarray)


def _as_tensor(value: Any) -> Any:
    """A plain ndarray when numpy can take it, else nested lists."""
    if _np is not None and hasattr(value, "shape") and hasattr(value, "dtype"):
        return _np.asarray(value)
    return _as_list(value)


def _shape(value: Any) -> tuple[int, ...]:
    if _is_array(value):
        return tuple(int(d) for d in value.shape)
    dims: list[int] = []
    cur = value
    while isinstance(cur, (list, tuple)):
        dims.append(len(cur))
        if not cur:
            break
        cur = cur[0]
    return tuple(dims)


def _sigmoid(x: float) -> float:
    if x >= 0:
        z = math.exp(-x)
        return 1.0 / (1.0 + z)
    z = math.exp(x)
    return z / (1.0 + z)


def _softmax(xs: list[float]) -> list[float]:
    m = max(xs) if xs else 0.0
    exps = [math.exp(x - m) for x in xs]
    s = sum(exps) or 1.0
    return [e / s for e in exps]


def _dfl_distance(logits16: list[float]) -> float:
    """Softmax over ``reg_max`` bins · project ``[0..reg_max)`` → distance in cells."""
    probs = _softmax(logits16)
    return sum(i * p for i, p in enumerate(probs))


def _iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def _nms(boxes: list[dict], iou_threshold: float) -> list[dict]:
    ordered = sorted(boxes, key=lambda b: b["score"], reverse=True)
    kept: list[dict] = []
    suppressed: set[int] = set()
    for i, box in enumerate(ordered):
        if i in suppressed:
            continue
        kept.append(box)
        for j in range(i + 1, len(ordered)):
            if j in suppressed:
                continue
            if _iou(box["_xyxy"], ordered[j]["_xyxy"]) > iou_threshold:
                suppressed.add(j)
    return kept


def _squeeze_batch(tensor: Any) -> Any:
    """Drop a leading batch dim of 1: [1, N, C] → [N, C]."""
    shape = _shape(tensor)
    if len(shape) == 3 and shape[0] == 1:
        return tensor[0]
    return tensor


def _pair_box_cls(predictions: dict) -> list[tuple[Any, Any]]:
    """Group outputs into (box, cls) pairs by shared N (= H·W)."""
    tensors = {str(k): _squeeze_batch(_as_tensor(v)) for k, v in predictions.items()}
    boxes: dict[int, Any] = {}
    classes: dict[int, Any] = {}
    for tensor in tensors.values():
        shape = _shape(tensor)
        if len(shape) != 2:
            continue
        n, width = shape
        if width == 4 * REG_MAX:
            boxes[n] = tensor
        elif width > 0 and (n not in classes or width > _shape(classes[n])[1]):
            # The WIDEST non-box tensor of this N is the class tensor: a
            # one-channel sibling (the v1.5 plus catalog export's [1, N, 1]) never
            # displaces it, whatever the output order.
            classes[n] = tensor
    pairs: list[tuple[Any, Any]] = []
    for n, box in boxes.items():
        cls = classes.get(n)
        if cls is None:
            continue
        pairs.append((box, cls))
    if not pairs:
        raise ValueError(
            "yolo-split-dfl: expected paired box[N,64] + cls[N,C] tensors; "
            f"got shapes {[_shape(t) for t in tensors.values()]}"
        )
    # Largest N first (finest stride) — stable, matches plugin catalog 1600→400→100.
    pairs.sort(key=lambda p: _shape(p[0])[0], reverse=True)
    return pairs


CONCAT_STRIDES: tuple[int, ...] = (8, 16, 32)


def _concat_stride_cells(n: int, in_w: int, in_h: int) -> "list[tuple[int, int, int]] | None":
    """``[(offset, stride, grid_w), …]`` when ``N`` is every stride of the input
    concatenated (8, 16, 32 in that order), else ``None``."""
    cells: list[tuple[int, int, int]] = []
    offset = 0
    for stride in CONCAT_STRIDES:
        if in_w % stride or in_h % stride:
            return None
        cells.append((offset, stride, in_w // stride))
        offset += (in_w // stride) * (in_h // stride)
    return cells if offset == n else None


def _segments(
    box: Any, cls: Any, in_w: int, in_h: int, input_size: int
) -> list[tuple[Any, Any, int, int]]:
    """``(box rows, cls rows, stride, grid_w)`` per stride of one box/cls pair."""
    n = _shape(box)[0]
    concat = _concat_stride_cells(n, in_w, in_h)
    if concat is None:
        return [(box, cls, _infer_stride(n, input_size), int(round(math.sqrt(n))))]
    ends = [offset for offset, _, _ in concat[1:]] + [n]
    return [
        (box[offset:end], cls[offset:end], stride, grid_w)
        for (offset, stride, grid_w), end in zip(concat, ends)
    ]


def _infer_stride(n: int, input_size: int) -> int:
    """N = (input_size / stride)² → stride = input_size / sqrt(N)."""
    side = int(round(math.sqrt(n)))
    if side * side != n or side <= 0:
        # Fall back to the canonical 320² strides by matching known Ns.
        known = {1600: 8, 400: 16, 100: 32, (640 // 8) ** 2: 8}
        if n in known:
            return known[n]
        raise ValueError(f"yolo-split-dfl: cannot infer grid side from N={n}")
    stride = input_size // side
    if stride * side != input_size:
        # Non-divisible — still use the rounded stride from side.
        stride = max(1, int(round(input_size / side)))
    return stride


def _to_original(
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    *,
    orig_w: int,
    orig_h: int,
    scale: float,
    pad: tuple[int, int],
    config: dict,
) -> tuple[float, float, float, float]:
    mode = config.get("preprocessMode", "letterbox")
    if mode == "resize":
        in_w = float(config.get("inputWidth") or config.get("inputSize") or 320)
        in_h = float(config.get("inputHeight") or config.get("inputSize") or 320)
        if in_w <= 0 or in_h <= 0:
            in_w = in_h = 320.0
        ox1 = x1 * orig_w / in_w
        oy1 = y1 * orig_h / in_h
        ox2 = x2 * orig_w / in_w
        oy2 = y2 * orig_h / in_h
    else:
        ox1 = (x1 - pad[0]) / scale
        oy1 = (y1 - pad[1]) / scale
        ox2 = (x2 - pad[0]) / scale
        oy2 = (y2 - pad[1]) / scale
    return (
        max(0.0, min(float(orig_w), ox1)),
        max(0.0, min(float(orig_h), oy1)),
        max(0.0, min(float(orig_w), ox2)),
        max(0.0, min(float(orig_h), oy2)),
    )


def _candidate(label: str, score: float, xyxy: tuple[float, float, float, float]) -> dict:
    ox1, oy1, ox2, oy2 = xyxy
    return {
        "class": label,
        "score": round(score, 4),
        "bbox": [round(ox1, 1), round(oy1, 1), round(ox2, 1), round(oy2, 1)],
        "_xyxy": xyxy,
    }


def _segment_candidates(
    box_tensor: Any,
    cls_tensor: Any,
    stride: int,
    grid: int,
    *,
    conf_threshold: float,
    labels: list,
    orig_w: int,
    orig_h: int,
    scale: float,
    pad: tuple[int, int],
    config: dict,
) -> list[dict]:
    """The pure-list decode of one stride segment (no numpy needed)."""
    n = _shape(box_tensor)[0]
    num_classes = _shape(cls_tensor)[1]
    candidates: list[dict] = []
    for i in range(n):
        # Class score first — skip cold cells before DFL.
        logits = cls_tensor[i]
        best_c = 0
        best_logit = float(logits[0])
        for c in range(1, num_classes):
            v = float(logits[c])
            if v > best_logit:
                best_logit = v
                best_c = c
        score = _sigmoid(best_logit)
        if score < conf_threshold:
            continue

        dist = box_tensor[i]
        if len(dist) != 4 * REG_MAX:
            continue
        l = _dfl_distance([float(x) for x in dist[0:16]])
        t = _dfl_distance([float(x) for x in dist[16:32]])
        r = _dfl_distance([float(x) for x in dist[32:48]])
        b = _dfl_distance([float(x) for x in dist[48:64]])

        gy, gx = i // grid, i % grid
        # Ultralytics-style anchor centre at (gx + 0.5, gy + 0.5) * stride;
        # distances are in cell units → multiply by stride for pixels.
        cx = (gx + 0.5) * stride
        cy = (gy + 0.5) * stride
        x1 = cx - l * stride
        y1 = cy - t * stride
        x2 = cx + r * stride
        y2 = cy + b * stride

        ox1, oy1, ox2, oy2 = _to_original(
            x1, y1, x2, y2,
            orig_w=orig_w, orig_h=orig_h, scale=scale, pad=pad, config=config,
        )
        if ox2 <= ox1 or oy2 <= oy1:
            continue

        label = labels[best_c] if best_c < len(labels) else str(best_c)
        candidates.append(_candidate(label, score, (ox1, oy1, ox2, oy2)))
    return candidates


def _segment_candidates_np(
    box_tensor: Any,
    cls_tensor: Any,
    stride: int,
    grid: int,
    *,
    conf_threshold: float,
    labels: list,
    orig_w: int,
    orig_h: int,
    scale: float,
    pad: tuple[int, int],
    config: dict,
) -> list[dict]:
    """``_segment_candidates``, vectorised: same operations, same order, same output.

    Only the cells that pass the confidence floor reach the DFL and leave numpy
    (a handful per subject); the sums run bin by bin, like ``sum()`` does, so
    no reduction reorders the float additions.
    """
    np = _np
    n = _shape(box_tensor)[0]
    if n == 0 or _shape(box_tensor)[1] != 4 * REG_MAX:
        return []
    cls64 = cls_tensor.astype(np.float64)
    best_c = cls64.argmax(axis=1)  # first maximum on a tie, like the strict ``>`` walk
    best_logit = cls64[np.arange(n), best_c]
    z = np.exp(-np.abs(best_logit))
    score = np.where(best_logit >= 0, 1.0 / (1.0 + z), z / (1.0 + z))  # ``_sigmoid``'s two branches
    idx = np.nonzero(score >= conf_threshold)[0]
    if idx.size == 0:
        return []

    bins = box_tensor[idx].astype(np.float64).reshape(-1, 4, REG_MAX)
    exps = np.exp(bins - bins.max(axis=2, keepdims=True))
    total = np.zeros(exps.shape[:2])
    for k in range(REG_MAX):
        total = total + exps[:, :, k]
    probs = exps / total[:, :, None]
    dist = np.zeros(exps.shape[:2])
    for k in range(REG_MAX):
        dist = dist + k * probs[:, :, k]

    gy, gx = idx // grid, idx % grid
    cx = (gx + 0.5) * stride
    cy = (gy + 0.5) * stride
    x1 = cx - dist[:, 0] * stride
    y1 = cy - dist[:, 1] * stride
    x2 = cx + dist[:, 2] * stride
    y2 = cy + dist[:, 3] * stride

    if config.get("preprocessMode", "letterbox") == "resize":
        in_w = float(config.get("inputWidth") or config.get("inputSize") or 320)
        in_h = float(config.get("inputHeight") or config.get("inputSize") or 320)
        if in_w <= 0 or in_h <= 0:
            in_w = in_h = 320.0
        ox1, oy1 = x1 * orig_w / in_w, y1 * orig_h / in_h
        ox2, oy2 = x2 * orig_w / in_w, y2 * orig_h / in_h
    else:
        ox1, oy1 = (x1 - pad[0]) / scale, (y1 - pad[1]) / scale
        ox2, oy2 = (x2 - pad[0]) / scale, (y2 - pad[1]) / scale
    w, h = float(orig_w), float(orig_h)
    ox1, ox2 = np.maximum(0.0, np.minimum(w, ox1)), np.maximum(0.0, np.minimum(w, ox2))
    oy1, oy2 = np.maximum(0.0, np.minimum(h, oy1)), np.maximum(0.0, np.minimum(h, oy2))
    keep = (ox2 > ox1) & (oy2 > oy1)

    candidates: list[dict] = []
    for c, sc, a, b, cc, d in zip(
        best_c[idx][keep].tolist(), score[idx][keep].tolist(),
        ox1[keep].tolist(), oy1[keep].tolist(), ox2[keep].tolist(), oy2[keep].tolist(),
    ):
        label = labels[c] if c < len(labels) else str(c)
        candidates.append(_candidate(label, sc, (a, b, cc, d)))
    return candidates


def postprocess_yolo_split_dfl(
    predictions: dict,
    config: dict,
    orig_w: int,
    orig_h: int,
    scale: float,
    pad: tuple[int, int],
) -> dict:
    conf_threshold = float(config.get("confidence", 0))
    labels = config.get("labels") or ["person", "vehicle", "animal"]
    nms_iou = float(config.get("nmsIouThreshold", 0.45))
    input_size = int(config.get("inputSize") or config.get("inputWidth") or 320)
    in_w = int(config.get("inputWidth") or input_size)
    in_h = int(config.get("inputHeight") or input_size)

    segments = [
        seg
        for box_pair, cls_pair in _pair_box_cls(predictions)
        for seg in _segments(box_pair, cls_pair, in_w, in_h, input_size)
    ]
    candidates: list[dict] = []
    for box_tensor, cls_tensor, stride, grid in segments:
        decode = _segment_candidates_np if _is_array(box_tensor) and _is_array(cls_tensor) else _segment_candidates
        candidates += decode(
            box_tensor, cls_tensor, stride, grid,
            conf_threshold=conf_threshold, labels=labels,
            orig_w=orig_w, orig_h=orig_h, scale=scale, pad=pad, config=config,
        )

    kept = _nms(candidates, nms_iou)
    detections = [
        {"class": d["class"], "score": d["score"], "bbox": d["bbox"]} for d in kept
    ]
    return {"kind": "detections", "detections": detections}
