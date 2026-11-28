"""Pseudo ground truth from two teacher detectors — the 2026-10-07 method.

"Two large reference detectors (YOLO26-X at 1280 px and RT-DETR-X at 640 px)
are run on every frame; an object counts when both agree (or one is very
confident). Uncertain boxes are don't care." The original scripts were lost
with a session scratchpad; the thresholds below are the documented SHAPE of
the rule with defaults chosen here, not the exact values of that run.
Detections must already be in macro classes (`classes.to_macro`).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from .metrics import MATCH_IOU, Detection, GroundTruthBox, iou


@dataclass(frozen=True)
class PseudoGtPolicy:
    #: Both teachers at or above this, same class, IoU >= 0.5 ⇒ positive.
    agree_score: float = 0.3
    #: One teacher alone at or above this ⇒ positive.
    solo_score: float = 0.8
    #: A box a teacher holds at or above this that is not a positive ⇒ don't care.
    care_score: float = 0.3


def pseudo_ground_truth(
    teacher_a: Sequence[Detection],
    teacher_b: Sequence[Detection],
    policy: PseudoGtPolicy = PseudoGtPolicy(),
) -> tuple[list[GroundTruthBox], list[GroundTruthBox]]:
    positives: list[GroundTruthBox] = []
    used_b: set[int] = set()
    leftovers: list[Detection] = []
    for a in sorted(teacher_a, key=lambda d: -d.score):
        partner = -1
        if a.score >= policy.agree_score:
            for j, b in enumerate(teacher_b):
                if j in used_b or b.cls != a.cls or b.score < policy.agree_score:
                    continue
                if iou(a.bbox, b.bbox) >= MATCH_IOU:
                    partner = j
                    break
        if partner >= 0:
            used_b.add(partner)
            positives.append(GroundTruthBox(a.cls, a.bbox))
        elif a.score >= policy.solo_score:
            positives.append(GroundTruthBox(a.cls, a.bbox))
        else:
            leftovers.append(a)
    for j, b in enumerate(teacher_b):
        if j in used_b:
            continue
        duplicate = any(p.cls == b.cls and iou(p.bbox, b.bbox) >= MATCH_IOU for p in positives)
        if duplicate:
            continue
        if b.score >= policy.solo_score:
            positives.append(GroundTruthBox(b.cls, b.bbox))
        else:
            leftovers.append(b)
    dont_care = [
        GroundTruthBox(d.cls, d.bbox)
        for d in leftovers
        if d.score >= policy.care_score
        and not any(p.cls == d.cls and iou(p.bbox, d.bbox) >= MATCH_IOU for p in positives)
    ]
    return positives, dont_care
