"""Batch capability is a HARDWARE FACT, decided at load — never a setting.

Two layers are covered:

  1. The PURE derivation — `_ov_static_batch_required` (engine+device -> may the
     graph keep a dynamic batch axis?) and `_static_batch_plan` (which inputs
     have a pinnable dynamic BATCH axis, and which carry a dynamic axis that is
     NOT the batch and therefore cannot be pinned). No OpenVINO import: these
     run in a bare sandbox.

  2. The REAL reshape — when OpenVINO is installed the last class builds a tiny
     ONNX graph with a dynamic first dimension, reads it as an OV model and runs
     `_pin_batch_for_device` against an NPU-shaped target and a CPU one. NPU
     must come back STATIC 1 (this is the compile that hung the hub live on
     2026-08-20: "Got negative shape dim bound: '-1'", then a load that never
     completed), CPU must come back UNTOUCHED and still dynamic.

Run: /tmp/conv-venv/bin/python -m pytest test_inference_pool_static_batch.py -v
     (or `python3 -m unittest test_inference_pool_static_batch -v` — the pure
     classes run without OpenVINO; the OV class self-skips.)
"""
from __future__ import annotations

import sys
import types
import unittest
from typing import Any

# ---------------------------------------------------------------------------
# Stub the heavy third-party imports ONLY when they are genuinely absent, and
# BEFORE importing inference_pool. A blind stub would shadow the REAL numpy the
# OpenVINO class below needs, so every stub is an ImportError fallback.
# ---------------------------------------------------------------------------

try:  # pragma: no cover - environment-dependent
    import numpy  # noqa: F401
except ImportError:  # pragma: no cover
    _np = types.ModuleType("numpy")
    _np.array = lambda seq, dtype=None: list(seq)  # noqa: E731
    _np.float32 = "float32"
    sys.modules["numpy"] = _np

try:  # pragma: no cover - environment-dependent
    import PIL.Image  # noqa: F401
except ImportError:  # pragma: no cover
    _pil = types.ModuleType("PIL")
    _pil_image = types.ModuleType("PIL.Image")
    _pil.Image = _pil_image
    sys.modules["PIL"] = _pil
    sys.modules["PIL.Image"] = _pil_image

try:  # pragma: no cover - environment-dependent
    import postprocessors  # noqa: F401
except ImportError:  # pragma: no cover
    _pp = types.ModuleType("postprocessors")
    _pp.POSTPROCESSORS = {}
    sys.modules["postprocessors"] = _pp

from inference_pool import (  # noqa: E402
    STATIC_BATCH_PIN,
    _pin_batch_for_device,
    _static_batch_plan,
    _static_batch_required,
)


class StaticBatchRequiredTest(unittest.TestCase):
    """The rule itself: which (engine, device) pairs refuse a dynamic shape.

    ONE authority for every engine. Only the Intel NPU refuses, and it is not a
    preference — the Level-Zero compiler rejects the graph outright, and because
    a pool load failure is a retry loop rather than an error the caller sees,
    getting this wrong looks like a busy pool, not a broken one.
    """

    def test_openvino_npu_requires_static_batch(self) -> None:
        self.assertTrue(_static_batch_required("openvino", "NPU"))

    def test_npu_with_index_suffix_requires_static_batch(self) -> None:
        # OpenVINO enumerates multiple units as NPU.0 / NPU.1.
        self.assertTrue(_static_batch_required("openvino", "NPU.0"))

    def test_lowercase_and_padded_pin_is_still_the_npu(self) -> None:
        self.assertTrue(_static_batch_required("openvino", " npu "))

    def test_openvino_cpu_keeps_dynamic(self) -> None:
        self.assertFalse(_static_batch_required("openvino", "CPU"))

    def test_openvino_gpu_keeps_dynamic(self) -> None:
        self.assertFalse(_static_batch_required("openvino", "GPU"))

    def test_openvino_gpu_with_index_suffix_keeps_dynamic(self) -> None:
        self.assertFalse(_static_batch_required("openvino", "GPU.1"))

    def test_empty_device_keeps_dynamic(self) -> None:
        # A missing device name must never silently pin a graph.
        self.assertFalse(_static_batch_required("openvino", ""))

    def test_onnxruntime_keeps_dynamic(self) -> None:
        self.assertFalse(_static_batch_required("onnxruntime", "cuda"))
        self.assertFalse(_static_batch_required("onnxruntime", "cpu"))

    def test_coreml_keeps_dynamic(self) -> None:
        # A RangeDim export is what the batched ANE dispatch path reads; the
        # loader must never pin it away.
        self.assertFalse(_static_batch_required("coreml", "ane"))
        self.assertFalse(_static_batch_required("coreml", "all"))

    def test_edgetpu_keeps_dynamic(self) -> None:
        # A tflite/edgetpu graph is static by construction — nothing to pin.
        self.assertFalse(_static_batch_required("edgetpu", "usb:0"))

    def test_an_npu_named_device_on_another_engine_is_not_the_intel_npu(self) -> None:
        # The rule is a PAIR. `coreml`'s Neural Engine is not Level Zero.
        self.assertFalse(_static_batch_required("coreml", "npu"))


