"""YuNet face detection postprocessor (OpenCV Zoo `face_detection_yunet`, 2023mar).

Used by the `yunet-2023mar` catalog entry on the `face-detection` step through a
per-MODEL `postprocessor: 'yunet'` override (the step default stays `scrfd`).

Model contract, as published by `scripts/build-yunet-model.py`:

    input   "image"   [1, 3, 640, 640]  RGB float in [0,1] — the pool's plain
                                        `/255` tensor. Upstream YuNet wants BGR
                                        0..255; `Mul(255)` + `Gather([2,1,0])`
                                        are BAKED into the graph ahead of the
                                        first Conv, identically in all three
                                        formats, so no pool normalisation runs
                                        (the entry declares none).
    outputs cls_{8,16,32}  [1, N, 1]    classification probability
            obj_{8,16,32}  [1, N, 1]    objectness probability
            bbox_{8,16,32} [1, N, 4]    (dx, dy, log w, log h), stride units
            kps_{8,16,32}  [1, N, 10]   5 × (dx, dy), stride units

Why it cannot share `scrfd.py` (measured 2026-09-26: the SCRFD decoder finds 0
faces on 413 person crops with YuNet's outputs):

1. ONE prior per grid cell, not two; anchor-free — the prior is the cell's
   top-left corner, `(col, row) * stride`, row-major, `N = ceil(640/s)^2`.
2. The box is centre + size, with `exp()` on width and height — SCRFD's is four
   distances from the anchor.
3. The score is `sqrt(cls * obj)` over TWO tensors, both clamped to [0,1].

This is a port of OpenCV's `FaceDetectorYN::postProcess`
(`modules/objdetect/src/face_detect.cpp`).

Landmarks come out in YuNet's order — right eye, left eye, nose tip, right
mouth corner, left mouth corner, where right/left are the SUBJECT'S. That is
image-left eye first, the same order SCRFD emits and `face-align.ts` expects
(ARCFACE_TEMPLATE_112), so they are passed through unchanged. Measured on 196
COCO faces: index 0 is the image-left eye except on 3 profile faces, the same
rate as SCRFD's 2.

The per-candidate arithmetic (`prior_cell`, `decode_prior`, `to_source`, `nms`)
is plain Python so the layout, decode and landmark-order tests run on CI's bare
interpreter; numpy only vectorises the score threshold over the 8400 priors.

Output matches the scrfd postprocessor:
``{"kind": "detections", "detections": [{"class": "face", "score", "bbox": [x1,y1,x2,y2], "landmarks"}]}``
in ORIGINAL (pre-letterbox) pixel coordinates.
"""
from __future__ import annotations

import math
import sys
import time

import numpy as np

STRIDES: tuple[int, ...] = (8, 16, 32)
NUM_LANDMARKS = 5
DEFAULT_NMS_IOU = 0.45

# At most this many candidates, best first, reach the NMS. OpenCV's
# FaceDetectorYN caps at 5000 (`top_k`), but its NMS is C++; `nms` below is
# pure Python and O(n·kept), measured on this Mac at 28 ms for 500 disjoint
# candidates, 113 ms for 1000 and 2.8 s for 5000 — an unbounded frame (every
# prior passing a low floor: 8400) would hold a pool worker for ~8 s. Real
# frames are far below the cap: on the spike's 413 person crops the most
# candidates any frame produced was 38 at the step's 0.5 floor and 110 at 0.1.
TOP_K = 750
# A frame that hits the cap is reported, at most once per this interval, on
# stderr (the pool's log): dropped work is never silent, and a pathological
# model/threshold must not flood the log either.
TOP_K_LOG_INTERVAL_S = 60.0
_last_top_k_log = 0.0


def grid_cols(stride: int, input_size: int) -> int:
    """Priors per row (and per column — the input is square) at `stride`."""
    return int(math.ceil(input_size / stride))


