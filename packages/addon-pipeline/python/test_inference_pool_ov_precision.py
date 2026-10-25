"""Unit tests for the OpenVINO COMPILATION thread-pool bound.

The failure this guards: OpenVINO sizes the pool that COMPILES a model to the
machine's core count, per compile, and TBB never retires those workers — they
live as long as the process. Measured on the hub (20 cores) 2026-09-18, the
detection pool held 214 threads 17 minutes after boot, created in bursts of ~23
at exactly its compile timestamps. A container cgroup counts THREADS, and this
one refused 22 forks in 45 minutes against `pids.max=2048`.

The second half of the guard is just as important: a plugin REJECTS a property
it does not support, and the compile failover loop would read that rejection as
"this device cannot run the model" and quietly push a GPU model onto the CPU.
So the key is only ever sent to a device whose SUPPORTED_PROPERTIES lists it.

Pure-python: stubs numpy / PIL / postprocessors so the module imports without
the ML runtime installed.

Run: python3 -m unittest test_inference_pool_ov_threads -v
"""
from __future__ import annotations

import sys
import types
import unittest

try:  # real numpy when the sandbox has it — a blind stub POISONS the whole
    import numpy  # noqa: F401  # pytest session for every sibling that needs it
except ImportError:
    _np = types.ModuleType("numpy")
    _np.array = lambda seq, dtype=None: list(seq)  # noqa: E731
    _np.float32 = "float32"
    sys.modules["numpy"] = _np

try:  # real PIL when present, for the same reason
    import PIL.Image  # noqa: F401
except ImportError:
    _pil = types.ModuleType("PIL")
    _pil_image = types.ModuleType("PIL.Image")
    _pil.Image = _pil_image
    sys.modules["PIL"] = _pil
    sys.modules["PIL.Image"] = _pil_image

if "postprocessors" not in sys.modules:
    _pp = types.ModuleType("postprocessors")
    _pp.POSTPROCESSORS = {}
    sys.modules["postprocessors"] = _pp

from inference_pool import _ov_precision_properties  # noqa: E402

GPU_PROPS = ["PERFORMANCE_HINT", "INFERENCE_PRECISION_HINT"]


class OvPrecisionPropertiesTest(unittest.TestCase):
    """A model whose catalog entry says the GPU must run it at f32 gets
    INFERENCE_PRECISION_HINT=f32 on a GPU — and nowhere else.

    The failure this guards (2026-10-07): the YOLO26 base FP32 IRs `yolo26s`,
    `yolo26m` and `yolo26m-320` compiled at the iGPU's default f16 precision and
    returned no valid detection on both the Core Ultra iGPU and the N100 (0 true
    / 146 false positives for `yolo26s`, NaN scores for `yolo26m*`). At f32 they
    match the CPU.
    """

    def test_a_gpu_gets_f32_when_the_model_asks_for_it(self):
        self.assertEqual(
            _ov_precision_properties({"gpuInferencePrecision": "f32"}, "GPU", GPU_PROPS),
            {"INFERENCE_PRECISION_HINT": "f32"},
        )

    def test_a_numbered_gpu_is_a_gpu(self):
        self.assertEqual(
            _ov_precision_properties({"gpuInferencePrecision": "f32"}, "GPU.1", GPU_PROPS),
            {"INFERENCE_PRECISION_HINT": "f32"},
        )

    def test_a_model_that_does_not_ask_keeps_the_device_default(self):
        self.assertEqual(_ov_precision_properties({}, "GPU", GPU_PROPS), {})

    def test_the_npu_and_cpu_keep_their_default(self):
        cfg = {"gpuInferencePrecision": "f32"}
        self.assertEqual(_ov_precision_properties(cfg, "NPU", GPU_PROPS), {})
        self.assertEqual(_ov_precision_properties(cfg, "CPU", GPU_PROPS), {})

    def test_a_gpu_that_does_not_list_the_key_compiles_unchanged(self):
        # A rejected property would push the model onto the next device.
        self.assertEqual(
            _ov_precision_properties({"gpuInferencePrecision": "f32"}, "GPU", ["PERFORMANCE_HINT"]),
            {},
        )

    def test_an_unknown_value_is_not_forwarded(self):
        self.assertEqual(
            _ov_precision_properties({"gpuInferencePrecision": "bf8"}, "GPU", GPU_PROPS), {}
        )


if __name__ == "__main__":
    unittest.main()
