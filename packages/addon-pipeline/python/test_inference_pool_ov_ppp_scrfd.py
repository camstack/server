"""Pins the OpenVINO PPP fold's `'scrfd'` branch (`_build_ov_ppp_model`,
`inference_pool.py` ~1719) — the code path that folds InsightFace's SCRFD
input contract (`(x-127.5)/128`) into a compiled OpenVINO graph, mirrored
against `_apply_normalization`'s plain-Python path (covered separately by
`test_inference_pool_scrfd_normalization.py`).

`_ov_ppp_plan` (tested elsewhere) only proves the CONFIG VALUE `'scrfd'`
reaches a plan dict — it does not touch `_build_ov_ppp_model`'s actual
`elif plan["normalization"] == "scrfd":` branch, so renaming or deleting that
branch (falling through to the `else` — plain `/255`, no shift) would leave
every other test green. This file drives `_build_ov_ppp_model` itself and
asserts the exact preprocessing STEPS it records for `'scrfd'`.

No real OpenVINO install needed: `openvino` / `openvino.preprocess` are
FAKE modules that record every `PrePostProcessor` call instead of running one,
built fresh in `setUp` and removed in `tearDown` so nothing leaks into a
sibling test run in the same `python3 -m unittest` process (this repo's own
warning: "a blind stub POISONS the whole session"). If real `openvino` is
importable, this test still uses its own fakes (swapped in for the duration
of the test only) rather than depending on optional real behaviour — so it
runs the same way whether or not OpenVINO is installed.

`unittest.TestCase`, not pytest-style — runs on the bare interpreter, no
pytest needed (`scripts/test-python-pool.sh`, the path CI exercises).
"""
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

import inference_pool  # noqa: E402
from inference_pool import _SCRFD_MEAN, _SCRFD_STD, _build_ov_ppp_model  # noqa: E402


# ---------------------------------------------------------------------------
# Fakes standing in for the real `openvino` / `openvino.preprocess` API
# surface `_build_ov_ppp_model` calls. Each records the calls made on it.
# ---------------------------------------------------------------------------


class _FakeSteps:
    """Stands in for OpenVINO's `PreProcessSteps` — every call is recorded,
    in order, so the test can assert the EXACT scale/mean sequence."""

    def __init__(self, calls: list) -> None:
        self._calls = calls

    def convert_element_type(self, t):
        self._calls.append(("convert_element_type", t))
        return self

    def scale(self, v):
        self._calls.append(("scale", tuple(v)))
        return self

    def mean(self, v):
        self._calls.append(("mean", tuple(v)))
        return self


class _FakeTensorInfo:
    def set_element_type(self, t):
        return self

    def set_layout(self, layout):
        return self


class _FakeModelInfo:
    def set_layout(self, layout):
        return self


class _FakeInputInfo:
    def __init__(self, calls: list) -> None:
        self._steps = _FakeSteps(calls)

    def tensor(self):
        return _FakeTensorInfo()

    def model(self):
        return _FakeModelInfo()

    def preprocess(self):
        return self._steps


class _FakePrePostProcessor:
    """Records every preprocessing step applied, keyed by the model it was
    built for — `_build_ov_ppp_model` builds exactly one per call."""

    last_calls: "list | None" = None

    def __init__(self, model) -> None:
        self._calls: list = []
        _FakePrePostProcessor.last_calls = self._calls
        self._input = _FakeInputInfo(self._calls)

    def input(self):
        return self._input

    def build(self):
        return "BUILT_MODEL"


class _FakeLayout:
    def __init__(self, name: str) -> None:
        self.name = name


class _FakeType:
    u8 = "u8"
    f32 = "f32"


class _FakeDim:
    """Mimics an OpenVINO static Dimension (see `test_inference_pool_ov_ppp.py`)."""

    def __init__(self, length: int) -> None:
        self._length = length
        self.is_static = True

    def __int__(self) -> int:
        raise TypeError("Dimension is not directly int()-able")

    def get_length(self) -> int:
        return self._length


class _FakeInput:
    def __init__(self, dims) -> None:
        self._dims = dims

    def get_partial_shape(self):
        return self._dims


