"""Baseline vs candidate on the holdout, through the hub's own evaluation harness.

The harness (``_vendor/camstack_eval``, byte-identical to
``scripts/eval/camstack_eval``) runs both models with the inference pool's
letterbox and decode, scores P/R/AP50 per macro class, camera, day/night and
small subjects, and proposes the candidate's floors by the D739 rule against
the baseline's shipped floors. Only COMPLETE holdout frames are ground truth.

The baseline is the catalog ONNX the hub names (``baseline.onnxUrl``), fetched
once into the cache volume. The candidate is the exported ONNX; the INT8 IR is
evaluated separately, as its own model with its own floors.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Sequence

from ._vendor import ensure_pipeline_on_path
from ._vendor.camstack_eval.compare import compare_models
from ._vendor.camstack_eval.dataset import EvalFrame, load_export
from ._vendor.camstack_eval.floors import FloorPolicy
from ._vendor.camstack_eval.metrics import Detection
from .replay import Fetch
from .spec import JobSpec

Detector = Callable[[bytes], Sequence[Detection]]
DetectorFactory = Callable[[str, int], Detector]


def harness_detector(model_path: str, input_size: int) -> Detector:
    ensure_pipeline_on_path()
    from ._vendor.camstack_eval.pipeline import make_detector

    return make_detector(model_path, input_size).detect


def policy_of(job: JobSpec) -> FloorPolicy:
    return FloorPolicy(min_support=job.floors.min_support, clamp=job.floors.clamp)


def baseline_model(job: JobSpec, cache: Path, fetch: Fetch) -> Path:
    digest = hashlib.sha256(job.baseline.onnx_url.encode()).hexdigest()[:16]
    target = cache / "baselines" / f"{digest}.onnx"
    if not target.is_file():
        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_suffix(".part")
        partial.write_bytes(fetch(job.baseline.onnx_url))
        partial.rename(target)
    return target


def holdout_frames(dataset_root: Path, frame_ids: set[str]) -> list[EvalFrame]:
    return [f for f in load_export(str(dataset_root), complete_only=True) if f.truth.frame_id in frame_ids]


def map50(report: Optional[dict]) -> Optional[float]:
    """Mean AP50 of the candidate over the classes that have one."""
    if report is None:
        return None
    values = [c["candidate"]["ap50"] for c in report.get("classes", {}).values() if c["candidate"]["ap50"] is not None]
    return round(sum(values) / len(values), 4) if values else None


@dataclass(frozen=True)
class Evaluation:
    candidate: Optional[dict]
    candidate_int8: Optional[dict]
    holdout_frames: int


def evaluate(
    job: JobSpec,
    frames: Sequence[EvalFrame],
    baseline_path: Path,
    candidate_onnx: Path,
    candidate_int8: Optional[Path],
    make: DetectorFactory = harness_detector,
) -> Evaluation:
    """Each report holds ``baseline`` and ``candidate`` per class (the harness's shape)."""
    if not frames:
        return Evaluation(None, None, 0)
    baseline = make(str(baseline_path), job.baseline.imgsz)
    policy = policy_of(job)
    floors = dict(job.baseline.floors)
    candidate = compare_models(frames, baseline, make(str(candidate_onnx), job.base.imgsz), floors, policy=policy)
    int8 = None
    if candidate_int8 is not None:
        int8 = compare_models(frames, baseline, make(str(candidate_int8), job.base.imgsz), floors, policy=policy)
    return Evaluation(candidate, int8, len(frames))


def split_reports(evaluation: Evaluation) -> dict:
    """The result.json ``evaluation`` block: baseline / candidate / candidateInt8."""

    def side(report: Optional[dict], key: str) -> Optional[dict]:
        if report is None:
            return None
        return {
            "frames": report["frames"],
            "classes": {cls: {"positives": c["positives"], **c[key]} for cls, c in report["classes"].items()},
        }

    def deltas(report: Optional[dict]) -> Optional[dict]:
        if report is None:
            return None
        return {cls: c["recallDeltaByCamera"] for cls, c in report["classes"].items()}

    return {
        "holdoutFrames": evaluation.holdout_frames,
        "baseline": side(evaluation.candidate, "baseline"),
        "candidate": side(evaluation.candidate, "candidate"),
        "candidateInt8": side(evaluation.candidate_int8, "candidate"),
        "recallDeltaByCamera": deltas(evaluation.candidate),
        "map50": {"candidate": map50(evaluation.candidate), "candidateInt8": map50(evaluation.candidate_int8)},
    }
