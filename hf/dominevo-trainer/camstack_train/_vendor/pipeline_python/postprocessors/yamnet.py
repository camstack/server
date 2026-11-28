"""YAMNet audio classification postprocessor.

Input: [numFrames, 521] score matrix
Output: {"kind": "classifications", "classifications": [{"class", "score"}]}
"""
import numpy as np


def postprocess_yamnet(
    predictions: dict,
    config: dict,
    orig_w: int,
    orig_h: int,
    scale: float,
    pad: tuple[int, int],
) -> dict:
    """Average scores across frames, return top classes above threshold."""
    labels = config.get("labels", [])
    min_score = config.get("confidence", 0.1)

    # Get output_0 (scores) — shape [numFrames, 521]
    raw = np.array(list(predictions.values())[0]).astype(np.float32)
    if raw.ndim == 1:
        raw = raw.reshape(1, -1)

    num_frames, num_classes = raw.shape

    # Average across frames
    avg_scores = np.mean(raw, axis=0)

    # Collect classes above threshold, sorted by score
    results = []
    for c in range(num_classes):
        score = float(avg_scores[c])
        if score >= min_score:
            label = labels[c] if c < len(labels) else str(c)
            results.append({"class": label, "score": round(score, 4)})

    results.sort(key=lambda x: x["score"], reverse=True)

    return {"kind": "classifications", "classifications": results}
