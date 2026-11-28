"""``CAMSTACK_EVENT {json}`` progress lines on stdout.

The hub reads the provider's log and parses these lines; it never needs to
understand anything else the container prints. Every event carries ``v`` (the
event format version, 1), ``ts`` (epoch ms) and ``type``. One event per line,
compact JSON, flushed immediately.
"""
from __future__ import annotations

import json
import sys
import time
from typing import Any, Callable, Optional, TextIO

PREFIX = "CAMSTACK_EVENT "
EVENT_VERSION = 1

STAGES = ("prepare", "replay", "train", "export", "eval", "package")


class Emitter:
    def __init__(
        self,
        stream: Optional[TextIO] = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._stream = stream
        self._clock = clock

    def emit(self, event_type: str, **fields: Any) -> dict[str, Any]:
        event: dict[str, Any] = {
            "v": EVENT_VERSION,
            "ts": int(self._clock() * 1000),
            "type": event_type,
            **fields,
        }
        stream = self._stream if self._stream is not None else sys.stdout
        stream.write(PREFIX + json.dumps(event, separators=(",", ":"), sort_keys=False) + "\n")
        stream.flush()
        return event

    def stage(self, stage: str) -> None:
        if stage not in STAGES:
            raise ValueError(f"unknown stage {stage!r}")
        self.emit("stage", stage=stage)

    def epoch(
        self,
        epoch: int,
        epochs: int,
        box_loss: Optional[float],
        map50: Optional[float],
        map50_95: Optional[float],
        eta_sec: Optional[float],
    ) -> None:
        self.emit(
            "epoch",
            epoch=epoch,
            epochs=epochs,
            boxLoss=box_loss,
            map50=map50,
            map50_95=map50_95,
            etaSec=eta_sec,
        )

    def metric(self, name: str, value: float) -> None:
        self.emit("metric", name=name, value=value)

    def artifact(self, path: str, size: int, sha256: str) -> None:
        self.emit("artifact", path=path, bytes=size, sha256=sha256)

    def error(self, stage: str, code: str, message: str) -> None:
        self.emit("error", stage=stage, code=code, message=message)

    def done(self, status: str, result_sha256: Optional[str]) -> None:
        self.emit("done", status=status, resultSha256=result_sha256)


def parse_line(line: str) -> Optional[dict[str, Any]]:
    """The event on a log line, or ``None`` for any other line."""
    if not line.startswith(PREFIX):
        return None
    try:
        value = json.loads(line[len(PREFIX):])
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None