def prior_cell(index: int, cols: int) -> tuple[int, int]:
    """`(row, col)` of prior `index` — row-major, one prior per cell."""
    return divmod(index, cols)


def score_of(cls: float, obj: float) -> float:
    """YuNet's score: geometric mean of the two probabilities, each clamped."""
    return math.sqrt(min(max(cls, 0.0), 1.0) * min(max(obj, 0.0), 1.0))


def decode_prior(
    stride: int,
    row: int,
    col: int,
    bbox: "list[float] | tuple[float, ...]",
    kps: "list[float] | tuple[float, ...]",
) -> tuple[tuple[float, float, float, float], list[tuple[float, float]]]:
    """One prior → `(x1, y1, x2, y2)` and 5 landmark points, in NETWORK space."""
    cx = (col + bbox[0]) * stride
    cy = (row + bbox[1]) * stride
    w = math.exp(bbox[2]) * stride
    h = math.exp(bbox[3]) * stride
    box = (cx - w / 2.0, cy - h / 2.0, cx + w / 2.0, cy + h / 2.0)
    points = [
        ((kps[2 * p] + col) * stride, (kps[2 * p + 1] + row) * stride)
        for p in range(NUM_LANDMARKS)
    ]
    return box, points


def to_source(x: float, y: float, scale: float, pad: tuple[int, int]) -> tuple[float, float]:
    """Undo the pool's letterbox: network pixels → original frame pixels."""
    return (x - pad[0]) / scale, (y - pad[1]) / scale


def _iou(a: tuple, b: tuple) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    if inter == 0:
        return 0.0
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def cap_top_k(candidates: list[dict], k: int = TOP_K) -> tuple[list[dict], int]:
    """The `k` best candidates by score, and how many were dropped."""
    if len(candidates) <= k:
        return candidates, 0
    best = sorted(candidates, key=lambda c: c["score"], reverse=True)
    return best[:k], len(candidates) - k


def _log_top_k_drop(dropped: int, total: int) -> None:
    global _last_top_k_log
    now = time.monotonic()
    if now - _last_top_k_log < TOP_K_LOG_INTERVAL_S:
        return
    _last_top_k_log = now
    sys.stderr.write(
        f"yunet: {total} candidates above the confidence floor, kept the best {TOP_K} "
        f"for NMS and dropped {dropped} (logged at most once per "
        f"{TOP_K_LOG_INTERVAL_S:.0f}s)\n"
    )
    sys.stderr.flush()


def nms(candidates: list[dict], iou_threshold: float) -> list[dict]:
    """Greedy NMS on `_xyxy`, highest score first."""
    kept: list[dict] = []
    for cand in sorted(candidates, key=lambda c: c["score"], reverse=True):
        if all(_iou(cand["_xyxy"], k["_xyxy"]) <= iou_threshold for k in kept):
            kept.append(cand)
    return kept


_OUTPUT_WIDTHS: tuple[tuple[str, int], ...] = (
    ("cls", 1), ("obj", 1), ("bbox", 4), ("kps", 2 * NUM_LANDMARKS),
)


def missing_outputs(output_names) -> list[str]:
    """The named outputs this decoder needs that the model did not produce.

    Matched by NAME only, with no shape fallback: `cls_*` and `obj_*` have
    identical shapes, so a fallback could only guess. Every published format
    names its outputs (the CoreML conversion names them explicitly, the
    OpenVINO IR has its internal aliases cleared)."""
    present = set(output_names)
    return [
        f"{kind}_{stride}" for stride in STRIDES for kind, _ in _OUTPUT_WIDTHS
        if f"{kind}_{stride}" not in present
    ]


def value_count(value) -> int:
    """Number of scalars in an ndarray-like (`.size`) or a nested sequence.
    Pure Python, so the size gate below needs no numpy."""
    size = getattr(value, "size", None)
    if isinstance(size, int):
        return size
    if isinstance(value, (list, tuple)):
        return sum(value_count(v) for v in value)
    return 1


