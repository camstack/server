"""Numeric tests for the preprocess tensor builders — `_to_model_tensor`
(RGB NHWC/NCHW) and `_preprocess_ctc_gray` (EasyOCR grayscale plate-OCR).

Requires real numpy + PIL (the embedded portable Python the pool runs on). On a
minimal sandbox without them the whole module is skipped — the pure branch-
selection logic is covered separately in `test_inference_pool_layout.py`.
"""
import pytest

np = pytest.importorskip("numpy")
PIL = pytest.importorskip("PIL")
from PIL import Image  # noqa: E402

import inference_pool  # noqa: E402
from inference_pool import (  # noqa: E402
    _preprocess,
    _preprocess_ctc_gray,
    _preprocess_ov_uint8,
    _to_model_tensor,
)


def _hwc(h: int, w: int) -> "np.ndarray":
    return (np.arange(h * w * 3, dtype=np.float32) % 255 / 255.0).reshape(h, w, 3)


@pytest.fixture(autouse=True)
def _restore_inference_pool_globals(monkeypatch: pytest.MonkeyPatch) -> None:
    # Snapshot + replace so a test that assigns `_runtime` or mutates the
    # bench cache cannot leak into a later case in the same process.
    monkeypatch.setattr(inference_pool, "_runtime", inference_pool._runtime)
    monkeypatch.setattr(inference_pool, "_bench_preprocess_cache", {})
    monkeypatch.setattr(inference_pool, "_bench_cache_hits", 0)
    monkeypatch.setattr(inference_pool, "_bench_cache_misses", 0)


def _track_image_resize(monkeypatch: pytest.MonkeyPatch) -> list[object]:
    calls: list[object] = []
    original_resize = Image.Image.resize

    def tracking_resize(self: Image.Image, *args: object, **kwargs: object) -> Image.Image:
        calls.append((args, kwargs))
        return original_resize(self, *args, **kwargs)

    monkeypatch.setattr(Image.Image, "resize", tracking_resize)
    return calls


def test_rgb_detector_is_nchw() -> None:
    out = _to_model_tensor(_hwc(640, 640), channels_last=False)
    assert out.shape == (1, 3, 640, 640)
    assert out.dtype == np.float32


def test_rgb_embedder_is_nhwc_when_channels_last() -> None:
    # ArcFace/CLIP: keep [1,H,W,C] — never transpose.
    out = _to_model_tensor(_hwc(112, 112), channels_last=True)
    assert out.shape == (1, 112, 112, 3)


def test_ctc_gray_shape_is_nchw_single_channel() -> None:
    # Plate-OCR: model input [1, 1, 64, 384].
    img = Image.new("RGB", (200, 60), (128, 128, 128))
    out = _preprocess_ctc_gray(img, input_w=384, input_h=64)
    assert out.shape == (1, 1, 64, 384)
    assert out.dtype == np.float32


def test_ctc_gray_is_normalized_to_minus_one_one() -> None:
    # A flat mid-gray (128) maps to ~0 under (x/255-0.5)/0.5.
    img = Image.new("RGB", (200, 60), (128, 128, 128))
    out = _preprocess_ctc_gray(img, 384, 64)
    assert abs(float(out.mean())) < 0.02
    white = _preprocess_ctc_gray(Image.new("RGB", (200, 60), (255, 255, 255)), 384, 64)
    black = _preprocess_ctc_gray(Image.new("RGB", (200, 60), (0, 0, 0)), 384, 64)
    assert np.allclose(white, 1.0, atol=1e-3)
    assert np.allclose(black, -1.0, atol=1e-3)


def test_ctc_gray_preserves_aspect_and_edge_pads() -> None:
    # A 128 wide × 64 tall crop → ratio 2.0 → resized_w = ceil(64*2)=128 ≤ 384,
    # so the right 384-128=256 columns are edge-replicated (equal to col 127).
    img = Image.new("RGB", (128, 64), (200, 200, 200))
    out = _preprocess_ctc_gray(img, 384, 64)[0, 0]  # (64, 384)
    # Padded region replicates the last real column → constant across width here.
    assert np.allclose(out[:, 128:], out[:, 127:128], atol=1e-4)


def test_ctc_gray_caps_resized_width_at_input_w() -> None:
    # Very wide crop (ratio > 6) → resized_w capped at input_w (no overflow).
    img = Image.new("RGB", (800, 64), (50, 50, 50))
    out = _preprocess_ctc_gray(img, 384, 64)
    assert out.shape == (1, 1, 64, 384)


