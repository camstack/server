"""ArcFace face embedding postprocessor.

Input: raw embedding tensor from ArcFace model
Output: {"kind": "embedding", "embedding": [...], "embeddingNorm": [...]}
"""
import numpy as np


def postprocess_arcface(
    predictions: dict,
    config: dict,
    orig_w: int,
    orig_h: int,
    scale: float,
    pad: tuple[int, int],
) -> dict:
    """L2-normalize the embedding vector."""
    # Get the first output tensor (usually named "fc1" or similar)
    raw = np.array(list(predictions.values())[0]).flatten().astype(np.float32)

    norm = np.linalg.norm(raw)
    if norm == 0:
        normalized = np.zeros_like(raw)
    else:
        normalized = raw / norm

    return {
        "kind": "embedding",
        "embedding": raw.tolist(),
        "embeddingNorm": normalized.tolist(),
    }