def check_outputs(predictions: dict, input_size: int) -> None:
    """RAISE unless all twelve outputs are present and sized for `input_size`.

    Returning `[]` instead would read as "no faces" forever with no line
    saying why — which is exactly what the SCRFD decoder did on this graph. A
    size mismatch means the model's input is not `inputSize` (e.g. a 320
    export under a 640 catalog entry): decoding it would put every prior in the
    wrong cell."""
    missing = missing_outputs(predictions.keys())
    if missing:
        raise ValueError(
            f"yunet: outputs {missing} missing (model outputs: {sorted(predictions)})"
        )
    for stride in STRIDES:
        priors = grid_cols(stride, input_size) ** 2
        for kind, width in _OUTPUT_WIDTHS:
            key = f"{kind}_{stride}"
            got = value_count(predictions[key])
            if got != priors * width:
                raise ValueError(
                    f"yunet: output '{key}' has {got} values, expected {priors * width} "
                    f"({priors} priors × {width}) — inputSize {input_size} does not match the model"
                )


def _stride_tensors(predictions: dict, stride: int) -> dict:
    """The four flattened tensors of one stride (sizes already checked)."""
    return {
        kind: np.asarray(predictions[f"{kind}_{stride}"], dtype=np.float32).reshape(-1)
        for kind, _ in _OUTPUT_WIDTHS
    }


def postprocess_yunet(
    predictions: dict,
    config: dict,
    orig_w: int,
    orig_h: int,
    scale: float,
    pad: tuple[int, int],
) -> dict:
    """Postprocess YuNet output to structured face detections."""
    conf_threshold = float(config.get("confidence", 0.5) or 0.5)
    input_size = int(config.get("inputSize", 640))
    nms_iou = float(config.get("nmsIouThreshold", DEFAULT_NMS_IOU))

    check_outputs(predictions, input_size)

    candidates: list[dict] = []
    for stride in STRIDES:
        cols = grid_cols(stride, input_size)
        t = _stride_tensors(predictions, stride)
        bbox = t["bbox"].reshape(-1, 4)
        kps = t["kps"].reshape(-1, 2 * NUM_LANDMARKS)
        # numpy only PRE-filters, conservatively: sqrt(cls·obj) <= max(cls, obj),
        # so a prior below the threshold on both tensors cannot pass. The
        # decision itself is `score_of`, per prior.
        maybe = np.flatnonzero(np.maximum(t["cls"], t["obj"]) >= conf_threshold)
        for index in maybe.tolist():
            score = score_of(float(t["cls"][index]), float(t["obj"][index]))
            if score < conf_threshold:
                continue
            row, col = prior_cell(index, cols)
            (x1, y1, x2, y2), points = decode_prior(
                stride, row, col, bbox[index].tolist(), kps[index].tolist()
            )
            sx1, sy1 = to_source(x1, y1, scale, pad)
            sx2, sy2 = to_source(x2, y2, scale, pad)
            ox1, oy1 = max(0.0, min(orig_w, sx1)), max(0.0, min(orig_h, sy1))
            ox2, oy2 = max(0.0, min(orig_w, sx2)), max(0.0, min(orig_h, sy2))
            if (ox2 - ox1) < 1 or (oy2 - oy1) < 1:
                continue
            landmarks = []
            for px, py in points:
                lx, ly = to_source(px, py, scale, pad)
                landmarks.append({"x": round(lx, 1), "y": round(ly, 1)})
            candidates.append({
                "class": "face",
                "score": round(score, 4),
                "bbox": [round(ox1, 1), round(oy1, 1), round(ox2, 1), round(oy2, 1)],
                "landmarks": landmarks,
                "_xyxy": (ox1, oy1, ox2, oy2),
            })

    capped, dropped = cap_top_k(candidates)
    if dropped:
        _log_top_k_drop(dropped, len(candidates))
    kept = nms(capped, nms_iou)
    for det in kept:
        del det["_xyxy"]
    return {"kind": "detections", "detections": kept}
