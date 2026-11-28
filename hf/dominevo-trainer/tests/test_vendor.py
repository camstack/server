"""The vendored harness imports the vendored inference pool, not a repo path."""
from __future__ import annotations

from pathlib import Path

from camstack_train._vendor import PIPELINE_PYTHON, ensure_pipeline_on_path


def test_harness_resolves_the_vendored_pool():
    ensure_pipeline_on_path()
    from camstack_train._vendor.camstack_eval.pipeline import _pipeline

    pool, postprocessors = _pipeline()
    assert Path(pool.__file__).resolve().parent == PIPELINE_PYTHON
    assert "yolo" in postprocessors


def test_pool_letterbox_is_grey_114():
    ensure_pipeline_on_path()
    import inference_pool
    from PIL import Image

    arr, scale, pad = inference_pool.letterbox(Image.new("RGB", (64, 32), (0, 0, 0)), 64)
    assert arr.shape == (64, 64, 3) and pad == (0, 16) and scale == 1.0
    assert abs(float(arr[0, 0, 0]) - 114 / 255) < 1e-6
