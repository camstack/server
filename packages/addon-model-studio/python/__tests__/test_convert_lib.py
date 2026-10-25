import os
import tempfile
import pytest

ov = pytest.importorskip("openvino")  # skip where openvino is absent
import numpy as np

from convert_lib import export_openvino, validate_openvino_ir


def _tiny_onnx(path: str) -> None:
    # Build a 1-op ONNX (Relu) with NAMED input/output via onnx helpers.
    import onnx
    from onnx import helper, TensorProto
    x = helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 3, 8, 8])
    y = helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 3, 8, 8])
    node = helper.make_node("Relu", ["input"], ["output"])
    graph = helper.make_graph([node], "tiny", [x], [y])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
    onnx.save(model, path)


def test_export_and_validate_named_tensors():
    with tempfile.TemporaryDirectory() as d:
        onnx_path = os.path.join(d, "tiny.onnx")
        xml_path = os.path.join(d, "tiny.xml")
        _tiny_onnx(onnx_path)
        export_openvino(onnx_path, xml_path, fp16=True)
        assert os.path.exists(xml_path)
        assert os.path.exists(xml_path.replace(".xml", ".bin"))
        validate_openvino_ir(xml_path)  # must not raise — tensors are named