class _FakeModel:
    def __init__(self, dims) -> None:
        self._input = _FakeInput(dims)

    def input(self):
        return self._input


class _FakeCore:
    def __init__(self, dims) -> None:
        self._dims = dims

    def read_model(self, path):
        return _FakeModel(self._dims)


# A standard 640x640 NCHW 3-channel static-shape detector input — the shape
# `_ov_ppp_plan` requires to fold preprocessing at all.
_NCHW_640_DIMS = [_FakeDim(1), _FakeDim(3), _FakeDim(640), _FakeDim(640)]


class BuildOvPppModelScrfdBranchTest(unittest.TestCase):
    def setUp(self):
        # Swap in the fakes for the duration of this test ONLY, whether or
        # not real openvino/openvino.preprocess were already in sys.modules —
        # restored in tearDown so nothing leaks into a sibling test run in
        # the same `python3 -m unittest` process.
        self._saved_openvino = sys.modules.get("openvino")
        self._saved_openvino_preprocess = sys.modules.get("openvino.preprocess")

        fake_openvino = types.ModuleType("openvino")
        fake_openvino.Layout = _FakeLayout
        fake_openvino.Type = _FakeType
        fake_preprocess = types.ModuleType("openvino.preprocess")
        fake_preprocess.PrePostProcessor = _FakePrePostProcessor
        fake_openvino.preprocess = fake_preprocess

        sys.modules["openvino"] = fake_openvino
        sys.modules["openvino.preprocess"] = fake_preprocess

    def tearDown(self):
        for name, saved in (
            ("openvino", self._saved_openvino),
            ("openvino.preprocess", self._saved_openvino_preprocess),
        ):
            if saved is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = saved

    def test_scrfd_branch_applies_the_scrfd_mean_and_std(self):
        core = _FakeCore(_NCHW_640_DIMS)
        config = {
            "inputSize": 640,
            "inputWidth": 640,
            "inputHeight": 640,
            "inputChannels": 3,
            "preprocessMode": "letterbox",
            "inputNormalization": "scrfd",
        }
        built, plan = _build_ov_ppp_model(core, "dummy-path", config)
        self.assertEqual(built, "BUILT_MODEL")
        self.assertEqual(plan["normalization"], "scrfd")

        calls = _FakePrePostProcessor.last_calls
        # convert_element_type, then scale(255) → mean(_SCRFD_MEAN) →
        # scale(_SCRFD_STD) — exactly 4 recorded steps, in this order. If the
        # 'scrfd' branch is removed (falling to the bare `else: scale(255)`),
        # this drops to 2 steps and the assertion below fails.
        self.assertEqual(
            calls,
            [
                ("convert_element_type", "f32"),
                ("scale", (255.0, 255.0, 255.0)),
                ("mean", (_SCRFD_MEAN, _SCRFD_MEAN, _SCRFD_MEAN)),
                ("scale", (_SCRFD_STD, _SCRFD_STD, _SCRFD_STD)),
            ],
        )

    def test_scrfd_branch_is_distinct_from_imagenet_and_none(self):
        core = _FakeCore(_NCHW_640_DIMS)

        def steps_for(normalization):
            config = {
                "inputSize": 640,
                "inputWidth": 640,
                "inputHeight": 640,
                "inputChannels": 3,
                "preprocessMode": "letterbox",
                "inputNormalization": normalization,
            }
            _build_ov_ppp_model(core, "dummy-path", config)
            return _FakePrePostProcessor.last_calls

        scrfd_calls = steps_for("scrfd")
        imagenet_calls = steps_for("imagenet")
        none_calls = steps_for(None)

        self.assertEqual(len(scrfd_calls), 4)
        self.assertEqual(len(imagenet_calls), 4)
        self.assertEqual(len(none_calls), 2)  # convert_element_type + scale(255) only
        self.assertNotEqual(scrfd_calls, imagenet_calls)
        # The imagenet branch uses the real _IMAGENET_MEAN/_STD, not SCRFD's.
        self.assertNotIn(("mean", (_SCRFD_MEAN, _SCRFD_MEAN, _SCRFD_MEAN)), imagenet_calls)


if __name__ == "__main__":
    unittest.main()
