"""Softmax classifier postprocessor.

Used for: animal-classifier, bird-classifier, vehicle-type-v1, and any custom
softmax classifier.

Input: raw logits tensor
Output: {"kind": "classifications", "classifications": [{"class", "score"}]}
"""
import numpy as np


def postprocess_softmax(
    predictions: dict,
    config: dict,
    orig_w: int,
    orig_h: int,
    scale: float,
    pad: tuple[int, int],
) -> dict:
    """Softmax + argmax + label lookup.

    When ``config['outputProbabilities']`` is set the model already applies
    softmax IN-GRAPH (e.g. the Google AIY Birds classifier) — its raw output is
    a probability distribution, so we consume it directly. Re-softmaxing an
    already-normalised probability vector is NOT a no-op: it collapses the
    distribution toward uniform (the top-1 score craters far below its true
    value), which silently defeats every downstream confidence gate.
    """
    labels = config.get("labels", [])

    # Get first output tensor
    raw = np.array(list(predictions.values())[0]).flatten().astype(np.float32)

    if config.get("outputProbabilities"):
        # Model output is already a softmax distribution — do NOT re-softmax.
        probs = raw
    else:
        # Stable softmax over raw logits.
        shifted = raw - np.max(raw)
        exps = np.exp(shifted)
        probs = exps / np.sum(exps)

    # Return top-K classifications — normalization (top-1 + alternates) happens in TypeScript
    top_k = min(5, len(probs))
    top_indices = np.argsort(probs)[::-1][:top_k]

    classifications = []
    for idx in top_indices:
        idx = int(idx)
        score = float(probs[idx])
        if score < 0.01:
            break
        label = labels[idx] if idx < len(labels) else str(idx)
        classifications.append({"class": label, "score": round(score, 4)})

    return {"kind": "classifications", "classifications": classifications}
