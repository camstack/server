"""Tests for the softmax classifier postprocessor.

Covers the raw-logits (default) path and the `outputProbabilities` path used by
the Google AIY bird classifier, whose output is ALREADY a softmax distribution
and must NOT be re-softmaxed (re-softmaxing flattens the scores toward uniform
and silently defeats every downstream confidence gate).
"""
import math

import numpy as np

from softmax import postprocess_softmax


def _run(raw, config):
    predictions = {"logits": np.array(raw, dtype=np.float32)}
    return postprocess_softmax(predictions, config, 100, 100, 1.0, (0, 0))


def test_raw_logits_are_softmaxed():
    # Strongly-peaked logits → a near-1.0 top-1 probability after softmax.
    out = _run([10.0, 0.0, 0.0], {"labels": ["a", "b", "c"]})
    top = out["classifications"][0]
    assert top["class"] == "a"
    assert top["score"] > 0.99


def test_output_probabilities_are_consumed_verbatim():
    # Already a probability distribution — consumed directly, NOT re-softmaxed.
    probs = [0.9, 0.07, 0.03]
    out = _run(probs, {"labels": ["a", "b", "c"], "outputProbabilities": True})
    top = out["classifications"][0]
    assert top["class"] == "a"
    # The true 0.9 survives verbatim. Re-softmaxing this vector would collapse
    # the top-1 to ~0.49 — well below a 0.6 gate — which is the bug we prevent.
    assert math.isclose(top["score"], 0.9, abs_tol=1e-3)


def test_re_softmaxing_probabilities_would_crater_the_score():
    # Guard the rationale: prove the WRONG path (default softmax on an already-
    # softmaxed vector) really does destroy the top-1 confidence.
    probs = [0.9, 0.07, 0.03]
    wrong = _run(probs, {"labels": ["a", "b", "c"]})  # no outputProbabilities
    assert wrong["classifications"][0]["score"] < 0.6


def test_argmax_is_preserved_either_way():
    probs = [0.05, 0.8, 0.15]
    a = _run(probs, {"labels": ["a", "b", "c"], "outputProbabilities": True})
    b = _run(probs, {"labels": ["a", "b", "c"]})
    assert a["classifications"][0]["class"] == "b"
    assert b["classifications"][0]["class"] == "b"
