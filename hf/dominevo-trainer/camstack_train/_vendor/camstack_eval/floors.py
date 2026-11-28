"""The D739 floor rule (docs/decisions/adr-0739-*.md).

A model's floor for a class is the LOWEST confidence at which it raises no more
false positives on the evaluation set than the baseline does at the baseline's
shipped floor — so switching model keeps the false-alert rate and changes only
what is found. On a small or fine-tuned set two guards apply:

- **support**: a class with fewer than ``min_support`` ground-truth positives
  inherits the baseline floor (a floor fitted on a handful of boxes is noise);
- **clamp**: the floor stays within ``±clamp`` of the baseline floor (single
  digit false-positive counts carry ±0.05–0.10 of noise).

Floors are on a ``grid_step`` grid and never below ``minimum``, as in the
2026-10-07 calibration.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional, Sequence

FloorReason = Literal["fp-budget", "low-support", "clamped"]


@dataclass(frozen=True)
class ScoredDetection:
    score: float
    true_positive: bool


@dataclass(frozen=True)
class FloorPolicy:
    min_support: int = 20
    clamp: float = 0.15
    grid_step: float = 0.05
    minimum: float = 0.25
    maximum: float = 0.95


@dataclass(frozen=True)
class ProposedFloor:
    value: float
    reason: FloorReason
    fp_budget: int
    #: The unclamped fit, ``None`` when no grid floor meets the budget.
    fitted: Optional[float]


def false_positives_at(detections: Sequence[ScoredDetection], floor: float) -> int:
    return sum(1 for d in detections if not d.true_positive and d.score >= floor - 1e-9)


def _grid(policy: FloorPolicy) -> list[float]:
    steps = int(round((policy.maximum - policy.minimum) / policy.grid_step))
    return [round(policy.minimum + i * policy.grid_step, 4) for i in range(steps + 1)]


def propose_floor(
    baseline: Sequence[ScoredDetection],
    baseline_floor: float,
    candidate: Sequence[ScoredDetection],
    positives: int,
    policy: FloorPolicy = FloorPolicy(),
) -> ProposedFloor:
    budget = false_positives_at(baseline, baseline_floor)
    if positives < policy.min_support:
        return ProposedFloor(baseline_floor, "low-support", budget, None)
    fitted = next(
        (t for t in _grid(policy) if false_positives_at(candidate, t) <= budget),
        None,
    )
    low = round(max(policy.minimum, baseline_floor - policy.clamp), 4)
    high = round(baseline_floor + policy.clamp, 4)
    if fitted is None:
        return ProposedFloor(high, "clamped", budget, None)
    if fitted < low:
        return ProposedFloor(low, "clamped", budget, fitted)
    if fitted > high:
        return ProposedFloor(high, "clamped", budget, fitted)
    return ProposedFloor(fitted, "fp-budget", budget, fitted)
