"""The train / val / holdout assignment, deterministic from ``job.split``.

Never random per frame: two frames a second apart on one camera are near
copies, and splitting them between train and holdout measures memory, not the
model. So:

- **holdout**: whole cameras (``holdoutCameras``) when the hub named any;
  otherwise the last ``holdoutLastDays`` capture days of EVERY camera (a frame
  with no capture time is never held out); otherwise nothing.
- **val**: whole (camera, day) groups of the remaining trainable frames, in a
  seeded hash order, until ``valFraction`` of them is reached — never the last
  train group.
- **train**: everything else that is trainable (``dataset.Frame.trainable``).

A holdout frame never trains, whether or not it is complete; only complete
holdout frames are evaluated. A shortage of holdout positives does NOT refuse
the job — the floor rule then inherits the baseline's floor. An empty train
split does (exit 65).
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Optional, Sequence

from .dataset import Frame
from .errors import dataset_error
from .spec import Split

DAY_MS = 86_400_000


@dataclass(frozen=True)
class SplitResult:
    train: tuple[Frame, ...]
    val: tuple[Frame, ...]
    holdout: tuple[Frame, ...]
    holdout_cameras: tuple[int, ...]

    @property
    def holdout_eval(self) -> tuple[Frame, ...]:
        return tuple(f for f in self.holdout if f.complete)


def day_of(frame: Frame) -> Optional[int]:
    return None if frame.captured_at is None else frame.captured_at // DAY_MS


def _holdout_by_days(frames: Sequence[Frame], days: int) -> set[str]:
    last_day: dict[int, int] = {}
    for f in frames:
        d = day_of(f)
        if d is not None:
            last_day[f.device_id] = max(last_day.get(f.device_id, d), d)
    held = set()
    for f in frames:
        d = day_of(f)
        if d is not None and d > last_day[f.device_id] - days:
            held.add(f.frame_id)
    return held


def _group_order(seed: int, device_id: int, day: Optional[int]) -> str:
    return hashlib.sha256(f"{seed}:{device_id}:{day}".encode()).hexdigest()


def _val_groups(frames: Sequence[Frame], fraction: float, seed: int) -> set[tuple[int, Optional[int]]]:
    groups: dict[tuple[int, Optional[int]], int] = {}
    for f in frames:
        key = (f.device_id, day_of(f))
        groups[key] = groups.get(key, 0) + 1
    target = round(fraction * len(frames))
    chosen: set[tuple[int, Optional[int]]] = set()
    taken = 0
    ordered = sorted(groups, key=lambda k: _group_order(seed, k[0], k[1]))
    for key in ordered:
        if taken >= target or len(chosen) >= len(groups) - 1:
            break
        chosen.add(key)
        taken += groups[key]
    return chosen


def assign(frames: Sequence[Frame], policy: Split) -> SplitResult:
    if policy.holdout_cameras:
        wanted = set(policy.holdout_cameras)
        held = {f.frame_id for f in frames if f.device_id in wanted}
        cameras = tuple(sorted(wanted))
    elif policy.holdout_last_days > 0:
        held = _holdout_by_days(frames, policy.holdout_last_days)
        cameras = ()
    else:
        held, cameras = set(), ()
    holdout = tuple(f for f in frames if f.frame_id in held)
    rest = [f for f in frames if f.frame_id not in held and f.trainable]
    val_keys = _val_groups(rest, policy.val_fraction, policy.seed)
    val = tuple(f for f in rest if (f.device_id, day_of(f)) in val_keys)
    train = tuple(f for f in rest if (f.device_id, day_of(f)) not in val_keys)
    if not train:
        raise dataset_error("no-train-frames", "no trainable frame is left outside the holdout")
    return SplitResult(train=train, val=val, holdout=holdout, holdout_cameras=cameras)
