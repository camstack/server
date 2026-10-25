"""Run a YOLO detector (ONNX or OpenVINO IR) exactly as the inference pool does.

Nothing here re-implements the pipeline: the letterbox (grey 114 padding,
bilinear resize, /255) and the YOLO decode (sigmoid detection, confidence
floor, NMS) are IMPORTED from `packages/addon-pipeline/python`, so a change to
production preprocessing changes the evaluation with it. The pool floor (0.05)
and the NMS IoU (0.45) are the pool's.

An OpenVINO IR is compiled as the pool compiles it: a static 3-channel input
gets the pool's own PrePostProcessor (uint8 NHWC in, the /255 folded into the
graph — `inference_pool._build_ov_ppp_model`), a dynamic one is fed the float
letterbox. The device is the CPU at FP32 (`INFERENCE_PRECISION_HINT=f32`), the
x86 CPU default; an ARM CPU defaults to FP16, which is not what any node runs.

One difference stays and is stated: the live path first downscales a frame to
the model's content size on the Node side (sharp); here the PIL letterbox does
that resize itself. The comparison run of 2026-10-07 measured the same way.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional, Sequence

import numpy as np

from .metrics import Detection

REPO_ROOT = Path(__file__).resolve().parents[3]
PIPELINE_PYTHON = REPO_ROOT / "packages" / "addon-pipeline" / "python"

#: The inference pool's confidence floor and NMS IoU.
POOL_FLOOR = 0.05
POOL_NMS_IOU = 0.45


def _pipeline():
    if str(PIPELINE_PYTHON) not in sys.path:
        sys.path.insert(0, str(PIPELINE_PYTHON))
    import inference_pool  # noqa: E402  (path set above)
    from postprocessors import POSTPROCESSORS  # noqa: E402

    return inference_pool, POSTPROCESSORS


class OnnxDetector:
    """A detector on ONNX Runtime (CPU unless ``providers`` says otherwise)."""

    def __init__(
        self,
        model_path: str,
        input_size: int,
        labels: Optional[Sequence[str]] = None,
        postprocessor: str = "yolo",
        pool_floor: float = POOL_FLOOR,
        nms_iou: float = POOL_NMS_IOU,
        providers: Optional[Sequence[str]] = None,
    ) -> None:
        import onnxruntime as ort

        self._pool, postprocessors = _pipeline()
        if postprocessor not in postprocessors:
            raise ValueError(f"unknown postprocessor {postprocessor!r}")
        self._postprocess = postprocessors[postprocessor]
        from postprocessors.yolo import COCO_80

        self.input_size = input_size
        self._config = {
            "inputSize": input_size,
            "labels": list(labels) if labels is not None else list(COCO_80),
            "confidence": pool_floor,
            "nmsIouThreshold": nms_iou,
            "postprocessor": postprocessor,
        }
        self._session = ort.InferenceSession(
            model_path, providers=list(providers) if providers else ["CPUExecutionProvider"]
        )
        self._input_name = self._session.get_inputs()[0].name
        self._output_names = [o.name for o in self._session.get_outputs()]

    def detect(self, jpeg: bytes) -> list[Detection]:
        img = self._pool.decode_jpeg(jpeg)
        orig_w, orig_h = img.size
        arr, scale, pad = self._pool.letterbox(img, self.input_size)
        tensor = arr.transpose(2, 0, 1)[np.newaxis].astype(np.float32)
        outputs = self._session.run(self._output_names, {self._input_name: tensor})
        predictions = dict(zip(self._output_names, outputs))
        result = self._postprocess(predictions, self._config, orig_w, orig_h, scale, pad)
        return _to_detections(result, orig_w, orig_h)


def _to_detections(result: dict, orig_w: int, orig_h: int) -> list[Detection]:
    out: list[Detection] = []
    for d in result.get("detections", []):
        x1, y1, x2, y2 = d["bbox"]
        out.append(
            Detection(
                str(d["class"]),
                float(d["score"]),
                (x1 / orig_w, y1 / orig_h, (x2 - x1) / orig_w, (y2 - y1) / orig_h),
            )
        )
    return out


class OpenVinoDetector:
    """A detector on an OpenVINO IR, on the CPU at FP32 (see the module doc)."""

    def __init__(
        self,
        model_path: str,
        input_size: int,
        labels: Optional[Sequence[str]] = None,
        postprocessor: str = "yolo",
        pool_floor: float = POOL_FLOOR,
        nms_iou: float = POOL_NMS_IOU,
        device: str = "CPU",
        precision: str = "f32",
    ) -> None:
        import openvino as ov

        self._pool, postprocessors = _pipeline()
        if postprocessor not in postprocessors:
            raise ValueError(f"unknown postprocessor {postprocessor!r}")
        self._postprocess = postprocessors[postprocessor]
        from postprocessors.yolo import COCO_80

        self.input_size = input_size
        self._config = {
            "inputSize": input_size,
            "labels": list(labels) if labels is not None else list(COCO_80),
            "confidence": pool_floor,
            "nmsIouThreshold": nms_iou,
            "postprocessor": postprocessor,
            "preprocessMode": "letterbox",
        }
        core = ov.Core()
        model, self._ppp = self._pool._build_ov_ppp_model(core, model_path, self._config)
        properties = {"INFERENCE_PRECISION_HINT": precision, "PERFORMANCE_HINT": "LATENCY"}
        self._compiled = core.compile_model(model if model is not None else model_path, device, properties)
        self._request = self._compiled.create_infer_request()
        self._output_names = [o.get_any_name() for o in self._compiled.outputs]

    @property
    def folded(self) -> bool:
        """True when the pool's PrePostProcessor was attached (static input)."""
        return self._ppp is not None

    def detect(self, jpeg: bytes) -> list[Detection]:
        img = self._pool.decode_jpeg(jpeg)
        orig_w, orig_h = img.size
        if self._ppp is not None:
            tensor, scale, pad = self._pool._preprocess_ov_uint8(img, self._ppp)
        else:
            arr, scale, pad = self._pool.letterbox(img, self.input_size)
            tensor = arr.transpose(2, 0, 1)[np.newaxis].astype(np.float32)
        self._request.infer({0: tensor})
        predictions = {
            name: self._request.get_output_tensor(i).data.copy()
            for i, name in enumerate(self._output_names)
        }
        result = self._postprocess(predictions, self._config, orig_w, orig_h, scale, pad)
        return _to_detections(result, orig_w, orig_h)


def make_detector(model_path: str, input_size: int):
    """An ``OpenVinoDetector`` for an ``.xml`` IR, an ``OnnxDetector`` otherwise."""
    if model_path.endswith(".xml"):
        return OpenVinoDetector(model_path, input_size)
    return OnnxDetector(model_path, input_size)
