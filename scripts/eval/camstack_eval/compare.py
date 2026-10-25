"""Baseline vs candidate on one holdout.

Both models are run on the same frames. The candidate's floors come from the
D739 rule against the baseline's shipped floors (`floors.propose_floor`), and
the candidate is reported AT those floors — "same false-alert rate, what more
does it find". Per-camera recall deltas are what a promotion gate reads
(analysis §6: no camera may lose more than 0.01 of person recall).
"""
from __future__ import annotations

from typing import Callable, Iterable, Optional, Sequence

from .classes import DETECTOR_CLASSES, to_macro
from .dataset import EvalFrame
from .floors import FloorPolicy, ScoredDetection, propose_floor
from .metrics import ClassResult, Detection, FrameTruth, average_precision, evaluate_class, scored_detections

Detector = Callable[[bytes], Sequence[Detection]]


def select_holdout(
    frames: Iterable[EvalFrame],
    cameras: Optional[Sequence[int]] = None,
    since: Optional[int] = None,
) -> list[EvalFrame]:
    """Holdout by whole cameras and/or by capture time — never by random frame."""
    wanted = set(cameras) if cameras else None
    out = []
    for f in frames:
        if wanted is not None and f.truth.camera not in wanted:
            continue
        if since is not None and (f.captured_at is None or f.captured_at < since):
            continue
        out.append(f)
    return out


def _run(frames: Sequence[EvalFrame], detector: Detector) -> list[tuple[FrameTruth, list[Detection]]]:
    return [(f.truth, to_macro(list(detector(f.read())))) for f in frames]


def _summary(result: ClassResult, ap: Optional[float]) -> dict:
    return {
        "floor": result.floor,
        "tp": result.tp,
        "fp": result.fp,
        "fn": result.fn,
        "precision": result.precision,
        "recall": result.recall,
        "ap50": ap,
        "recallByCamera": {str(k): v for k, v in sorted(result.recall_by_camera.items())},
        "recallByLight": dict(sorted(result.recall_by_light.items())),
        "fpByCamera": {str(k): v for k, v in sorted(result.fp_by_camera.items())},
        "smallFound": result.small_found,
        "smallTotal": result.small_total,
    }


def compare_models(
    frames: Sequence[EvalFrame],
    baseline: Detector,
    candidate: Detector,
    baseline_floors: dict[str, float],
    candidate_floors: Optional[dict[str, float]] = None,
    policy: FloorPolicy = FloorPolicy(),
    classes: Sequence[str] = DETECTOR_CLASSES,
) -> dict:
    base_runs = _run(frames, baseline)
    cand_runs = _run(frames, candidate)
    report: dict = {"frames": len(frames), "classes": {}}
    for cls in classes:
        base_floor = baseline_floors[cls]
        base_scored, positives = scored_detections(cls, base_runs)
        cand_scored, _ = scored_detections(cls, cand_runs)
        proposed = propose_floor(
            [ScoredDetection(d.score, d.true_positive) for d in base_scored],
            base_floor,
            [ScoredDetection(d.score, d.true_positive) for d in cand_scored],
            positives,
            policy,
        )
        cand_floor = (candidate_floors or {}).get(cls, proposed.value)
        base = evaluate_class(cls, base_runs, base_floor)
        cand = evaluate_class(cls, cand_runs, cand_floor)
        deltas = {}
        for cam, recall in cand.recall_by_camera.items():
            before = base.recall_by_camera.get(cam)
            if recall is not None and before is not None:
                deltas[str(cam)] = round(recall - before, 4)
        report["classes"][cls] = {
            "positives": positives,
            "baseline": _summary(base, average_precision(cls, base_runs)),
            "candidate": _summary(cand, average_precision(cls, cand_runs)),
            "proposedFloor": {
                "value": proposed.value,
                "reason": proposed.reason,
                "fpBudget": proposed.fp_budget,
                "fitted": proposed.fitted,
            },
            "recallDeltaByCamera": dict(sorted(deltas.items())),
        }
    return report
