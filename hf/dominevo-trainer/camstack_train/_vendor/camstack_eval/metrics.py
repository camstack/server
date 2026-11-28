"""Detection metrics against a ground truth, the way the 2026-10-07 detector
comparison measured them (docs/benchmarks/2026-10-07-detector-comparison.md).

Boxes are normalised ``(x, y, w, h)`` against the full frame. A detection is a
true positive when it overlaps an unmatched ground-truth box of the same macro
class at IoU >= 0.5 (greedy, highest score first); a detection on a
"don't care" box is ignored; everything else is a false positive. Greedy in
score order makes the matching threshold-consistent: raising the floor only
truncates the list, so one pass serves every floor and AP50.

"Small" follows the comparison: a box under 100 px tall in a 960x540 frame,
i.e. under 100/540 of the frame height.

AP50-95 is the COCO average of AP over the IoU thresholds 0.50, 0.55 … 0.95,
each matched the same greedy way (a "don't care" box is still ignored at IoU
0.5). It is computed per macro class, at the pool floor, so it is lower than an
Ultralytics `val` mAP (floor 0.001, 80 classes): compare it only with itself.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Optional, Sequence

Box = tuple[float, float, float, float]

MATCH_IOU = 0.5
SMALL_HEIGHT_FRACTION = 100 / 540
#: COCO's AP50-95 thresholds.
COCO_IOUS: tuple[float, ...] = tuple(round(0.5 + 0.05 * i, 2) for i in range(10))


@dataclass(frozen=True)
class GroundTruthBox:
    cls: str
    bbox: Box


@dataclass(frozen=True)
class Detection:
    cls: str
    score: float
    bbox: Box


@dataclass(frozen=True)
class FrameTruth:
    frame_id: str
    camera: int
    #: ``True`` night/IR, ``False`` day, ``None`` unknown.
    night: Optional[bool]
    boxes: tuple[GroundTruthBox, ...]
    dont_care: tuple[GroundTruthBox, ...] = ()


@dataclass(frozen=True)
class MatchedDetection:
    """One detection of the class, after matching: what floors and AP use."""

    score: float
    true_positive: bool


@dataclass
class ClassResult:
    cls: str
    floor: float
    tp: int = 0
    fp: int = 0
    fn: int = 0
    small_found: int = 0
    small_total: int = 0
    recall_by_camera: dict = field(default_factory=dict)
    recall_by_light: dict = field(default_factory=dict)
    fp_by_camera: dict = field(default_factory=dict)

    @property
    def precision(self) -> Optional[float]:
        return None if self.tp + self.fp == 0 else self.tp / (self.tp + self.fp)

    @property
    def recall(self) -> Optional[float]:
        return None if self.tp + self.fn == 0 else self.tp / (self.tp + self.fn)


def iou(a: Box, b: Box) -> float:
    ax2, ay2 = a[0] + a[2], a[1] + a[3]
    bx2, by2 = b[0] + b[2], b[1] + b[3]
    iw = max(0.0, min(ax2, bx2) - max(a[0], b[0]))
    ih = max(0.0, min(ay2, by2) - max(a[1], b[1]))
    inter = iw * ih
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


def is_small(bbox: Box) -> bool:
    return bbox[3] < SMALL_HEIGHT_FRACTION


def light_bucket(night: Optional[bool]) -> str:
    return "unknown" if night is None else ("night" if night else "day")


@dataclass(frozen=True)
class _FrameMatch:
    #: (score, verdict) per detection of the class, highest score first;
    #: verdict is "tp", "fp" or "ignored".
    detections: tuple[tuple[float, str], ...]
    #: per ground-truth box: the score that matched it, or None.
    gt_scores: tuple[Optional[float], ...]


def _match_frame(
    cls: str, truth: FrameTruth, detections: Sequence[Detection], match_iou: float = MATCH_IOU
) -> _FrameMatch:
    gts = [g for g in truth.boxes if g.cls == cls]
    cares = [g for g in truth.dont_care if g.cls == cls]
    gt_scores: list[Optional[float]] = [None] * len(gts)
    verdicts: list[tuple[float, str]] = []
    for det in sorted((d for d in detections if d.cls == cls), key=lambda d: -d.score):
        best, best_iou = -1, match_iou
        for i, g in enumerate(gts):
            if gt_scores[i] is not None:
                continue
            overlap = iou(det.bbox, g.bbox)
            if overlap >= best_iou:
                best, best_iou = i, overlap
        if best >= 0:
            gt_scores[best] = det.score
            verdicts.append((det.score, "tp"))
        elif any(iou(det.bbox, c.bbox) >= MATCH_IOU for c in cares):
            verdicts.append((det.score, "ignored"))
        else:
            verdicts.append((det.score, "fp"))
    return _FrameMatch(tuple(verdicts), tuple(gt_scores))


def _ratio(hit: int, total: int) -> Optional[float]:
    return None if total == 0 else hit / total


def evaluate_class(
    cls: str,
    frames: Iterable[tuple[FrameTruth, Sequence[Detection]]],
    floor: float,
) -> ClassResult:
    result = ClassResult(cls=cls, floor=floor)
    by_camera: dict[int, list[int]] = {}
    by_light: dict[str, list[int]] = {}
    for truth, detections in frames:
        match = _match_frame(cls, truth, detections)
        gts = [g for g in truth.boxes if g.cls == cls]
        for score, verdict in match.detections:
            if score < floor or verdict == "ignored":
                continue
            if verdict == "tp":
                result.tp += 1
            else:
                result.fp += 1
                result.fp_by_camera[truth.camera] = result.fp_by_camera.get(truth.camera, 0) + 1
        for g, score in zip(gts, match.gt_scores):
            found = score is not None and score >= floor
            if not found:
                result.fn += 1
            cam = by_camera.setdefault(truth.camera, [0, 0])
            light = by_light.setdefault(light_bucket(truth.night), [0, 0])
            cam[0] += int(found)
            cam[1] += 1
            light[0] += int(found)
            light[1] += 1
            if is_small(g.bbox):
                result.small_total += 1
                result.small_found += int(found)
    result.recall_by_camera = {k: _ratio(*v) for k, v in by_camera.items()}
    result.recall_by_light = {k: _ratio(*v) for k, v in by_light.items()}
    return result


def scored_detections(
    cls: str,
    frames: Iterable[tuple[FrameTruth, Sequence[Detection]]],
    match_iou: float = MATCH_IOU,
) -> tuple[list[MatchedDetection], int]:
    """Every detection of the class with its verdict (ignored ones dropped),
    and the number of ground-truth positives. Feeds AP50 and the floor rule."""
    out: list[MatchedDetection] = []
    positives = 0
    for truth, detections in frames:
        match = _match_frame(cls, truth, detections, match_iou)
        positives += sum(1 for g in truth.boxes if g.cls == cls)
        out.extend(MatchedDetection(s, v == "tp") for s, v in match.detections if v != "ignored")
    return out, positives


def ap_from_matches(scores: Sequence[float], true_positive: Sequence[bool], positives: int) -> Optional[float]:
    """AP, all-point interpolated (VOC 2010+), from matched detections in any
    order. ``None`` with no positives. Ties keep their given order."""
    if positives == 0:
        return None
    order = sorted(range(len(scores)), key=lambda i: -scores[i])
    tp = fp = 0
    precisions: list[float] = []
    hits: list[bool] = []
    for i in order:
        hit = bool(true_positive[i])
        tp += int(hit)
        fp += int(not hit)
        precisions.append(tp / (tp + fp))
        hits.append(hit)
    # Precision envelope: the best precision at this recall or any higher one.
    best = 0.0
    for i in range(len(precisions) - 1, -1, -1):
        best = max(best, precisions[i])
        precisions[i] = best
    return sum(p for p, hit in zip(precisions, hits) if hit) / positives


def average_precision(
    cls: str,
    frames: Iterable[tuple[FrameTruth, Sequence[Detection]]],
    match_iou: float = MATCH_IOU,
) -> Optional[float]:
    """AP at IoU ``match_iou`` (0.5 by default), all-point interpolated (VOC 2010+).
    ``None`` with no positives."""
    scored, positives = scored_detections(cls, frames, match_iou)
    return ap_from_matches([d.score for d in scored], [d.true_positive for d in scored], positives)


def average_precision_coco(
    cls: str, frames: Sequence[tuple[FrameTruth, Sequence[Detection]]]
) -> Optional[float]:
    """AP50-95: the mean AP over ``COCO_IOUS``. ``None`` with no positives."""
    aps = [average_precision(cls, frames, t) for t in COCO_IOUS]
    return None if aps[0] is None else sum(a for a in aps if a is not None) / len(aps)


@dataclass(frozen=True)
class FrameMatches:
    """One frame's matched detections of one class at one IoU: what a
    bootstrap re-uses, since matching is per frame."""

    scores: tuple[float, ...]
    true_positive: tuple[bool, ...]
    positives: int


def frame_matches(
    cls: str, frames: Sequence[tuple[FrameTruth, Sequence[Detection]]], match_iou: float
) -> list[FrameMatches]:
    out = []
    for truth, detections in frames:
        match = _match_frame(cls, truth, detections, match_iou)
        kept = [(s, v == "tp") for s, v in match.detections if v != "ignored"]
        out.append(
            FrameMatches(
                tuple(s for s, _ in kept),
                tuple(t for _, t in kept),
                sum(1 for g in truth.boxes if g.cls == cls),
            )
        )
    return out


def ap_of_sample(matches: Sequence[FrameMatches], sample: Iterable[int]) -> Optional[float]:
    """AP over the frames ``sample`` (indices, repeats allowed) of ``matches``."""
    scores: list[float] = []
    hits: list[bool] = []
    positives = 0
    for i in sample:
        m = matches[i]
        scores.extend(m.scores)
        hits.extend(m.true_positive)
        positives += m.positives
    return ap_from_matches(scores, hits, positives)
