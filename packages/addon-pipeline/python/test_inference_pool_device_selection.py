"""Unit tests for the runtime device/provider selection in inference_pool.

Covers:
  - _resolve_ov_devices — the OpenVINO explicit device-candidate ordering.
  - _resolve_onnx_providers — the ONNX execution-provider ordering
    with camstack's pin + availability filter.

Pure-python: stubs numpy / PIL / postprocessors in sys.modules so the module
imports without the ML runtime installed (inference_pool uses
`from __future__ import annotations`, so annotations never touch the stubs).

Run: python3 -m unittest test_inference_pool_device_selection -v
"""
from __future__ import annotations

import sys
import types
import unittest

# ---------------------------------------------------------------------------
# Stub the heavy third-party imports BEFORE importing inference_pool.
# ---------------------------------------------------------------------------

try:  # real numpy when the sandbox has it — a blind stub POISONS the whole
    import numpy  # noqa: F401  # pytest session for every sibling that needs it
except ImportError:
    _np = types.ModuleType("numpy")
    # `inference_pool` builds `_IMAGENET_MEAN = np.array(...)` at import time.
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

from inference_pool import (
    ONNX_COREML_EP,
    ONNX_CPU_EP,
    ONNX_CUDA_EP,
    _resolve_onnx_providers,
    _resolve_ov_devices,
)


class ResolveOvDevicesTest(unittest.TestCase):
    """Ordered EXPLICIT device candidates (NPU>GPU>CPU) — no AUTO.

    The AUTO plugin's CPU->GPU handover invalidated in-flight InferRequest ports
    ("score_8"); _resolve_ov_devices returns an ordered candidate list the
    compile loop fails over explicitly, so AUTO is never used. CPU is always the
    guaranteed floor/last entry.
    """

    def test_n100_intel_igpu_and_cpu_is_gpu_then_cpu(self) -> None:
        # Intel iGPU + CPU, no NPU — GPU first, CPU floor.
        self.assertEqual(
            _resolve_ov_devices(
                ["CPU", "GPU"],
                {
                    "CPU": "Intel(R) N100",
                    "GPU": "Intel(R) UHD Graphics [0x46d1] (iGPU)",
                },
            ),
            ["GPU", "CPU"],
        )

    def test_hub_npu_gpu_cpu_orders_npu_gpu_cpu(self) -> None:
        self.assertEqual(
            _resolve_ov_devices(
                ["CPU", "GPU", "NPU"],
                {
                    "CPU": "Intel(R) Core(TM) Ultra 5 125H",
                    "GPU": "Intel(R) Arc(TM) Graphics (iGPU)",
                    "NPU": "Intel(R) AI Boost",
                },
            ),
            ["NPU", "GPU", "CPU"],
        )

    def test_npu_without_gpu_orders_npu_cpu(self) -> None:
        self.assertEqual(
            _resolve_ov_devices(
                ["CPU", "NPU"],
                {
                    "CPU": "Intel(R) Core(TM) Ultra",
                    "NPU": "Intel(R) AI Boost",
                },
            ),
            ["NPU", "CPU"],
        )

    def test_single_nvidia_dgpu_orders_gpu_cpu(self) -> None:
        self.assertEqual(
            _resolve_ov_devices(
                ["CPU", "GPU.0"],
                {
                    "CPU": "Intel(R) Core(TM) i5",
                    "GPU.0": "NVIDIA GeForce RTX 3060 (dGPU)",
                },
            ),
            ["GPU.0", "CPU"],
        )

    def test_multiple_gpus_join_in_enumeration_order(self) -> None:
        self.assertEqual(
            _resolve_ov_devices(
                ["CPU", "GPU.0", "GPU.1"],
                {
                    "CPU": "Intel(R) Core(TM) i9",
                    "GPU.0": "NVIDIA GeForce RTX 4090 (dGPU)",
                    "GPU.1": "NVIDIA GeForce RTX 4090 (dGPU)",
                },
            ),
            ["GPU.0", "GPU.1", "CPU"],
        )

    def test_mixed_igpu_and_dgpu_both_candidates_in_order(self) -> None:
        # No dGPU-vs-iGPU precedence now: every named GPU is a failover
        # candidate, tried in enumeration order, CPU last.
        self.assertEqual(
            _resolve_ov_devices(
                ["CPU", "GPU.0", "GPU.1"],
                {
                    "CPU": "Intel(R) Core(TM) i7",
                    "GPU.0": "Intel(R) UHD Graphics (iGPU)",
                    "GPU.1": "NVIDIA GeForce RTX 3080 (dGPU)",
                },
            ),
            ["GPU.0", "GPU.1", "CPU"],
        )

    def test_npu_precedes_gpus(self) -> None:
        self.assertEqual(
            _resolve_ov_devices(
                ["CPU", "GPU.0", "NPU"],
                {
                    "CPU": "Intel(R) Core(TM) Ultra",
                    "GPU.0": "NVIDIA GeForce RTX 3060 (dGPU)",
                    "NPU": "Intel(R) AI Boost",
                },
            ),
            ["NPU", "GPU.0", "CPU"],
        )

    def test_cpu_only_is_cpu(self) -> None:
        self.assertEqual(
            _resolve_ov_devices(["CPU"], {"CPU": "Intel(R) N100"}),
            ["CPU"],
        )

    def test_empty_available_falls_back_to_cpu(self) -> None:
        self.assertEqual(_resolve_ov_devices([], {}), ["CPU"])

    def test_gpu_without_full_name_is_not_a_candidate(self) -> None:
        # A GPU whose FULL_DEVICE_NAME query failed is skipped; CPU floor remains.
        self.assertEqual(
            _resolve_ov_devices(["CPU", "GPU"], {"CPU": "Intel(R) N100"}),
            ["CPU"],
        )


