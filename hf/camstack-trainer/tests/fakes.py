"""Fakes for the heavy toolchain: no torch, Ultralytics or OpenVINO needed."""
from __future__ import annotations

from pathlib import Path

from camstack_train._vendor.camstack_eval.metrics import Detection
from camstack_train.manifest import MLPACKAGE_FILES
from camstack_train.train_det import TrainOutcome


def fake_trainer(job, data_yaml, work, cache, emitter):
    best = work / "runs" / "train" / "weights" / "best.pt"
    best.parent.mkdir(parents=True, exist_ok=True)
    best.write_bytes(b"weights")
    assert data_yaml.is_file()
    emitter.epoch(1, job.hyper.epochs, 1.0, 0.4, 0.2, 10.0)
    return TrainOutcome(best, 1, 1, 0.4, 0.2, 3.0)


class FakeToolchain:
    def __init__(self, fail: tuple[str, ...] = ()) -> None:
        self.fail = fail
        self.calls: list[str] = []
        self.calib: list[Path] = []

    def _maybe_fail(self, step: str) -> None:
        self.calls.append(step)
        if step in self.fail:
            raise RuntimeError(f"{step} exploded")

    def onnx(self, pt, out, imgsz):
        self._maybe_fail("onnx")
        out.write_bytes(b"onnx")

    def openvino(self, onnx, xml, fp16):
        self._maybe_fail("openvino")
        xml.write_bytes(b"<xml/>")
        xml.with_suffix(".bin").write_bytes(b"fp16")

    def openvino_int8(self, onnx, xml, calib, imgsz):
        self._maybe_fail("openvino-int8")
        self.calib = list(calib)
        xml.write_bytes(b"<xml8/>")
        xml.with_suffix(".bin").write_bytes(b"int8")

    def coreml(self, pt, out, imgsz):
        self._maybe_fail("coreml")
        for m in MLPACKAGE_FILES:
            p = out / m
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b"cm")


def detector_factory(int8_score: float = 0.9):
    """Every model finds the one person each fixture frame holds; the INT8 IR at ``int8_score``."""

    def make(path: str, size: int):
        score = int8_score if path.endswith("-int8.xml") else 0.9

        def detect(_jpeg: bytes):
            return [Detection("person", score, (0.1, 0.2, 0.3, 0.4))] if score > 0 else []

        return detect

    return make


def fake_fetch(url: str) -> bytes:
    if url.endswith(".onnx"):
        return b"baseline-onnx"
    raise AssertionError(f"unexpected fetch {url}")