class StaticBatchPlanTest(unittest.TestCase):
    """Which inputs get pinned, and which are honestly reported as unpinnable."""

    def test_dynamic_batch_is_pinned_to_one(self) -> None:
        plan, unpinnable = _static_batch_plan([[None, 64, 128, 3]])
        self.assertEqual(plan, {0: [STATIC_BATCH_PIN, 64, 128, 3]})
        self.assertEqual(unpinnable, [])

    def test_already_static_graph_needs_no_reshape(self) -> None:
        plan, unpinnable = _static_batch_plan([[1, 3, 640, 640]])
        self.assertEqual(plan, {})
        self.assertEqual(unpinnable, [])

    def test_static_batch_greater_than_one_is_left_alone(self) -> None:
        # An export that deliberately declares batch 4 is a static shape; the
        # rule pins DYNAMIC axes, it does not renegotiate static ones.
        plan, unpinnable = _static_batch_plan([[4, 3, 640, 640]])
        self.assertEqual(plan, {})
        self.assertEqual(unpinnable, [])

    def test_dynamic_spatial_axis_cannot_be_pinned(self) -> None:
        # A dynamic H/W has no value we are allowed to invent — report it so the
        # compile failure below is explained rather than silent.
        plan, unpinnable = _static_batch_plan([[None, 3, None, 640]])
        self.assertEqual(plan, {})
        self.assertEqual(unpinnable, [0])

    def test_multi_input_pins_only_the_dynamic_ones(self) -> None:
        plan, unpinnable = _static_batch_plan([
            [1, 3, 640, 640],
            [None, 3, 112, 112],
        ])
        self.assertEqual(plan, {1: [STATIC_BATCH_PIN, 3, 112, 112]})
        self.assertEqual(unpinnable, [])

    def test_unreadable_shape_is_not_guessed(self) -> None:
        plan, unpinnable = _static_batch_plan([None])
        self.assertEqual(plan, {})
        self.assertEqual(unpinnable, [0])

    def test_rank_one_dynamic_is_pinnable(self) -> None:
        plan, unpinnable = _static_batch_plan([[None]])
        self.assertEqual(plan, {0: [STATIC_BATCH_PIN]})
        self.assertEqual(unpinnable, [])


def _dynamic_batch_ov_model(core, tmpdir: str):
    """Build the smallest ONNX with a DYNAMIC first dim and read it as an OV
    model. Mirrors what `ov.convert_model` produces from every dynamic-batch
    export in this repo (`scripts/build-camstack-models.py`, and the
    model-studio convert path)."""
    import os

    import onnx
    from onnx import TensorProto, helper

    inp = helper.make_tensor_value_info(
        "input", TensorProto.FLOAT, ["batch", 4],
    )
    out = helper.make_tensor_value_info(
        "output", TensorProto.FLOAT, ["batch", 4],
    )
    node = helper.make_node("Relu", ["input"], ["output"])
    graph = helper.make_graph([node], "dyn", [inp], [out])
    model = helper.make_model(
        graph, opset_imports=[helper.make_operatorsetid("", 17)],
    )
    onnx.checker.check_model(model)
    path = os.path.join(tmpdir, "dyn.onnx")
    onnx.save(model, path)
    return core.read_model(path), path


