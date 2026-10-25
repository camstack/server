"""Pseudo ground truth from two teachers (the 2026-10-07 method): a box counts
when both teachers agree on it, or one is very confident; a box only one
teacher half-believes is "don't care"."""
from camstack_eval.metrics import Detection
from camstack_eval.pseudo_gt import PseudoGtPolicy, pseudo_ground_truth

POLICY = PseudoGtPolicy(agree_score=0.3, solo_score=0.8, care_score=0.3)
BOX = (0.1, 0.1, 0.2, 0.4)
OTHER = (0.6, 0.6, 0.2, 0.3)


def test_agreement_makes_a_positive():
    boxes, dont_care = pseudo_ground_truth(
        [Detection("person", 0.5, BOX)], [Detection("person", 0.4, BOX)], POLICY
    )
    assert [b.cls for b in boxes] == ["person"]
    assert dont_care == []


def test_one_very_confident_teacher_is_enough():
    boxes, _ = pseudo_ground_truth([Detection("person", 0.9, BOX)], [], POLICY)
    assert len(boxes) == 1


def test_a_lone_middling_box_is_dont_care():
    boxes, dont_care = pseudo_ground_truth([Detection("person", 0.5, OTHER)], [], POLICY)
    assert boxes == []
    assert [b.bbox for b in dont_care] == [OTHER]


def test_classes_must_agree_too():
    boxes, dont_care = pseudo_ground_truth(
        [Detection("person", 0.5, BOX)], [Detection("animal", 0.5, BOX)], POLICY
    )
    assert boxes == []
    assert len(dont_care) == 2
