"""The D739 floor rule: the lowest floor whose false positives do not exceed
the baseline's at the baseline's shipped floor, with a support threshold and a
clamp around the baseline floor."""
from camstack_eval.floors import FloorPolicy, ScoredDetection, propose_floor


def scored(*pairs):
    return [ScoredDetection(score=s, true_positive=tp) for s, tp in pairs]


POLICY = FloorPolicy(min_support=2, clamp=0.15, grid_step=0.05, minimum=0.25)


def test_takes_the_lowest_floor_that_keeps_the_false_positive_budget():
    # Baseline at 0.60: one false positive (0.70).
    baseline = scored((0.9, True), (0.7, False), (0.5, False))
    # Candidate: FPs at 0.62 and 0.40. Budget 1 ⇒ the floor may drop to 0.45.
    candidate = scored((0.95, True), (0.8, True), (0.62, False), (0.40, False))
    floor = propose_floor(baseline, 0.6, candidate, positives=5, policy=POLICY)
    assert floor.value == 0.45
    assert floor.reason == "fp-budget"
    assert floor.fp_budget == 1


def test_a_class_with_too_few_positives_inherits_the_baseline_floor():
    floor = propose_floor(scored((0.9, True)), 0.6, scored((0.3, True)), positives=1, policy=POLICY)
    assert floor.value == 0.6
    assert floor.reason == "low-support"


def test_the_floor_is_clamped_around_the_baseline():
    baseline = scored((0.9, False))  # budget 1
    candidate = scored((0.95, False), (0.99, True))  # one FP even at 0.95 ⇒ any floor fits
    floor = propose_floor(baseline, 0.65, candidate, positives=10, policy=POLICY)
    assert floor.value == 0.5  # 0.25 clamped up to 0.65 - 0.15
    assert floor.reason == "clamped"


def test_a_candidate_that_cannot_meet_the_budget_is_clamped_high():
    baseline = scored((0.9, True))  # budget 0
    candidate = scored((0.99, False))
    floor = propose_floor(baseline, 0.5, candidate, positives=10, policy=POLICY)
    assert floor.value == 0.65
    assert floor.reason == "clamped"
