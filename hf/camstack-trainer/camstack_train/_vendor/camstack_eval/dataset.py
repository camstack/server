"""The hub's annotated export (`annotations.json`, schema
`camstack.retrain-export/v2`) as an evaluation set.

Only frames the operator marked ``complete`` ("all subjects boxed") are ground
truth by default: on any other frame an unboxed person would be scored as a
false positive. ``subject`` annotations of a detector macro class are the
positives; ``model_error`` boxes mark a region the model got wrong and are not
positives (a detection there is a false positive, as it should be).

Works on the tar itself or on an extracted directory.
"""
from __future__ import annotations

import json
import tarfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from .classes import DETECTOR_CLASSES
from .metrics import FrameTruth, GroundTruthBox

MANIFEST = "annotations.json"


@dataclass(frozen=True)
class EvalFrame:
    truth: FrameTruth
    path: str
    captured_at: Optional[int]
    read: Callable[[], bytes]


def _night(entry: dict) -> Optional[bool]:
    lighting = entry.get("lighting")
    return None if not isinstance(lighting, dict) else bool(lighting.get("night"))


def _truth(entry: dict, classes: tuple[str, ...]) -> FrameTruth:
    boxes = []
    for a in entry.get("annotations", []):
        if a.get("kind") != "subject" or a.get("macroClass") not in classes:
            continue
        b = a["bbox"]
        boxes.append(GroundTruthBox(a["macroClass"], (b["x"], b["y"], b["w"], b["h"])))
    return FrameTruth(
        frame_id=entry["frameId"],
        camera=int(entry["deviceId"]),
        night=_night(entry),
        boxes=tuple(boxes),
    )


def load_export(
    source: str,
    complete_only: bool = True,
    classes: tuple[str, ...] = DETECTOR_CLASSES,
) -> list[EvalFrame]:
    root = Path(source)
    if root.is_dir():
        manifest = json.loads((root / MANIFEST).read_text("utf-8"))

        def reader(path: str) -> Callable[[], bytes]:
            return lambda: (root / path).read_bytes()
    else:
        with tarfile.open(root) as tar:
            member = tar.extractfile(MANIFEST)
            if member is None:
                raise ValueError(f"{source}: no {MANIFEST}")
            manifest = json.loads(member.read().decode("utf-8"))

        def reader(path: str) -> Callable[[], bytes]:
            def read() -> bytes:
                with tarfile.open(root) as tar:
                    f = tar.extractfile(path)
                    if f is None:
                        raise FileNotFoundError(path)
                    return f.read()

            return read

    out = []
    for entry in manifest.get("frames", []):
        if complete_only and entry.get("complete") is not True:
            continue
        out.append(
            EvalFrame(
                truth=_truth(entry, classes),
                path=entry["path"],
                captured_at=entry.get("capturedAt"),
                read=reader(entry["path"]),
            )
        )
    return out


def _file_reader(path: Path) -> Callable[[], bytes]:
    return lambda: path.read_bytes()


def load_coco(
    annotations: str,
    images_dir: str,
    skip: int = 0,
    limit: Optional[int] = None,
    classes: tuple[str, ...] = DETECTOR_CLASSES,
) -> list[EvalFrame]:
    """COCO ``instances_*.json`` as an evaluation set, in macro classes.

    Images are taken in FILE-NAME order — the order the INT8 calibration reads
    the same folder (`convert_lib.calibration_images`) — after the first
    ``skip``, so ``skip`` = the calibration subset size keeps every calibration
    image out of the holdout. Every image counts, including those with no
    object of a macro class: a detection there is a false positive. A crowd
    box (``iscrowd``) is "don't care", as in COCO's own evaluation.
    """
    from .classes import macro_of

    data = json.loads(Path(annotations).read_text("utf-8"))
    names = {c["id"]: c["name"] for c in data["categories"]}
    by_image: dict[int, list[dict]] = {}
    for a in data["annotations"]:
        by_image.setdefault(a["image_id"], []).append(a)
    images = sorted(data["images"], key=lambda im: im["file_name"])[skip:]
    if limit is not None:
        images = images[:limit]
    root = Path(images_dir)
    out = []
    for im in images:
        w, h = float(im["width"]), float(im["height"])
        boxes, dont_care = [], []
        for a in by_image.get(im["id"], []):
            macro = macro_of(names[a["category_id"]])
            if macro not in classes:
                continue
            x, y, bw, bh = a["bbox"]
            gt = GroundTruthBox(macro, (x / w, y / h, bw / w, bh / h))
            (dont_care if a.get("iscrowd") else boxes).append(gt)
        out.append(
            EvalFrame(
                truth=FrameTruth(
                    frame_id=im["file_name"], camera=0, night=None,
                    boxes=tuple(boxes), dont_care=tuple(dont_care),
                ),
                path=im["file_name"],
                captured_at=None,
                read=_file_reader(root / im["file_name"]),
            )
        )
    return out


def load_pseudo_gt(source: str, frames_dir: Optional[str] = None) -> list[EvalFrame]:
    """A pseudo ground truth (schema ``camstack.pseudo-gt/v1``): per frame the
    positives and the "don't care" boxes of `pseudo_gt.pseudo_ground_truth`,
    normalised ``(x, y, w, h)``. Frames are read from ``frames_dir`` (default:
    the folder holding the JSON)."""
    path = Path(source)
    data = json.loads(path.read_text("utf-8"))
    if data.get("schema") != "camstack.pseudo-gt/v1":
        raise ValueError(f"{source}: not a camstack.pseudo-gt/v1 file")
    root = Path(frames_dir) if frames_dir else path.parent

    def boxes(rows: list[dict]) -> tuple[GroundTruthBox, ...]:
        return tuple(GroundTruthBox(r["cls"], tuple(r["bbox"])) for r in rows)

    return [
        EvalFrame(
            truth=FrameTruth(
                frame_id=f["file"],
                camera=int(f.get("deviceId", 0)),
                night=f.get("night"),
                boxes=boxes(f["boxes"]),
                dont_care=boxes(f.get("dontCare", [])),
            ),
            path=f["file"],
            captured_at=f.get("capturedAt"),
            read=_file_reader(root / f["file"]),
        )
        for f in data["frames"]
    ]
