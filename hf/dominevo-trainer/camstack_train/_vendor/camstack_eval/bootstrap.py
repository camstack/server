"""Paired bootstrap of an AP difference between two models on one set.

Both models are scored on the SAME resampled frames (frames drawn with
replacement, ``rounds`` times), so what varies is the set, not the pairing:
the 95 % interval of ``AP(candidate) - AP(baseline)`` is the noise band a
"no regression" verdict is read against. Matching is per frame, so it is done
once (`metrics.frame_matches`) and a resample only re-weights each frame's
detections by how often the frame was drawn — the same AP as concatenating the
drawn frames (`metrics.ap_of_sample`), computed for every round at once.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional, Sequence

import numpy as np

from .metrics import COCO_IOUS, FrameMatches


@dataclass(frozen=True)
class _Flat:
    """One model's matches of one class at one IoU, score-sorted."""

    frame: np.ndarray  # frame index per detection, highest score first
    tp: np.ndarray  # bool per detection
    positives: np.ndarray  # ground-truth count per frame


def _flatten(matches: Sequence[FrameMatches]) -> _Flat:
    scores, tps, frames = [], [], []
    for i, m in enumerate(matches):
        scores.extend(m.scores)
        tps.extend(m.true_positive)
        frames.extend([i] * len(m.scores))
    order = np.argsort(-np.asarray(scores, dtype=np.float64), kind="stable")
    return _Flat(
        frame=np.asarray(frames, dtype=np.int64)[order],
        tp=np.asarray(tps, dtype=bool)[order],
        positives=np.asarray([m.positives for m in matches], dtype=np.float64),
    )


def weighted_ap(flat: _Flat, weights: np.ndarray) -> np.ndarray:
    """AP per round; ``weights`` is ``[rounds, frames]`` (draw counts)."""
    total = weights @ flat.positives
    if flat.frame.size == 0:
        return np.where(total > 0, 0.0, np.nan)
    w = weights[:, flat.frame]
    ctp = np.cumsum(w * flat.tp, axis=1)
    cfp = np.cumsum(w * ~flat.tp, axis=1)
    denom = ctp + cfp
    precision = np.divide(ctp, denom, out=np.zeros_like(ctp), where=denom > 0)
    envelope = np.maximum.accumulate(precision[:, ::-1], axis=1)[:, ::-1]
    gained = (w * flat.tp * envelope).sum(axis=1)
    return np.divide(gained, total, out=np.full_like(total, np.nan), where=total > 0)


@dataclass(frozen=True)
class Delta:
    """``candidate - baseline`` on the full set and its 95 % bootstrap interval."""

    value: float
    low: float
    high: float

    @property
    def significant_drop(self) -> bool:
        return self.high < 0

    @property
    def significant_gain(self) -> bool:
        return self.low > 0

    def as_dict(self) -> dict:
        return {"delta": round(self.value, 4), "ci95": [round(self.low, 4), round(self.high, 4)]}


def draw_weights(frames: int, rounds: int, seed: int = 0) -> np.ndarray:
    """``[rounds + 1, frames]`` draw counts; row 0 is the full set (all ones)."""
    rng = np.random.default_rng(seed)
    draws = rng.integers(0, frames, size=(rounds, frames))
    counts = np.zeros((rounds, frames), dtype=np.float64)
    np.add.at(counts, (np.arange(rounds)[:, None], draws), 1.0)
    return np.vstack([np.ones((1, frames)), counts])


def ap_rounds(matches_by_iou: dict[float, Sequence[FrameMatches]], weights: np.ndarray,
              ious: Sequence[float]) -> np.ndarray:
    """Mean AP over ``ious`` per round."""
    return np.nanmean(
        np.stack([weighted_ap(_flatten(matches_by_iou[t]), weights) for t in ious]), axis=0
    )


def paired_delta(baseline: np.ndarray, candidate: np.ndarray) -> Optional[Delta]:
    """From per-round values (row 0 = full set) of two models."""
    diff = candidate - baseline
    if np.isnan(diff[0]):
        return None
    rounds = diff[1:][~np.isnan(diff[1:])]
    low, high = (np.percentile(rounds, [2.5, 97.5]) if rounds.size else (np.nan, np.nan))
    return Delta(float(diff[0]), float(low), float(high))


AP50 = (0.5,)
AP50_95 = COCO_IOUS