class ResolveOnnxProvidersTest(unittest.TestCase):
    """ONNX EP ordering + camstack's pin/availability filter."""

    def test_darwin_auto_prefers_coreml_cpu_last(self) -> None:
        self.assertEqual(
            _resolve_onnx_providers(
                "", "darwin", "arm64", [ONNX_COREML_EP, ONNX_CPU_EP],
            ),
            [ONNX_COREML_EP, ONNX_CPU_EP],
        )

    def test_linux_x86_auto_prefers_cuda_with_device_id(self) -> None:
        self.assertEqual(
            _resolve_onnx_providers(
                "auto", "linux", "x86_64", [ONNX_CUDA_EP, ONNX_CPU_EP],
            ),
            [(ONNX_CUDA_EP, {"device_id": 0}), ONNX_CPU_EP],
        )

    def test_windows_amd64_auto_prefers_cuda(self) -> None:
        self.assertEqual(
            _resolve_onnx_providers(
                "", "win32", "AMD64", [ONNX_CUDA_EP, ONNX_CPU_EP],
            ),
            [(ONNX_CUDA_EP, {"device_id": 0}), ONNX_CPU_EP],
        )

    def test_plain_wheel_drops_unavailable_cuda(self) -> None:
        # camstack ships the plain onnxruntime wheel (no CUDA EP) — the
        # unavailable EP is filtered so session creation cannot raise.
        self.assertEqual(
            _resolve_onnx_providers("auto", "linux", "x86_64", [ONNX_CPU_EP]),
            [ONNX_CPU_EP],
        )

    def test_linux_arm64_auto_is_cpu_only(self) -> None:
        self.assertEqual(
            _resolve_onnx_providers(
                "", "linux", "aarch64", [ONNX_CUDA_EP, ONNX_CPU_EP],
            ),
            [ONNX_CPU_EP],
        )

    def test_darwin_never_matches_win_substring(self) -> None:
        # "win" in "darwin" is True — the helper must NOT add CUDA on an
        # Intel Mac (a substring "win" in platform check would misfire).
        self.assertEqual(
            _resolve_onnx_providers(
                "", "darwin", "x86_64",
                [ONNX_COREML_EP, ONNX_CUDA_EP, ONNX_CPU_EP],
            ),
            [ONNX_COREML_EP, ONNX_CPU_EP],
        )

    def test_cpu_pin_is_cpu_only(self) -> None:
        self.assertEqual(
            _resolve_onnx_providers(
                "cpu", "linux", "x86_64", [ONNX_CUDA_EP, ONNX_CPU_EP],
            ),
            [ONNX_CPU_EP],
        )

    def test_webgpu_pin_is_cpu_only_in_classic_resolver(self) -> None:
        # WebGPU uses the plugin SessionOptions path; the classic resolver
        # must not inject CUDA when device=webgpu (would race the plugin load).
        self.assertEqual(
            _resolve_onnx_providers(
                "webgpu", "linux", "x86_64", [ONNX_CUDA_EP, ONNX_CPU_EP],
            ),
            [ONNX_CPU_EP],
        )

    def test_cuda_pin_orders_cuda_first_cpu_last(self) -> None:
        self.assertEqual(
            _resolve_onnx_providers(
                "cuda", "linux", "x86_64", [ONNX_CUDA_EP, ONNX_CPU_EP],
            ),
            [(ONNX_CUDA_EP, {"device_id": 0}), ONNX_CPU_EP],
        )

    def test_cuda_pin_respects_device_id(self) -> None:
        self.assertEqual(
            _resolve_onnx_providers(
                "cuda", "linux", "x86_64", [ONNX_CUDA_EP, ONNX_CPU_EP],
                cuda_device_id=1,
            ),
            [(ONNX_CUDA_EP, {"device_id": 1}), ONNX_CPU_EP],
        )

    def test_coreml_pin_orders_coreml_first(self) -> None:
        self.assertEqual(
            _resolve_onnx_providers(
                "coreml", "darwin", "arm64", [ONNX_COREML_EP, ONNX_CPU_EP],
            ),
            [ONNX_COREML_EP, ONNX_CPU_EP],
        )

    def test_pinned_but_unavailable_ep_falls_back_to_cpu(self) -> None:
        self.assertEqual(
            _resolve_onnx_providers("coreml", "linux", "x86_64", [ONNX_CPU_EP]),
            [ONNX_CPU_EP],
        )


if __name__ == "__main__":
    unittest.main()