# ---------------------------------------------------------------------------
# Fix 2 — OpenVINO PrePostProcessor uint8 producer (`_preprocess_ov_uint8`)
# ---------------------------------------------------------------------------


def test_ov_uint8_letterbox_is_nhwc_uint8_at_model_size() -> None:
    # A non-square frame is aspect-preserved + padded to a square uint8 canvas.
    plan = {"inputW": 640, "inputH": 640, "size": 640, "letterbox": True, "normalization": "none"}
    img = Image.new("RGB", (1280, 720), (10, 20, 30))
    tensor, scale, pad = _preprocess_ov_uint8(img, plan)
    assert tensor.shape == (1, 106, 106, 3)  # NHWC — OV transposes on-device
    assert tensor.dtype == np.uint8  # NO float/255 in Python — folded into OV
    assert 0 < scale < 1  # 640/1280
    assert pad[1] > 0  # letterbox pads the shorter (vertical) axis


def test_ov_uint8_letterbox_preserves_aspect_ratio() -> None:
    # The real content occupies scale*orig; the rest is 114 grey padding — the
    # aspect-ratio letterbox YOLO needs, preserved even though float/layout
    # moved into OV.
    plan = {"inputW": 640, "inputH": 640, "size": 640, "letterbox": True, "normalization": "none"}
    img = Image.new("RGB", (1280, 640), (200, 100, 50))
    tensor, scale, pad = _preprocess_ov_uint8(img, plan)
    assert scale == pytest.approx(0.5, abs=1e-6)
    # Padded rows (top/bottom) are the 114 letterbox fill.
    grid = tensor[0]
    assert np.all(grid[0] == 114)
    assert np.all(grid[-1] == 114)


@pytest.mark.parametrize(
    "content_size",
    [(320, 180), (640, 360), (320, 240), (180, 320), (416, 234)],
)
def test_content_sized_yolo_view_adds_padding_without_second_resize(
    monkeypatch: pytest.MonkeyPatch, content_size: tuple[int, int]
) -> None:
    calls = _track_image_resize(monkeypatch)
    input_size = max(content_size)
    canvas, scale, pad = inference_pool.letterbox_image(
        Image.new("RGB", content_size, (10, 20, 30)), input_size
    )

    assert canvas.size == (input_size, input_size)
    assert scale == 1.0
    assert pad == (
        (input_size - content_size[0]) // 2,
        (input_size - content_size[1]) // 2,
    )
    assert calls == []


@pytest.mark.parametrize(
    "content_size,input_size",
    [((320, 180), 320), ((640, 360), 640)],
)
def test_preprocess_onnx_float_content_sized_skips_resize(
    monkeypatch: pytest.MonkeyPatch,
    content_size: tuple[int, int],
    input_size: int,
) -> None:
    # End-to-end through `_preprocess` (ONNX float letterbox): a view already
    # at the model content size must pad only — no second Image.resize.
    calls = _track_image_resize(monkeypatch)
    monkeypatch.setattr(inference_pool, "_runtime", "onnxruntime")
    cfg = {
        "inputSize": input_size,
        "_input_name": "images",
        "_input_shape": [1, 3, input_size, input_size],
        "preprocessMode": "letterbox",
    }
    input_dict, scale, pad = _preprocess(Image.new("RGB", content_size, (10, 20, 30)), cfg)
    tensor = input_dict["images"]

    assert scale == 1.0
    assert pad == (
        (input_size - content_size[0]) // 2,
        (input_size - content_size[1]) // 2,
    )
    assert calls == []
    assert tensor.shape == (1, 3, input_size, input_size)
    assert tensor.dtype == np.float32
    assert float(tensor.max()) <= 1.0


def test_ov_uint8_plain_resize_matches_model_dims() -> None:
    plan = {"inputW": 224, "inputH": 224, "size": 224, "letterbox": False, "normalization": "imagenet"}
    img = Image.new("RGB", (500, 300), (128, 128, 128))
    tensor, scale, pad = _preprocess_ov_uint8(img, plan)
    assert tensor.shape == (1, 224, 224, 3)
    assert tensor.dtype == np.uint8
    assert (scale, pad) == (1.0, (0, 0))


