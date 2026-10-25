"""An OpenVINO IR goes through the pool's PrePostProcessor and decodes to the
same boxes as the ONNX it was converted from."""
import io

import numpy as np
import pytest
from onnx import TensorProto, helper
from PIL import Image

ov = pytest.importorskip("openvino")

from camstack_eval.pipeline import OnnxDetector, OpenVinoDetector, make_detector  # noqa: E402

SIZE = 64


def input_dependent_yolo(path, columns):
    """output0 = constant + 0 * mean(images): the graph reads its input."""
    import onnx

    values = np.zeros((1, 84, len(columns)), dtype=np.float32)
    for j, (cx, cy, w, h, cls, score) in enumerate(columns):
        values[0, 0:4, j] = (cx, cy, w, h)
        values[0, 4 + cls, j] = score
    nodes = [
        helper.make_node("Constant", [], ["c"], value=helper.make_tensor(
            "cv", TensorProto.FLOAT, values.shape, values.flatten().tolist())),
        helper.make_node("Constant", [], ["zero"], value=helper.make_tensor("z", TensorProto.FLOAT, [], [0.0])),
        helper.make_node("ReduceMean", ["images"], ["m"], keepdims=0),
        helper.make_node("Mul", ["m", "zero"], ["m0"]),
        helper.make_node("Add", ["c", "m0"], ["output0"]),
    ]
    graph = helper.make_graph(
        nodes, "tiny",
        [helper.make_tensor_value_info("images", TensorProto.FLOAT, [1, 3, SIZE, SIZE])],
        [helper.make_tensor_value_info("output0", TensorProto.FLOAT, values.shape)],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 8
    onnx.save(model, path)


def jpeg(w, h):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (10, 120, 200)).save(buf, "JPEG")
    return buf.getvalue()


def test_an_ir_decodes_like_its_onnx(tmp_path):
    onnx_path = tmp_path / "m.onnx"
    input_dependent_yolo(str(onnx_path), [(16, 32, 32, 32, 0, 0.9), (40, 32, 8, 8, 2, 0.6)])
    xml = tmp_path / "m.xml"
    ov.save_model(ov.convert_model(str(onnx_path)), str(xml), compress_to_fp16=False)

    det = make_detector(str(xml), SIZE)
    assert isinstance(det, OpenVinoDetector) and det.folded

    frame = jpeg(200, 100)
    want = OnnxDetector(str(onnx_path), SIZE).detect(frame)
    got = det.detect(frame)
    assert [(d.cls, round(d.score, 4)) for d in got] == [(d.cls, round(d.score, 4)) for d in want]
    np.testing.assert_allclose([d.bbox for d in got], [d.bbox for d in want], atol=1e-5)
