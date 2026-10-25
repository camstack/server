"""Layout heuristic for OpenVINO/ONNX preprocess — ArcFace/CLIP are NHWC.

The face-embedding (arcface, [N,112,112,3]) and CLIP models are channels-last;
the OpenVINO/ONNX preprocess used to feed NCHW unconditionally, which a strict
backend (NPU) rejects — the multi-day face-collection outage. `_is_channels_last`
decides the layout from the model's declared input shape, defaulting to NCHW
(the prior behaviour) whenever it can't be sure, so detectors are never touched.

Heavy runtime deps (numpy, PIL, openvino) are stubbed so the pure helper imports
in a minimal sandbox.
"""
import sys
import types

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

from inference_pool import _is_channels_last, _resolve_input_dims  # noqa: E402


def test_resolve_input_dims_defaults_to_square_rgb() -> None:
    # Legacy square model: no explicit width/height/channels → (size, size, 3).
    assert _resolve_input_dims({"inputSize": 640}) == (640, 640, 3)


def test_resolve_input_dims_explicit_non_square_grayscale() -> None:
    # Plate-OCR VGG: 384×64, 1 channel — the shape the OCR runtime demands.
    cfg = {"inputSize": 384, "inputWidth": 384, "inputHeight": 64, "inputChannels": 1}
    assert _resolve_input_dims(cfg) == (384, 64, 1)


def test_resolve_input_dims_falls_back_to_size_when_dims_missing() -> None:
    assert _resolve_input_dims({"inputSize": 320}) == (320, 320, 3)


def test_arcface_nhwc_is_channels_last() -> None:
    assert _is_channels_last([1, 112, 112, 3]) is True


def test_clip_nhwc_is_channels_last() -> None:
    assert _is_channels_last([1, 224, 224, 3]) is True


def test_standard_detector_nchw_is_not() -> None:
    assert _is_channels_last([1, 3, 640, 640]) is False


def test_grayscale_nchw_is_not() -> None:
    assert _is_channels_last([1, 1, 112, 112]) is False


def test_dynamic_or_unknown_falls_back_to_nchw() -> None:
    assert _is_channels_last([None, 3, 640, 640]) is False
    assert _is_channels_last([1, None, None, 3]) is False  # second dim unknown → unsure → NCHW
    assert _is_channels_last([1, 3, 640]) is False  # not 4-D
    assert _is_channels_last(None) is False