class OpenVinoReshapeTest(unittest.TestCase):
    """The real thing: a dynamic-batch IR compiled for an NPU target.

    This is the case that hung the hub. Without the load-time reshape the graph
    reaches the Level-Zero compiler with a `-1` dim; with it, the model handed to
    `compile_model` is static and the compile is a normal one.
    """

    @classmethod
    def setUpClass(cls) -> None:
        try:
            import onnx  # noqa: F401
            import openvino  # noqa: F401
        except ImportError:  # pragma: no cover - sandbox without the runtime
            raise unittest.SkipTest("openvino/onnx not installed")

    def test_dynamic_batch_is_reshaped_static_for_the_npu(self) -> None:
        import tempfile

        import openvino as ov

        core = ov.Core()
        with tempfile.TemporaryDirectory() as tmp:
            model, path = _dynamic_batch_ov_model(core, tmp)
            self.assertTrue(
                model.input(0).get_partial_shape()[0].is_dynamic,
                "fixture must start dynamic or the test proves nothing",
            )
            pinned = _pin_batch_for_device(core, model, path, "NPU")
            shape = pinned.input(0).get_partial_shape()
            self.assertTrue(shape[0].is_static)
            self.assertEqual(shape[0].get_length(), STATIC_BATCH_PIN)
            # Shape inference must have carried the pin to the OUTPUT too — the
            # plate model carried the `-1` on both ends.
            out_shape = pinned.output(0).get_partial_shape()
            self.assertTrue(out_shape[0].is_static)
            self.assertEqual(out_shape[0].get_length(), STATIC_BATCH_PIN)

    def test_the_source_model_object_is_never_mutated(self) -> None:
        # `Model.reshape` mutates in place, and on the PrePostProcessor path the
        # compile loop REUSES the same object for the next candidate. If the pin
        # leaked, a GPU fallback after a failed NPU attempt would silently
        # compile the pinned graph.
        import tempfile

        import openvino as ov

        core = ov.Core()
        with tempfile.TemporaryDirectory() as tmp:
            model, path = _dynamic_batch_ov_model(core, tmp)
            pinned = _pin_batch_for_device(core, model, path, "NPU")
            self.assertIsNot(pinned, model)
            self.assertTrue(
                model.input(0).get_partial_shape()[0].is_dynamic,
                "the source the caller holds must still be dynamic",
            )

    def test_dynamic_batch_survives_on_cpu(self) -> None:
        import tempfile

        import openvino as ov

        core = ov.Core()
        with tempfile.TemporaryDirectory() as tmp:
            model, path = _dynamic_batch_ov_model(core, tmp)
            same = _pin_batch_for_device(core, model, path, "CPU")
            self.assertIs(same, model, "CPU must get the source object untouched")
            self.assertTrue(same.input(0).get_partial_shape()[0].is_dynamic)

    def test_dynamic_batch_survives_on_gpu(self) -> None:
        import tempfile

        import openvino as ov

        core = ov.Core()
        with tempfile.TemporaryDirectory() as tmp:
            model, path = _dynamic_batch_ov_model(core, tmp)
            same = _pin_batch_for_device(core, model, path, "GPU")
            self.assertTrue(same.input(0).get_partial_shape()[0].is_dynamic)

    def test_a_path_source_is_read_and_pinned_for_the_npu(self) -> None:
        # The non-PPP load path hands `compile_model` the IR PATH, not a model
        # object. The pin has to work from either.
        import tempfile

        import openvino as ov

        core = ov.Core()
        with tempfile.TemporaryDirectory() as tmp:
            _model, path = _dynamic_batch_ov_model(core, tmp)
            pinned = _pin_batch_for_device(core, path, path, "NPU")
            self.assertNotIsInstance(pinned, str)
            shape = pinned.input(0).get_partial_shape()
            self.assertTrue(shape[0].is_static)
            self.assertEqual(shape[0].get_length(), STATIC_BATCH_PIN)

    def test_a_path_source_is_left_a_path_on_cpu(self) -> None:
        # No reshape needed => no wasted read_model; compile still takes the path.
        import tempfile

        import openvino as ov

        core = ov.Core()
        with tempfile.TemporaryDirectory() as tmp:
            _model, path = _dynamic_batch_ov_model(core, tmp)
            self.assertEqual(_pin_batch_for_device(core, path, path, "CPU"), path)

    def test_an_already_static_graph_is_not_re_read_for_the_npu(self) -> None:
        import os
        import tempfile

        import onnx
        import openvino as ov
        from onnx import TensorProto, helper

        core = ov.Core()
        with tempfile.TemporaryDirectory() as tmp:
            inp = helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 4])
            out = helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 4])
            graph = helper.make_graph(
                [helper.make_node("Relu", ["input"], ["output"])],
                "static", [inp], [out],
            )
            model = helper.make_model(
                graph, opset_imports=[helper.make_operatorsetid("", 17)],
            )
            path = os.path.join(tmp, "static.onnx")
            onnx.save(model, path)
            ov_model = core.read_model(path)
            self.assertIs(_pin_batch_for_device(core, ov_model, path, "NPU"), ov_model)

    def test_the_pinned_model_actually_compiles_on_cpu(self) -> None:
        # End of the chain: a reshaped model is still a compilable model. (The
        # NPU itself is not present on a dev machine — CPU proves the graph
        # survived the reshape, the shape assertions above prove it is static.)
        import tempfile

        import numpy as np
        import openvino as ov

        core = ov.Core()
        with tempfile.TemporaryDirectory() as tmp:
            model, path = _dynamic_batch_ov_model(core, tmp)
            pinned = _pin_batch_for_device(core, model, path, "NPU")
            compiled = core.compile_model(pinned, device_name="CPU")
            result = compiled(np.zeros((1, 4), dtype=np.float32))
            self.assertEqual(list(result[compiled.output(0)].shape), [1, 4])


