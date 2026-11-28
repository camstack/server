"""The hub's annotated export → an Ultralytics YOLO layout.

Input: the retrain archive (``annotations.json`` first, then ``frames/…`` JPEGs;
schema ``camstack.retrain-export/v2`` or ``/v3``), exactly what
``pipelineAnalytics.writeRetrainArchive`` streams.

What becomes a label (COCO-80 ids, the head the fleet's root keeps):

- ``subject`` of macro ``person`` → ``person`` (0).
- ``subject`` of macro ``vehicle`` / ``animal`` → its COCO class, taken from the
  annotation's ``label`` (``car``, ``dog``…) when that label is a COCO class of
  the same macro. A vehicle or animal box WITHOUT such a label cannot be given
  a COCO class honestly (training "dog" on a cat teaches the wrong species), so
  its frame is left out of training and counted as ``unmappable``. Evaluation
  is per macro class and still uses it.
- ``model_error`` boxes are never positives: the region is learned as
  background, which is what marking a phantom asks for.
- ``package`` / ``face`` / ``plate`` boxes are not root-detector classes and are
  ignored (no label line).

Which frames TRAIN:

- every ``complete`` frame ("every subject is boxed"), including one with no
  subject at all — a hard negative;
- an INCOMPLETE frame only when it carries at least one annotation (a subject
  or a model error): the operator picked it to teach that box. YOLO has no
  "ignore region", so an unboxed subject on such a frame IS learned as
  background; restricting incomplete frames to annotated ones is the bound on
  that cost. Incomplete frames are never evaluated.

Files are renamed to neutral ``000001.jpg`` names: archive paths carry device
and track ids, and nothing the container writes or logs names a frame.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import tarfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Iterable, Optional

from ._vendor import ensure_pipeline_on_path
from ._vendor.camstack_eval.classes import COCO_TO_MACRO
from .errors import dataset_error

MANIFEST = "annotations.json"
ACCEPTED_SCHEMAS = ("camstack.retrain-export/v2", "camstack.retrain-export/v3")
IGNORED_MACROS = ("package", "face", "plate")


def coco_80() -> list[str]:
    ensure_pipeline_on_path()
    from postprocessors.yolo import COCO_80  # the pool's own label list

    return list(COCO_80)


@dataclass(frozen=True)
class YoloBox:
    cls_index: int
    cx: float
    cy: float
    w: float
    h: float

    def line(self) -> str:
        return f"{self.cls_index} {self.cx:.6f} {self.cy:.6f} {self.w:.6f} {self.h:.6f}"


@dataclass(frozen=True)
class Frame:
    frame_id: str
    path: str
    device_id: int
    captured_at: Optional[int]
    complete: bool
    labels: tuple[YoloBox, ...]
    subjects: int
    model_errors: int
    unmappable: int

    @property
    def trainable(self) -> bool:
        if self.unmappable > 0:
            return False
        return self.complete or (self.subjects + self.model_errors) > 0


@dataclass
class LayoutCounts:
    frames: dict[str, int] = field(default_factory=dict)
    boxes: dict[str, int] = field(default_factory=dict)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_archive(path: Path, expected_sha256: str) -> None:
    if not path.is_file():
        raise dataset_error("dataset-missing", "dataset.tar not found")
    actual = sha256_file(path)
    if actual != expected_sha256:
        raise dataset_error("dataset-sha256", "dataset.tar does not match the job's sha256")


def _safe_member(name: str) -> bool:
    pure = PurePosixPath(name)
    if pure.is_absolute() or ".." in pure.parts:
        return False
    return name == MANIFEST or (pure.parts[:1] == ("frames",) and pure.suffix.lower() == ".jpg")


def extract_archive(path: Path, dest: Path) -> dict:
    """Extract the manifest and the frame JPEGs only; return the manifest."""
    dest.mkdir(parents=True, exist_ok=True)
    try:
        with tarfile.open(path) as tar:
            for member in tar:
                if not member.isfile() or not _safe_member(member.name):
                    continue
                target = dest / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                source = tar.extractfile(member)
                if source is None:
                    continue
                with target.open("wb") as out:
                    shutil.copyfileobj(source, out)
    except tarfile.TarError as exc:
        raise dataset_error("dataset-unreadable", "dataset.tar is not a readable tar") from exc
    manifest_path = dest / MANIFEST
    if not manifest_path.is_file():
        raise dataset_error("dataset-no-manifest", "dataset.tar has no annotations.json")
    manifest = json.loads(manifest_path.read_text("utf-8"))
    if manifest.get("schema") not in ACCEPTED_SCHEMAS:
        raise dataset_error("dataset-schema", f"export schema {manifest.get('schema')!r} is not supported")
    return manifest


def _clamped(bbox: dict) -> Optional[tuple[float, float, float, float]]:
    x1 = max(0.0, float(bbox["x"]))
    y1 = max(0.0, float(bbox["y"]))
    x2 = min(1.0, float(bbox["x"]) + float(bbox["w"]))
    y2 = min(1.0, float(bbox["y"]) + float(bbox["h"]))
    if x2 - x1 <= 1e-4 or y2 - y1 <= 1e-4:
        return None
    return (x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1


def coco_index_for(macro: str, label: Optional[str], names: list[str]) -> Optional[int]:
    """The COCO-80 index a subject trains as, or ``None`` when none is honest."""
    if macro == "person":
        return names.index("person")
    wanted = (label or "").strip().lower()
    if wanted in names and COCO_TO_MACRO.get(wanted) == macro:
        return names.index(wanted)
    return None


def frame_from_entry(entry: dict, names: list[str]) -> Frame:
    labels: list[YoloBox] = []
    subjects = model_errors = unmappable = 0
    for annotation in entry.get("annotations", []):
        macro = annotation.get("macroClass")
        if annotation.get("kind") == "model_error":
            model_errors += 1
            continue
        if annotation.get("kind") != "subject" or macro in IGNORED_MACROS:
            continue
        subjects += 1
        index = coco_index_for(str(macro), annotation.get("label"), names)
        if index is None:
            unmappable += 1
            continue
        box = _clamped(annotation["bbox"])
        if box is not None:
            labels.append(YoloBox(index, *box))
    captured = entry.get("capturedAt")
    return Frame(
        frame_id=str(entry["frameId"]),
        path=str(entry["path"]),
        device_id=int(entry["deviceId"]),
        captured_at=int(captured) if isinstance(captured, (int, float)) else None,
        complete=entry.get("complete") is True,
        labels=tuple(labels),
        subjects=subjects,
        model_errors=model_errors,
        unmappable=unmappable,
    )


def frames_from_manifest(manifest: dict, names: Optional[list[str]] = None) -> list[Frame]:
    names = names if names is not None else coco_80()
    return [frame_from_entry(e, names) for e in manifest.get("frames", [])]


def write_split(frames: Iterable[Frame], source_root: Path, out_root: Path, split: str) -> tuple[int, int]:
    """Copy one split's frames + YOLO label files; returns (frames, boxes)."""
    images = out_root / "images" / split
    labels = out_root / "labels" / split
    images.mkdir(parents=True, exist_ok=True)
    labels.mkdir(parents=True, exist_ok=True)
    count = boxes = 0
    for frame in frames:
        source = source_root / frame.path
        if not source.is_file():
            continue
        count += 1
        stem = f"{count:06d}"
        shutil.copyfile(source, images / f"{stem}.jpg")
        (labels / f"{stem}.txt").write_text("".join(b.line() + "\n" for b in frame.labels), "utf-8")
        boxes += len(frame.labels)
    return count, boxes


def write_layout(splits: dict[str, list[Frame]], source_root: Path, out_root: Path) -> LayoutCounts:
    counts = LayoutCounts()
    for split, frames in splits.items():
        n, boxes = write_split(frames, source_root, out_root, split)
        counts.frames[split] = n
        counts.boxes[split] = boxes
    return counts
