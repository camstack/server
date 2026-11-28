"""Fine-tune the YOLOv9 root detector with Ultralytics.

This is the ONLY module that imports Ultralytics (AGPL-3.0), and only inside
:func:`ultralytics_train`, so the rest of the package — and its tests — never
load it. The hub never imports this package at all.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional, Protocol

from .events import Emitter
from .spec import JobSpec

#: Where Ultralytics' base weights are cached between jobs (the cache volume).
WEIGHTS_DIR = "weights"


@dataclass(frozen=True)
class TrainOutcome:
    best_pt: Path
    epochs_run: int
    best_epoch: int
    best_map50: float
    best_map50_95: float
    seconds: float


class Trainer(Protocol):
    def __call__(self, job: JobSpec, data_yaml: Path, work: Path, cache: Path, emitter: Emitter) -> TrainOutcome: ...


def write_data_yaml(root: Path, names: list[str], with_replay: bool, has_val: bool) -> Path:
    """The Ultralytics dataset file. Without a val split, val = train (stated)."""
    train = ["images/train"] + (["images/replay"] if with_replay else [])
    val = "images/val" if has_val else "images/train"
    lines = [f"path: {root.as_posix()}", "train:"]
    lines += [f"  - {t}" for t in train]
    lines.append(f"val: {val}")
    lines.append("names:")
    lines += [f"  {i}: {name!r}" for i, name in enumerate(names)]
    path = root / "data.yaml"
    path.write_text("\n".join(lines) + "\n", "utf-8")
    return path


@dataclass
class EpochTracker:
    """Turns Ultralytics' per-epoch callback into ``epoch`` events + the best epoch."""

    emitter: Emitter
    epochs: int
    started: float
    clock: Callable[[], float] = time.monotonic
    epochs_run: int = 0
    best_epoch: int = 0
    best_map50: float = 0.0
    best_map50_95: float = 0.0

    def on_epoch(self, epoch: int, box_loss: Optional[float], metrics: dict[str, Any]) -> None:
        map50 = _number(metrics.get("metrics/mAP50(B)"))
        map50_95 = _number(metrics.get("metrics/mAP50-95(B)"))
        self.epochs_run = epoch
        if map50_95 is not None and map50_95 >= self.best_map50_95:
            self.best_epoch, self.best_map50_95 = epoch, map50_95
            self.best_map50 = map50 or 0.0
        elapsed = self.clock() - self.started
        eta = elapsed / epoch * (self.epochs - epoch) if epoch > 0 else None
        self.emitter.epoch(epoch, self.epochs, box_loss, map50, map50_95, None if eta is None else round(eta, 1))


def _number(value: Any) -> Optional[float]:
    try:
        return None if value is None else round(float(value), 5)
    except (TypeError, ValueError):
        return None


def base_weights(job: JobSpec, cache: Path) -> Path:
    """The base checkpoint, downloaded once into the cache volume."""
    from ultralytics.utils.downloads import attempt_download_asset

    target = cache / WEIGHTS_DIR / job.base.weights
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.is_file():
        attempt_download_asset(str(target))
    return target


def ultralytics_train(job: JobSpec, data_yaml: Path, work: Path, cache: Path, emitter: Emitter) -> TrainOutcome:
    import torch
    from ultralytics import YOLO

    model = YOLO(str(base_weights(job, cache)))
    tracker = EpochTracker(emitter, job.hyper.epochs, time.monotonic())

    def on_fit_epoch_end(trainer: Any) -> None:
        loss = getattr(trainer, "tloss", None)
        box_loss = _number(loss[0]) if loss is not None and len(loss) > 0 else None
        tracker.on_epoch(int(trainer.epoch) + 1, box_loss, dict(getattr(trainer, "metrics", {}) or {}))

    model.add_callback("on_fit_epoch_end", on_fit_epoch_end)
    started = time.monotonic()
    model.train(
        data=str(data_yaml),
        epochs=job.hyper.epochs,
        batch=job.hyper.batch,
        lr0=job.hyper.lr0,
        freeze=job.hyper.freeze or None,
        patience=job.hyper.patience,
        seed=job.hyper.seed,
        deterministic=True,
        imgsz=job.base.imgsz,
        device=0 if torch.cuda.is_available() else "cpu",
        project=str(work / "runs"),
        name="train",
        exist_ok=True,
        plots=False,
        verbose=False,
    )
    best = work / "runs" / "train" / "weights" / "best.pt"
    return TrainOutcome(
        best_pt=best,
        epochs_run=tracker.epochs_run,
        best_epoch=tracker.best_epoch,
        best_map50=tracker.best_map50,
        best_map50_95=tracker.best_map50_95,
        seconds=round(time.monotonic() - started, 1),
    )
