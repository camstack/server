"""CLIP image embedding postprocessor.

Input: raw embedding tensor from a CLIP vision encoder (e.g. MobileCLIP S0/S1/S2)
Output: {"kind": "embedding", "embedding": [...], "embeddingNorm": [...]}

MobileCLIP uses resize 256×256 + rescale /255 only (no ImageNet mean/std).
The existing inference_pool resize_image path already produces this layout —
preprocessMode:'resize' + inputNormalization:'none' is the correct config.
"""
import numpy as np


def postprocess_clip(
    predictions: dict,
    config: dict,
    orig_w: int,
    orig_h: int,
    scale: float,
    pad: tuple[int, int],
) -> dict:
    """L2-normalize the CLIP embedding vector."""
    # Get the first output tensor (vision encoder emits a single embedding)
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