class _RecordingCore:
    """A real `ov.Core` with `compile_model` intercepted: it records EXACTLY what
    the loader handed the compiler, then compiles it for CPU so the rest of the
    load path (outputs, properties, infer requests) runs for real.

    This is the fake that cannot lie in the dangerous direction — it supplies
    nothing, it only observes production's own argument.
    """

    def __init__(self, real: Any) -> None:  # noqa: ANN401 - test double
        self._real = real
        self.compiled: list = []

    def read_model(self, path: str) -> Any:  # noqa: ANN401 - test double
        return self._real.read_model(path)

    def compile_model(self, source: Any, device_name: str, config: Any = None) -> Any:  # noqa: ANN401
        self.compiled.append((source, device_name))
        return self._real.compile_model(source, device_name="CPU")


class LoadPathAppliesTheRuleTest(unittest.TestCase):
    """The derivation has to happen AT THE LOAD, not merely be available.

    Drives `_load_model`'s OpenVINO branch with an operator-pinned NPU device
    and asserts the object that reached `compile_model` was static. Remove the
    `_pin_batch_for_device` call from the compile loop and this goes red —
    the helper tests above would stay green.
    """

    @classmethod
    def setUpClass(cls) -> None:
        try:
            import onnx  # noqa: F401
            import openvino  # noqa: F401
        except ImportError:  # pragma: no cover - sandbox without the runtime
            raise unittest.SkipTest("openvino/onnx not installed")

    def _load_with_pinned_device(self, device: str) -> tuple:
        import tempfile

        import openvino as ov

        import inference_pool as ip

        core = ov.Core()
        saved = (ip._runtime, ip._runtime_lib, ip._OV_PPP_ENABLED)
        with tempfile.TemporaryDirectory() as tmp:
            _model, path = _dynamic_batch_ov_model(core, tmp)
            recording = _RecordingCore(core)
            ip._runtime = "openvino"
            ip._runtime_lib = recording
            # PPP folds a uint8 NHWC preprocessor into image graphs; this 2-D
            # fixture is not one, and disabling it keeps the test on the plain
            # path where `compile_source` is the PATH — the harder case.
            ip._OV_PPP_ENABLED = False
            try:
                slot = ip.ModelSlot()
                ip._load_model(slot, {"path": path, "device": device})
            finally:
                (ip._runtime, ip._runtime_lib, ip._OV_PPP_ENABLED) = saved
            self.assertTrue(slot.loaded)
            self.assertEqual(len(recording.compiled), 1)
            return recording.compiled[0]

    def test_npu_pin_reaches_the_compiler_static(self) -> None:
        source, device = self._load_with_pinned_device("NPU")
        self.assertEqual(device, "NPU")
        self.assertNotIsInstance(
            source, str, "the NPU must be handed a reshaped model, not the raw IR path",
        )
        shape = source.input(0).get_partial_shape()
        self.assertTrue(shape[0].is_static)
        self.assertEqual(shape[0].get_length(), STATIC_BATCH_PIN)

    def test_gpu_pin_reaches_the_compiler_untouched(self) -> None:
        source, device = self._load_with_pinned_device("GPU")
        self.assertEqual(device, "GPU")
        self.assertIsInstance(
            source, str, "a target that accepts dynamic dims gets the path as before",
        )


if __name__ == "__main__":
    unittest.main()
