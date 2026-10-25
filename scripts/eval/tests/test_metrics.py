"""Matching, P/R at a floor, AP50 and the per-bucket recall."""
import pytest

from camstack_eval.metrics import (
    Detection,
    FrameTruth,
    GroundTruthBox,
    average_precision,
    evaluate_class,
)


def box(x, y, w=0.1, h=0.2):
    return (x, y, w, h)


def frame(fid, gts, dets, camera=1, night=False, dont_care=()):
    return FrameTruth(
        frame_id=fid,
        camera=camera,
        night=night,
        boxes=tuple(GroundTruthBox("person", b) for b in gts),
        dont_care=tuple(GroundTruthBox("person", b) for b in dont_care),
    ), tuple(Detection("person", s, b) for s, b in dets)


def test_a_detection_matches_once_and_a_duplicate_is_a_false_positive():
    f, d = frame("f1", [box(0.1, 0.1)], [(0.9, box(0.1, 0.1)), (0.8, box(0.105, 0.1))])
    result = evaluate_class("person", [(f, d)], floor=0.5)
    assert result.tp == 1
    assert result.fp == 1
    assert result.fn == 0


def test_a_floor_drops_low_scores_and_they_become_misses():
    f, d = frame("f1", [box(0.1, 0.1), box(0.6, 0.6)], [(0.9, box(0.1, 0.1)), (0.3, box(0.6, 0.6))])
    result = evaluate_class("person", [(f, d)], floor=0.5)
    assert (result.tp, result.fp, result.fn) == (1, 0, 1)
    assert result.precision == 1.0
    assert result.recall == 0.5


def test_a_detection_on_a_dont_care_box_is_neither_true_nor_false():
    f, d = frame("f1", [], [(0.9, box(0.4, 0.4))], dont_care=[box(0.4, 0.4)])
    result = evaluate_class("person", [(f, d)], floor=0.5)
    assert (result.tp, result.fp, result.fn) == (0, 0, 0)


def test_recall_is_split_by_camera_night_and_small_subjects():
    small = (0.5, 0.5, 0.02, 0.05)  # 5% of the frame height: small
    a = frame("a", [box(0.1, 0.1), small], [(0.9, box(0.1, 0.1))], camera=101, night=True)
    b = frame("b", [box(0.1, 0.1)], [(0.9, box(0.1, 0.1))], camera=102, night=False)
    result = evaluate_class("person", [a, b], floor=0.5)
    assert result.recall_by_camera == {101: pytest.approx(0.5), 102: pytest.approx(1.0)}
    assert result.recall_by_light == {"night": pytest.approx(0.5), "day": pytest.approx(1.0)}
    assert result.small_found == 0
    assert result.small_total == 1


def test_ap50_is_one_for_a_perfect_ranking_and_lower_when_a_false_positive_outranks():
    perfect = frame("p", [box(0.1, 0.1), box(0.5, 0.5)], [(0.9, box(0.1, 0.1)), (0.8, box(0.5, 0.5))])
    assert average_precision("person", [perfect]) == pytest.approx(1.0)
    noisy = frame(
        "n",
        [box(0.1, 0.1), box(0.5, 0.5)],
        [(0.95, box(0.8, 0.8)), (0.9, box(0.1, 0.1)), (0.8, box(0.5, 0.5))],
    )
    assert average_precision("person", [noisy]) < 1.0


def test_an_empty_class_has_no_precision_or_recall_rather_than_zero():
    f, d = frame("f1", [], [])
    result = evaluate_class("person", [(f, d)], floor=0.5)
    assert result.precision is None
    assert result.recall is None
