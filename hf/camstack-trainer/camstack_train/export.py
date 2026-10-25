"""best.pt → ONNX → OpenVINO fp16 / int8 → CoreML fp16, into the staging dir.

Every artefact is named after the catalog id, because a node's models
directory is FLAT and a format's file is found by its URL's basename:

    <id>.pt   <id>.onnx   <id>-fp16.xml/.bin   <id>-int8.xml/.bin   <id>.mlpackage/

ONNX is required (every other format is built from it, and the evaluation runs
it): its failure fails the job. Each other format is isolated — a failure
drops THAT format with its reason (``exportsDropped``) and the job goes on;
CoreML on Linux is the expected casualty, and a Mac node can still convert the
ONNX later through Model Studio.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from .errors import EXIT_INTERNAL, TrainerError

#: Characters of a failed step's output kept as its reason.
REASON_CHARS = 400


class Toolchain(Protocol):
    def onnx(self, pt: Path, out: Path, imgsz: int) -> None: ...
    def openvino(self, onnx: Path, xml: Path, fp16: bool) -> None: ...
    def openvino_int8(self, onnx: Path, xml: Path, calib: list[Path], imgsz: int) -> None: ...
    def coreml(self, pt: Path, out: Path, imgsz: int) -> None: ...


class StepFailed(Exception):
    pass


class SubprocessToolchain:
    """Runs each step in a child (``camstack_train._steps``)."""

    def _run(self, step: str, payload: dict) -> None:
        proc = subprocess.run(
            [sys.executable, "-m", "camstack_train._steps", step, json.dumps(payload)],
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode != 0:
            tail = (proc.stderr or proc.stdout or "").strip()[-REASON_CHARS:]
            raise StepFailed(f"{step} exited {proc.returncode}: {tail}")

    def onnx(self, pt: Path, out: Path, imgsz: int) -> None:
        self._run("onnx", {"pt": str(pt), "out": str(out), "imgsz": imgsz})

    def openvino(self, onnx: Path, xml: Path, fp16: bool) -> None:
        self._run("openvino", {"onnx": str(onnx), "xml": str(xml), "fp16": fp16})

    def openvino_int8(self, onnx: Path, xml: Path, calib: list[Path], imgsz: int) -> None:
        self._run("openvino-int8", {"onnx": str(onnx), "xml": str(xml), "calib": [str(p) for p in calib], "imgsz": imgsz})

    def coreml(self, pt: Path, out: Path, imgsz: int) -> None:
        self._run("coreml", {"pt": str(pt), "out": str(out), "imgsz": imgsz})


@dataclass
class ExportOutcome:
    produced: list[str] = field(default_factory=list)
    dropped: list[dict[str, str]] = field(default_factory=list)

    def drop(self, export: str, reason: str) -> None:
        self.dropped.append({"export": export, "reason": reason[:REASON_CHARS]})


def artefact_names(catalog_id: str) -> dict[str, str]:
    return {
        "pt": f"{catalog_id}.pt",
        "onnx": f"{catalog_id}.onnx",
        "openvino-fp16": f"{catalog_id}-fp16.xml",
        "openvino-int8": f"{catalog_id}-int8.xml",
        "coreml-fp16": f"{catalog_id}.mlpackage",
    }


def _optional(outcome: ExportOutcome, export: str, run) -> None:
    try:
        run()
        outcome.produced.append(export)
    except Exception as exc:  # isolated: a format is dropped, the job goes on
        outcome.drop(export, str(exc) or type(exc).__name__)


def export_all(
    exports: list[str],
    best_pt: Path,
    catalog_id: str,
    imgsz: int,
    calib: list[Path],
    staging: Path,
    toolchain: Toolchain,
) -> ExportOutcome:
    names = artefact_names(catalog_id)
    staging.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(best_pt, staging / names["pt"])
    onnx = staging / names["onnx"]
    outcome = ExportOutcome()
    try:
        toolchain.onnx(best_pt, onnx, imgsz)
    except Exception as exc:
        raise TrainerError("export", "export-onnx", f"ONNX export failed: {str(exc)[:REASON_CHARS]}", EXIT_INTERNAL) from exc
    outcome.produced.append("onnx")
    if "openvino-fp16" in exports:
        _optional(outcome, "openvino-fp16", lambda: toolchain.openvino(onnx, staging / names["openvino-fp16"], True))
    if "openvino-int8" in exports:
        if not calib:
            outcome.drop("openvino-int8", "no calibration frames in the train split")
        else:
            _optional(
                outcome,
                "openvino-int8",
                lambda: toolchain.openvino_int8(onnx, staging / names["openvino-int8"], calib, imgsz),
            )
    if "coreml-fp16" in exports:
        _optional(outcome, "coreml-fp16", lambda: toolchain.coreml(best_pt, staging / names["coreml-fp16"], imgsz))
    return outcome


def remove_export(staging: Path, catalog_id: str, export: str) -> None:
    """Delete one format's files from the staging dir (the int8 gate)."""
    main = staging / artefact_names(catalog_id)[export]
    for path in (main, main.with_suffix(".bin")):
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()


def calibration_frames(train_images: Path, max_frames: int) -> list[Path]:
    """The first ``max_frames`` of the user's own TRAIN frames, in name order."""
    return sorted(p for p in train_images.glob("*.jpg"))[:max_frames]
