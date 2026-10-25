"""COCO → CamStack macro classes, as the pipeline maps them
(`packages/types/src/catalogs/coco-classmap.ts` `COCO_TO_MACRO`). The floors
and the comparison are per macro class, because that is what the pipeline
gates on. `package` (COCO luggage proxies) is mapped but not evaluated by
default: it was too rare to calibrate (D739 keeps it at 0.50)."""
from __future__ import annotations

from typing import Optional

from .metrics import Detection

COCO_TO_MACRO: dict[str, str] = {
    "person": "person",
    **{k: "vehicle" for k in ("bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat")},
    **{
        k: "animal"
        for k in ("bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe")
    },
    **{k: "package" for k in ("suitcase", "backpack", "handbag")},
}

#: Macro classes a root detector is evaluated on.
DETECTOR_CLASSES: tuple[str, ...] = ("person", "vehicle", "animal")


def macro_of(label: str) -> Optional[str]:
    """A label's macro class; a label that already IS a macro maps to itself."""
    if label in DETECTOR_CLASSES or label == "package":
        return label
    return COCO_TO_MACRO.get(label)


def to_macro(detections: list[Detection]) -> list[Detection]:
    """Map detections to macro classes; a class the pipeline drops is dropped."""
    out = []
    for d in detections:
        macro = macro_of(d.cls)
        if macro is not None:
            out.append(Detection(macro, d.score, d.bbox))
    return out
