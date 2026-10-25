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

from inference_pool import (  # noqa: E402
    OV_COMPILATION_NUM_THREADS,
    _ov_compilation_properties,
    _ov_supported_properties,
)


class _Core:
    """A core whose SUPPORTED_PROPERTIES answer is scripted per device."""

    def __init__(self, answers: dict) -> None:
        self._answers = answers

    def get_property(self, device: str, name: str):  # noqa: ANN401
        answer = self._answers[device]
        if isinstance(answer, Exception):
            raise answer
        return answer


class OvCompilationPropertiesTest(unittest.TestCase):
    def test_the_bound_is_sent_to_a_device_that_supports_it(self):
        props = _ov_compilation_properties(["PERFORMANCE_HINT", "COMPILATION_NUM_THREADS"], 4)
        self.assertEqual(props, {"COMPILATION_NUM_THREADS": 4})

    def test_a_device_that_does_not_support_it_compiles_unchanged(self):
        # An unsupported property raises out of compile_model, and the failover
        # loop would read that as "this device cannot run the model" and land a
        # GPU model on the CPU. Absent beats rejected.
        self.assertEqual(_ov_compilation_properties(["PERFORMANCE_HINT"], 4), {})

    def test_zero_or_negative_means_leave_openvino_alone(self):
        supported = ["COMPILATION_NUM_THREADS"]
        self.assertEqual(_ov_compilation_properties(supported, 0), {})
        self.assertEqual(_ov_compilation_properties(supported, -1), {})

    def test_the_shipped_default_actually_bounds_something(self):
        # A default of 0 would ship the measurement and none of the fix.
        self.assertGreater(OV_COMPILATION_NUM_THREADS, 0)
        self.assertLessEqual(OV_COMPILATION_NUM_THREADS, 8)

    def test_the_default_survives_a_round_trip_through_the_gate(self):
        self.assertEqual(
            _ov_compilation_properties(
                ["COMPILATION_NUM_THREADS"], OV_COMPILATION_NUM_THREADS
            ),
            {"COMPILATION_NUM_THREADS": OV_COMPILATION_NUM_THREADS},
        )


class OvSupportedPropertiesTest(unittest.TestCase):
    def test_reads_the_device_list(self):
        core = _Core({"GPU": ["PERFORMANCE_HINT", "COMPILATION_NUM_THREADS"]})
        self.assertEqual(
            _ov_supported_properties(core, "GPU"),
            ["PERFORMANCE_HINT", "COMPILATION_NUM_THREADS"],
        )

    def test_a_probe_that_fails_reports_nothing_rather_than_guessing(self):
        core = _Core({"NPU": RuntimeError("property not supported")})
        self.assertEqual(_ov_supported_properties(core, "NPU"), [])


if __name__ == "__main__":
    unittest.main()
