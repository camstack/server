"""One training job, end to end: prepare → replay → train → export → eval → package.

Everything heavy is injected (:class:`Deps`) so the orchestration is tested
without torch, Ultralytics or OpenVINO. ``result.json`` is written on every
exit, success or failure, and the last line is always a ``done`` event.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .dataset import coco_80, extract_archive, frames_from_manifest, verify_archive, write_layout
from .errors import EXIT_INTERNAL, EXIT_OK, TrainerError
from .evaluate import DetectorFactory, Evaluation, baseline_model, evaluate, harness_detector, holdout_frames, map50, policy_of, split_reports
from .events import Emitter
from .export import SubprocessToolchain, Toolchain, calibration_frames, export_all, remove_export
from .floors import floors_block
from .manifest import (
    LICENCE, RESULT_SCHEMA, catalog_draft, failed_result, file_rows, toolchain_versions,
    trainer_block, write_bundle, write_result,
)
from .replay import Fetch, http_fetch, prepare_replay
from .spec import JobSpec
from .split import SplitResult, assign
from .train_det import Trainer, TrainOutcome, ultralytics_train, write_data_yaml


@dataclass
class Deps:
    fetch: Fetch = http_fetch
    trainer: Trainer = ultralytics_train
    toolchain: Toolchain = field(default_factory=SubprocessToolchain)
    detector: DetectorFactory = harness_detector
    emitter: Emitter = field(default_factory=Emitter)


@dataclass(frozen=True)
class Paths:
    job: Path
    dataset: Path
    out: Path
    cache: Path
    work: Path


def _int8_gate(job: JobSpec, evaluation: Evaluation, produced: bool) -> dict:
    fp16, int8 = map50(evaluation.candidate), map50(evaluation.candidate_int8)
    if not produced:
        return {"kept": False, "map50Fp16": fp16, "map50Int8": None, "reason": "not exported"}
    if fp16 is None or int8 is None:
        return {"kept": True, "map50Fp16": fp16, "map50Int8": int8, "reason": "no holdout to gate on"}
    drop = round(fp16 - int8, 4)
    if drop > job.int8_gate.max_map50_drop:
        return {"kept": False, "map50Fp16": fp16, "map50Int8": int8, "reason": f"mAP50 drop {drop} > {job.int8_gate.max_map50_drop}"}
    return {"kept": True, "map50Fp16": fp16, "map50Int8": int8, "reason": None}


def _prepare(job: JobSpec, paths: Paths, emitter: Emitter) -> tuple[SplitResult, Path, Path]:
    emitter.stage("prepare")
    verify_archive(paths.dataset, job.dataset.sha256)
    source = paths.work / "export"
    manifest = extract_archive(paths.dataset, source)
    split = assign(frames_from_manifest(manifest), job.split)
    yolo = paths.work / "yolo"
    counts = write_layout({"train": list(split.train), "val": list(split.val)}, source, yolo)
    emitter.metric("frames.train", counts.frames.get("train", 0))
    emitter.metric("frames.val", counts.frames.get("val", 0))
    emitter.metric("frames.holdout", len(split.holdout))
    return split, source, yolo


def _dataset_block(job: JobSpec, split: SplitResult, replayed: int) -> dict:
    return {
        "versionId": job.dataset.version_id,
        "annotationHash": job.dataset.annotation_hash,
        "sha256": job.dataset.sha256,
        "frames": {"train": len(split.train), "val": len(split.val), "holdout": len(split.holdout)},
        "holdoutCameras": list(split.holdout_cameras),
        "replayImages": replayed,
    }


def _training_block(outcome: TrainOutcome) -> dict:
    return {
        "epochsRun": outcome.epochs_run,
        "bestEpoch": outcome.best_epoch,
        "bestMap50": outcome.best_map50,
        "bestMap50_95": outcome.best_map50_95,
        "seconds": outcome.seconds,
    }


def execute(job: JobSpec, paths: Paths, deps: Deps, partial: dict) -> dict:
    emitter = deps.emitter
    split, source, yolo = _prepare(job, paths, emitter)
    emitter.stage("replay")
    names = coco_80()
    replayed = prepare_replay(job.replay.count, paths.cache / "coco", yolo, names, deps.fetch)
    partial["dataset"] = _dataset_block(job, split, replayed)
    emitter.stage("train")
    data_yaml = write_data_yaml(yolo, names, replayed > 0, len(split.val) > 0)
    outcome = deps.trainer(job, data_yaml, paths.work, paths.cache, emitter)
    partial["training"] = _training_block(outcome)
    emitter.stage("export")
    staging = paths.work / "artifacts"
    calib = calibration_frames(yolo / "images" / "train", job.calibration.max_frames)
    exported = export_all(list(job.exports), outcome.best_pt, job.catalog.id, job.base.imgsz, calib, staging, deps.toolchain)
    emitter.stage("eval")
    int8_path = staging / f"{job.catalog.id}-int8.xml" if "openvino-int8" in exported.produced else None
    frames = holdout_frames(source, {f.frame_id for f in split.holdout_eval})
    baseline = baseline_model(job, paths.cache, deps.fetch) if frames else None
    evaluation = (
        evaluate(job, frames, baseline, staging / f"{job.catalog.id}.onnx", int8_path, deps.detector)
        if baseline is not None else Evaluation(None, None, 0)
    )
    gate = _int8_gate(job, evaluation, int8_path is not None)
    if int8_path is not None and not gate["kept"]:
        remove_export(staging, job.catalog.id, "openvino-int8")
        exported.drop("openvino-int8", gate["reason"])
    floors = floors_block(evaluation.candidate, evaluation.candidate_int8, dict(job.baseline.floors), policy_of(job), gate["kept"] and int8_path is not None)
    emitter.stage("package")
    rows = file_rows(staging, job.catalog.id)
    for row in rows:
        emitter.artifact(row["path"], row["bytes"], row["sha256"])
    bundle = write_bundle(staging, rows, paths.out / "bundle.tar")
    return {
        "schema": RESULT_SCHEMA,
        "jobKey": job.job_key,
        "status": "succeeded",
        "error": None,
        "trainer": trainer_block(),
        "toolchain": toolchain_versions(),
        **partial,
        "evaluation": split_reports(evaluation),
        "floors": floors,
        "int8": gate,
        "exportsDropped": exported.dropped,
        "files": rows,
        "bundle": bundle,
        "catalogDraft": catalog_draft(job, rows, floors),
        "licence": LICENCE,
    }


def scrub(message: str, paths: Paths) -> str:
    """No frame path leaves the container: every one lives under the work dir."""
    return message.replace(str(paths.work), "<work>").replace(str(paths.dataset), "<dataset>")[:300]


def run_job(job: JobSpec, paths: Paths, deps: Optional[Deps] = None) -> int:
    deps = deps or Deps()
    partial: dict = {}
    try:
        result = execute(job, paths, deps, partial)
        code, status = EXIT_OK, "succeeded"
    except TrainerError as exc:
        deps.emitter.error(exc.stage, exc.code, exc.message)
        result, code, status = {**failed_result(job.job_key, exc.as_dict()), **partial}, exc.exit_code, "failed"
    except Exception as exc:  # anything unforeseen: still a result and a done line
        message = scrub(f"{type(exc).__name__}: {exc}", paths)
        error = {"stage": "internal", "code": "internal", "message": message}
        deps.emitter.error("internal", "internal", message)
        result, code, status = {**failed_result(job.job_key, error), **partial}, EXIT_INTERNAL, "failed"
    digest = write_result(paths.out / "result.json", result)
    deps.emitter.done(status, digest)
    return code
