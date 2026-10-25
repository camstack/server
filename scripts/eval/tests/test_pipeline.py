"""The ONNX runner goes through the PIPELINE's own letterbox and YOLO decode
(packages/addon-pipeline/python), so its boxes are the boxes production sees."""
import io

import numpy as np
import onnx
from onnx import TensorProto, helper
from PIL import Image

from camstack_eval.pipeline import OnnxDetector

SIZE = 64


def tiny_yolo(path, columns):
    """A constant-output 'detector': input [1,3,64,64], output [1,84,N]."""
    values = np.zeros((1, 84, len(columns)), dtype=np.float32)
    for j, (cx, cy, w, h, cls, score) in enumerate(columns):
        values[0, 0:4, j] = (cx, cy, w, h)
        values[0, 4 + cls, j] = score
    const = helper.make_node(
        "Constant", [], ["output0"],
        value=helper.make_tensor("c", TensorProto.FLOAT, values.shape, values.flatten().tolist()),
    )
    graph = helper.make_graph(
        [const], "tiny",
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


def test_maps_letterbox_coordinates_back_to_the_normalised_frame(tmp_path):
    # A 200x100 frame letterboxed to 64: scale 0.32, content 64x32, pad_y 16.
    # A box covering the left half of the frame is (0,16)-(32,48) in the input.
    model = tmp_path / "m.onnx"
    tiny_yolo(str(model), [(16, 32, 32, 32, 0, 0.9), (40, 32, 8, 8, 2, 0.6)])
    det = OnnxDetector(str(model), input_size=SIZE)

    found = det.detect(jpeg(200, 100))

    by_class = {d.cls: d for d in found}
    person = by_class["person"]
    assert person.score == 0.9
    np.testing.assert_allclose(person.bbox, (0.0, 0.0, 0.5, 1.0), atol=0.01)
    assert by_class["car"].score == 0.6


def test_drops_detections_under_the_pool_floor(tmp_path):
    model = tmp_path / "m.onnx"
    tiny_yolo(str(model), [(16, 32, 32, 32, 0, 0.04)])
    assert OnnxDetector(str(model), input_size=SIZE).detect(jpeg(200, 100)) == []
