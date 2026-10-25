"""The heavy export steps, each run in its own child process.

``python -m camstack_train._steps <step> '<json args>'``. A crash inside
coremltools, NNCF or a converter takes down that child only; the parent
records the step as failed (``export.SubprocessToolchain``). The recipes mirror
``scripts/build-camstack-models.py`` / ``convert_lib.py`` in camstack/server
(the yolov9 recipe: static ONNX at opset 13, ``nms=False``, batch 1; CoreML
``half=True`` — FP16, D743; OpenVINO from the ONNX via ``ov.convert_model``,
never the Ultralytics OV exporter), and are not imported from them.
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

#: Same bound as convert_lib / the inference pool (CAMSTACK_OV_COMPILATION_THREADS).
OV_COMPILATION_THREADS = 4
ONNX_OPSET = 13


def _move(src: Path, dest: Path) -> None:
    if dest.exists():
        shutil.rmtree(dest) if dest.is_dir() else dest.unlink()
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dest))


def step_onnx(pt: str, out: str, imgsz: int) -> None:
    from ultralytics import YOLO

    path = YOLO(pt).export(
        format="onnx", imgsz=imgsz, dynamic=False, simplify=True,
        opset=ONNX_OPSET, nms=False, batch=1, half=False,
    )
    _move(Path(path), Path(out))


def step_coreml(pt: str, out: str, imgsz: int) -> None:
    from ultralytics import YOLO

    path = YOLO(pt).export(format="coreml", imgsz=imgsz, dynamic=False, batch=1, half=True, nms=False)
    _move(Path(path), Path(out))


def _validate_ir(xml: str) -> None:
    import openvino as ov

    core = ov.Core()
    compiled = core.compile_model(core.read_model(xml), "CPU", {"COMPILATION_NUM_THREADS": OV_COMPILATION_THREADS})
    for port in list(compiled.inputs) + list(compiled.outputs):
        if not port.get_any_name():
            raise ValueError("the IR has an unnamed tensor")


def step_openvino(onnx: str, xml: str, fp16: bool) -> None:
    import openvino as ov

    Path(xml).parent.mkdir(parents=True, exist_ok=True)
    ov.save_model(ov.convert_model(onnx), xml, compress_to_fp16=fp16)
    _validate_ir(xml)


def step_openvino_int8(onnx: str, xml: str, calib: list[str], imgsz: int) -> None:
    import nncf
    import numpy as np
    import openvino as ov

    from ._vendor import ensure_pipeline_on_path

    ensure_pipeline_on_path()
    import inference_pool  # the pool's own decode + letterbox (grey 114, /255)

    def preprocess(path: str):
        arr, _scale, _pad = inference_pool.letterbox(inference_pool.decode_jpeg(Path(path).read_bytes()), imgsz)
        return arr.transpose(2, 0, 1)[np.newaxis].astype(np.float32)

    dataset = nncf.Dataset(calib, preprocess)
    quantized = nncf.quantize(ov.convert_model(onnx), dataset, subset_size=len(calib))
    Path(xml).parent.mkdir(parents=True, exist_ok=True)
    ov.save_model(quantized, xml)
    _validate_ir(xml)


STEPS = {
    "onnx": lambda a: step_onnx(a["pt"], a["out"], a["imgsz"]),
    "coreml": lambda a: step_coreml(a["pt"], a["out"], a["imgsz"]),
    "openvino": lambda a: step_openvino(a["onnx"], a["xml"], a["fp16"]),
    "openvino-int8": lambda a: step_openvino_int8(a["onnx"], a["xml"], a["calib"], a["imgsz"]),
}


def main(argv: list[str]) -> int:
    step, payload = argv[0], json.loads(argv[1])
    STEPS[step](payload)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
