"""The vectorised bootstrap AP equals AP over the concatenated drawn frames."""
import random

import numpy as np

from camstack_eval.bootstrap import _flatten, draw_weights, paired_delta, weighted_ap
from camstack_eval.metrics import FrameMatches, ap_of_sample


def random_matches(seed, frames=40):
    rng = random.Random(seed)
    out = []
    for _ in range(frames):
        n = rng.randint(0, 5)
        scores = tuple(round(rng.random(), 3) for _ in range(n))
        out.append(FrameMatches(scores, tuple(rng.random() < 0.6 for _ in range(n)), rng.randint(0, 4)))
    return out


def test_a_resample_is_the_ap_of_the_drawn_frames():
    matches = random_matches(1)
    weights = draw_weights(len(matches), rounds=25, seed=3)
    got = weighted_ap(_flatten(matches), weights)
    for r in range(weights.shape[0]):
        sample = [i for i, c in enumerate(weights[r]) for _ in range(int(c))]
        assert abs(got[r] - ap_of_sample(matches, sample)) < 1e-9


def test_row_zero_is_the_full_set():
    matches = random_matches(2)
    weights = draw_weights(len(matches), rounds=3)
    assert abs(weighted_ap(_flatten(matches), weights)[0] - ap_of_sample(matches, range(len(matches)))) < 1e-12


def test_a_model_against_itself_has_a_zero_interval():
    values = np.array([0.5, 0.4, 0.6, 0.55])
    delta = paired_delta(values, values)
    assert (delta.value, delta.low, delta.high) == (0.0, 0.0, 0.0)
    assert not delta.significant_drop and not delta.significant_gain


def test_a_consistent_drop_is_significant():
    delta = paired_delta(np.array([0.5, 0.5, 0.5]), np.array([0.4, 0.45, 0.41]))
    assert delta.significant_drop
