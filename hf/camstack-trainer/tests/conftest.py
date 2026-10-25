"""Fixtures: a synthetic hub export in the real manifest format, and a job."""
from __future__ import annotations

import copy
import hashlib
import io
import json
import tarfile
from pathlib import Path
from typing import Callable

import pytest
from PIL import Image

DAY = 86_400_000
T0 = 1_760_000_000_000  # a capture instant (epoch ms)

JOB = {
    "schema": "camstack.training/v1",
    "jobKey": "0b6c1f7e-6a4e-4a8e-9f0b-3c2a1d4e5f60",
    "target": {"kind": "detector", "step": "object-detection"},
    "base": {"modelId": "yolov9m-640", "weights": "yolov9m.pt", "imgsz": 640},
    "baseline": {
        "modelId": "yolov9m-640",
        "onnxUrl": "https://huggingface.co/camstack/camstack-models/resolve/main/objectDetection/yolov9/onnx/camstack-yolov9m-640.onnx",
        "imgsz": 640,
        "floors": {"person": 0.6, "vehicle": 0.4, "animal": 0.55},
    },
    "dataset": {"versionId": "v1", "annotationHash": "abc", "sha256": "0" * 64},
    "split": {"holdoutCameras": [], "holdoutLastDays": 0, "valFraction": 0.15, "seed": 1},
    "hyper": {"epochs": 2, "batch": 4, "lr0": 0.002, "freeze": 10, "patience": 10, "seed": 1},
    "replay": {"source": "coco2017", "count": 0},
    "exports": ["onnx", "openvino-fp16", "openvino-int8", "coreml-fp16"],
    "calibration": {"maxFrames": 300},
    "floors": {"minSupport": 20, "clamp": 0.15},
    "int8Gate": {"maxMap50Drop": 0.02},
    "catalog": {"id": "custom-yolov9m-640-ab12cd34", "name": "Custom YOLOv9 M"},
}


@pytest.fixture
def job_dict() -> dict:
    return copy.deepcopy(JOB)


def _jpeg() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (90, 120, 150)).save(buf, "JPEG")
    return buf.getvalue()


def subject(macro: str, label: str | None = None, x: float = 0.1, kind: str = "subject") -> dict:
    a = {
        "id": f"a-{macro}-{x}-{kind}", "macroClass": macro, "kind": kind, "source": "operator",
        "bbox": {"x": x, "y": 0.2, "w": 0.3, "h": 0.4}, "derived": {},
    }
    if label is not None:
        a["label"] = label
    return a


def frame(fid: str, device: int, day: int, annotations: list[dict], complete: bool = True, night: bool = False) -> dict:
    return {
        "frameId": fid, "path": f"frames/{device}/t{fid}/{fid}.jpg", "deviceId": device,
        "origin": "track", "trackId": f"t{fid}", "collectionIds": [], "width": 64, "height": 48,
        "sizeBytes": 100, "sourceKind": "keyFrame", "copiedAt": T0, "capturedAt": T0 + day * DAY,
        "complete": complete, "lighting": {"condition": "night" if night else "day", "night": night, "source": "clock"},
        "annotations": annotations,
    }


def write_export(path: Path, frames: list[dict], schema: str = "camstack.retrain-export/v3") -> str:
    manifest = {
        "schema": schema, "layout": "frames", "generatedAt": T0, "batchId": "b1",
        "frameCount": len(frames), "annotationCount": 0, "modelErrorCount": 0,
        "classifierCropPadding": 0.15, "frames": frames,
    }
    data = _jpeg()
    with tarfile.open(path, "w") as tar:
        body = json.dumps(manifest).encode()
        info = tarfile.TarInfo("annotations.json")
        info.size = len(body)
        tar.addfile(info, io.BytesIO(body))
        for f in frames:
            info = tarfile.TarInfo(f["path"])
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture
def make_export(tmp_path: Path) -> Callable[..., tuple[Path, str]]:
    def build(frames: list[dict], schema: str = "camstack.retrain-export/v3") -> tuple[Path, str]:
        path = tmp_path / "dataset.tar"
        return path, write_export(path, frames, schema)

    return build
