"""The candidate's per-class floors, by the D739 rule, with their reasons.

The rule itself is the harness's (``_vendor/camstack_eval/floors.py``): the
lowest grid floor at which the candidate raises no more false positives on the
holdout than the baseline does at its shipped floor; a class with fewer than
``minSupport`` holdout positives inherits the baseline's floor; the result is
clamped to ±``clamp`` of it. This module turns the harness's per-class
proposals into the ``floors`` block of result.json, with one human note per
class that did not get a fitted floor — and inherits every floor when there
was no holdout to fit on.
"""
from __future__ import annotations

from typing import Optional, Sequence

from ._vendor.camstack_eval.floors import FloorPolicy, ProposedFloor, ScoredDetection, propose_floor
from .spec import FLOOR_CLASSES


def propose(
    baseline: Sequence[ScoredDetection],
    baseline_floor: float,
    candidate: Sequence[ScoredDetection],
    positives: int,
    policy: FloorPolicy,
) -> ProposedFloor:
    return propose_floor(baseline, baseline_floor, candidate, positives, policy)


def note_for(cls: str, proposal: dict, positives: int, baseline_floor: float, policy: FloorPolicy) -> Optional[str]:
    reason = proposal["reason"]
    if reason == "low-support":
        return f"{cls}: {positives} holdout positives < {policy.min_support}, inherits {baseline_floor}"
    if reason == "clamped":
        fitted = proposal.get("fitted")
        fit = "no grid floor met the false-positive budget" if fitted is None else f"fitted {fitted}"
        return f"{cls}: {fit}, clamped to {proposal['value']} (±{policy.clamp} of {baseline_floor})"
    return None


def floors_from_report(
    report: Optional[dict], baseline_floors: dict[str, float], policy: FloorPolicy
) -> tuple[dict[str, float], list[str]]:
    """(floors, notes) for one candidate report; no report ⇒ the baseline's floors."""
    if report is None:
        return {c: baseline_floors[c] for c in FLOOR_CLASSES}, [
            "no complete holdout frame: every floor inherits the baseline"
        ]
    floors: dict[str, float] = {}
    notes: list[str] = []
    for cls in FLOOR_CLASSES:
        entry = report["classes"].get(cls)
        if entry is None:
            floors[cls] = baseline_floors[cls]
            notes.append(f"{cls}: not evaluated, inherits {baseline_floors[cls]}")
            continue
        proposal = entry["proposedFloor"]
        floors[cls] = float(proposal["value"])
        note = note_for(cls, proposal, int(entry["positives"]), baseline_floors[cls], policy)
        if note is not None:
            notes.append(note)
    return floors, notes


def floors_block(
    candidate: Optional[dict],
    candidate_int8: Optional[dict],
    baseline_floors: dict[str, float],
    policy: FloorPolicy,
    int8_present: bool,
) -> dict:
    base, notes = floors_from_report(candidate, baseline_floors, policy)
    int8 = None
    if int8_present:
        int8, int8_notes = floors_from_report(candidate_int8, baseline_floors, policy)
        notes = notes + [f"int8 {n}" for n in int8_notes]
    return {
        "baseline": {c: baseline_floors[c] for c in FLOOR_CLASSES},
        "candidate": base,
        "candidateInt8": int8,
        "notes": notes,
    }