# ---------------------------------------------------------------------------
# Fix 1 — bench preprocess cache is HIT on the (tagged) batch path
# ---------------------------------------------------------------------------


def test_bench_tag_caches_preprocess_and_counts_hit(monkeypatch: pytest.MonkeyPatch) -> None:
    # A tagged frame (as the MSG_INFER_BATCH path now sets via `_bench_frame_id`)
    # is preprocessed ONCE (miss) then served from cache (hit) — the fix that
    # turns the sustained batch benchmark into a pure-inference measurement.
    monkeypatch.setattr(inference_pool, "_runtime", "onnxruntime")

    cfg = {"inputSize": 640, "_input_name": "images", "preprocessMode": "letterbox"}
    img = Image.new("RGB", (640, 640), (12, 34, 56))
    img._bench_frame_id = 4242

    first = _preprocess(img, cfg)
    assert inference_pool._bench_cache_misses == 1
    assert inference_pool._bench_cache_hits == 0

    # Five more inferences on the SAME pinned frame → all cache hits, and the
    # returned tuple is the SAME object (no re-preprocess).
    for _ in range(5):
        again = _preprocess(img, cfg)
        assert again is first
    assert inference_pool._bench_cache_hits == 5
    assert inference_pool._bench_cache_misses == 1


def test_untagged_frame_never_caches(monkeypatch: pytest.MonkeyPatch) -> None:
    # Live camera frames carry no tag → every call re-preprocesses (correct).
    monkeypatch.setattr(inference_pool, "_runtime", "onnxruntime")

    cfg = {"inputSize": 640, "_input_name": "images", "preprocessMode": "letterbox"}
    img = Image.new("RGB", (640, 640), (9, 9, 9))  # no _bench_frame_id
    _preprocess(img, cfg)
    _preprocess(img, cfg)
    assert inference_pool._bench_cache_hits == 0
    assert inference_pool._bench_cache_misses == 0
    assert len(inference_pool._bench_preprocess_cache) == 0


# ---------------------------------------------------------------------------
# uint8-input ONNX models (super-gradients / plus catalog YOLO-NAS exports bake the
# /255 preprocessing INTO the graph and declare a uint8 input tensor)
# ---------------------------------------------------------------------------


def test_onnx_uint8_input_is_fed_raw_uint8_nchw(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(inference_pool, "_runtime", "onnxruntime")
    cfg = {
        "inputSize": 320,
        "_input_name": "input",
        "_input_shape": [1, 3, 320, 320],
        "_input_dtype": "uint8",
        "preprocessMode": "letterbox",
    }
    img = Image.new("RGB", (640, 360), (200, 100, 50))
    input_dict, scale, pad = _preprocess(img, cfg)
    tensor = input_dict["input"]
    assert tensor.dtype == np.uint8
    assert tensor.shape == (1, 3, 320, 320)
    # Letterbox math still reported for the postprocess re-projection.
    assert scale == pytest.approx(0.5)
    assert pad[1] > 0  # vertical padding for a 16:9 frame in a square input


def test_onnx_uint8_input_respects_nhwc_declared_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(inference_pool, "_runtime", "onnxruntime")
    cfg = {
        "inputSize": 320,
        "_input_name": "input",
        "_input_shape": [1, 320, 320, 3],
        "_input_dtype": "uint8",
        "preprocessMode": "letterbox",
    }
    img = Image.new("RGB", (320, 320), (10, 20, 30))
    input_dict, _scale, _pad = _preprocess(img, cfg)
    tensor = input_dict["input"]
    assert tensor.dtype == np.uint8
    assert tensor.shape == (1, 320, 320, 3)


def test_onnx_float_input_unchanged_by_dtype_feature(monkeypatch: pytest.MonkeyPatch) -> None:
    # No `_input_dtype` → the historical float32 [0,1] path, byte-identical.
    monkeypatch.setattr(inference_pool, "_runtime", "onnxruntime")
    cfg = {
        "inputSize": 320,
        "_input_name": "images",
        "_input_shape": [1, 3, 320, 320],
        "preprocessMode": "letterbox",
    }
    img = Image.new("RGB", (320, 320), (255, 255, 255))
    input_dict, _scale, _pad = _preprocess(img, cfg)
    tensor = input_dict["images"]
    assert tensor.dtype == np.float32
    assert float(tensor.max()) <= 1.0
