from __future__ import annotations

from camstack_train._vendor.camstack_eval.floors import FloorPolicy, ScoredDetection
from camstack_train.floors import floors_block, floors_from_report, propose

POLICY = FloorPolicy(min_support=20, clamp=0.15)
BASE = {"person": 0.6, "vehicle": 0.4, "animal": 0.55}


def fps(*scores: float) -> list[ScoredDetection]:
    return [ScoredDetection(s, False) for s in scores]


def test_lowest_floor_within_the_baseline_fp_budget():
    # baseline: 1 FP at or above its floor 0.6; the candidate makes FPs at 0.52 and 0.66
    baseline = fps(0.62, 0.3)
    candidate = fps(0.52, 0.66)
    p = propose(baseline, 0.6, candidate, positives=30, policy=POLICY)
    assert p.reason == "fp-budget" and p.value == 0.55 and p.fp_budget == 1


def test_low_support_inherits_the_baseline():
    p = propose(fps(0.9), 0.6, fps(0.2), positives=8, policy=POLICY)
    assert (p.value, p.reason) == (0.6, "low-support")


def test_clamped_to_plus_minus_clamp():
    # a candidate with no false positives would fit the grid minimum 0.25; clamp to 0.45
    p = propose(fps(), 0.6, fps(), positives=50, policy=POLICY)
    assert (p.value, p.reason, p.fitted) == (0.45, "clamped", 0.25)
    # no grid floor meets the budget → the top of the clamp band
    q = propose(fps(), 0.6, fps(0.99), positives=50, policy=POLICY)
    assert (q.value, q.reason) == (0.75, "clamped")


def report(person: dict) -> dict:
    fit = {"value": 0.4, "reason": "fp-budget", "fpBudget": 2, "fitted": 0.4}
    return {"frames": 10, "classes": {
        "person": {"positives": person.get("positives", 30), "proposedFloor": person},
        "vehicle": {"positives": 40, "proposedFloor": fit},
        "animal": {"positives": 5, "proposedFloor": {"value": 0.55, "reason": "low-support", "fpBudget": 0, "fitted": None}},
    }}


def test_report_to_floors_with_notes():
    floors, notes = floors_from_report(report({"value": 0.5, "reason": "fp-budget", "fpBudget": 1, "fitted": 0.5}), BASE, POLICY)
    assert floors == {"person": 0.5, "vehicle": 0.4, "animal": 0.55}
    assert notes == ["animal: 5 holdout positives < 20, inherits 0.55"]


def test_no_holdout_inherits_everything():
    floors, notes = floors_from_report(None, BASE, POLICY)
    assert floors == BASE and "inherits the baseline" in notes[0]


def test_floors_block_int8_only_when_kept():
    r = report({"value": 0.5, "reason": "fp-budget", "fpBudget": 1, "fitted": 0.5})
    block = floors_block(r, r, BASE, POLICY, int8_present=False)
    assert block["candidateInt8"] is None and block["baseline"] == BASE
    block = floors_block(r, r, BASE, POLICY, int8_present=True)
    assert block["candidateInt8"]["person"] == 0.5
    assert any(n.startswith("int8 animal") for n in block["notes"])
