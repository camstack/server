"""Tests for the CLIP embedding postprocessor."""
import numpy as np
import pytest
from postprocessors.clip import postprocess_clip


def test_clip_output_kind() -> None:
    vec = np.ones(512, dtype=np.float32)
    predictions = {"output": vec.reshape(1, 512)}
    result = postprocess_clip(predictions, {}, 640, 480, 1.0, (0, 0))
    assert result["kind"] == "embedding"


def test_clip_embedding_length() -> None:
    vec = np.ones(512, dtype=np.float32)
    predictions = {"output": vec.reshape(1, 512)}
    result = postprocess_clip(predictions, {}, 640, 480, 1.0, (0, 0))
    assert len(result["embedding"]) == 512


def test_clip_embedding_norm_is_unit() -> None:
    vec = np.array([3.0, 4.0] + [0.0] * 510, dtype=np.float32)
    predictions = {"output": vec.reshape(1, 512)}
    result = postprocess_clip(predictions, {}, 640, 480, 1.0, (0, 0))
    norm = float(np.linalg.norm(result["embeddingNorm"]))
    assert abs(norm - 1.0) < 1e-5


def test_clip_zero_vector_does_not_divide_by_zero() -> None:
    vec = np.zeros(512, dtype=np.float32)
    predictions = {"output": vec.reshape(1, 512)}
    result = postprocess_clip(predictions, {}, 640, 480, 1.0, (0, 0))
    assert all(v == 0.0 for v in result["embeddingNorm"])
