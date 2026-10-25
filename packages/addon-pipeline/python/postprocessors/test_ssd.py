"""Pins the SSD decoder on REAL SSDLite MobileDet output tensors.

The CamStack catalog keeps only `ssd-mobilenet-v2-coco-edgetpu`; plus catalog still
imports MobileDet. Both graphs end in `TFLite_Detection_PostProcess`, and this
fixture (MobileDet outputs on two COCO val2017 frames) pins what the shared
`postprocessor: 'ssd'` decoder must read correctly:

- the output ORDER (boxes, classes, scores, count on positional keys "0".."3");
- the class-index OFFSET (91 score columns, background dropped by the op, so
  the emitted index is 0-based and 0 is person);
- the COUNT clamp (MobileDet emits N=100 rows, not 20 like SSD MobileNet V2);
- the letterbox inversion, against boxes an unrelated detector (DETR) drew on
  the same COCO frame;
- the score CEILING of this quantised graph (about 0.771), which decides which
  confidence thresholds can ever pass.

The fixture (`testdata/ssdlite_mobiledet_outputs.json`) holds the model's raw
outputs; its `_provenance` says how they were made.

`unittest.TestCase` with no numpy: `scripts/test-python-pool.sh` runs these on
CI's bare interpreter, where numpy is absent, and `ssd.py` decodes plain lists
for exactly that reason. The one case that needs numpy (ndarray inputs decode
the same as lists) is skipped, by name, without it.
"""
import json
import os
import unittest

try:  # real numpy when the sandbox has it
    import numpy as _numpy_probe
except ImportError:
    _numpy_probe = None

# `ndarray` is real-numpy-only: a stub another test module installed would import.
_HAS_REAL_NUMPY = _numpy_probe is not None and hasattr(_numpy_probe, "ndarray")

from ssd import COCO_90, label_for_class, postprocess_ssd  # noqa: E402

_FIXTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "testdata",
                        "ssdlite_mobiledet_outputs.json")
with open(_FIXTURE, encoding="utf-8") as _fh:
    _FRAMES = json.load(_fh)["frames"]

CATS = _FRAMES["coco_val2017_000000039769_two_cats"]
STREET = _FRAMES["coco_val2017_000000252219_street"]

# The catalog entry's input side; the pool sets `inputSize` from the graph.
INPUT_SIZE = 320
# The score column of this graph is LOGISTIC over a uint8 logit quantised at
# scale 0.046695, zero point 229, so the largest logit it can carry is
# (255 - 229) * 0.046695 = 1.2141 and sigmoid(1.2141) = 0.77102.
SCORE_CEILING = 0.77102


def _decode(frame: dict, confidence: float = 0.5, outputs: "dict | None" = None) -> list:
    width, height = frame["orig"]
    result = postprocess_ssd(
        outputs if outputs is not None else frame["outputs"],
        {"confidence": confidence, "inputSize": INPUT_SIZE},
        width, height, frame["scale"], tuple(frame["pad"]),
    )
    return result["detections"]


def _iou(a: list, b: list) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


class FixtureShapeTest(unittest.TestCase):
    """The fixture is what the MobileDet graph emits: [1,100,4] [1,100] [1,100] [1]."""

    def test_output_shapes(self) -> None:
        for frame in (CATS, STREET):
            out = frame["outputs"]
            self.assertEqual(len(out["0"]), 1)
            self.assertEqual(len(out["0"][0]), 100)
            self.assertTrue(all(len(row) == 4 for row in out["0"][0]))
            self.assertEqual(len(out["1"][0]), 100)
            self.assertEqual(len(out["2"][0]), 100)
            self.assertEqual(out["3"], [100.0])

    def test_scores_are_sorted_descending(self) -> None:
        # TFLite_Detection_PostProcess ranks by score; a reordered export would not.
        scores = STREET["outputs"]["2"][0]
        self.assertEqual(scores, sorted(scores, reverse=True))


class OutputOrderTest(unittest.TestCase):
    """Positional "1" is CLASSES and "2" is SCORES. Swapped, the labels are nonsense."""

    def test_cats_decode_as_cats(self) -> None:
        labels = [d["class"] for d in _decode(CATS)]
        self.assertEqual(labels.count("cat"), 2, labels)

    def test_street_decodes_three_people(self) -> None:
        people = [d for d in _decode(STREET) if d["class"] == "person"]
        self.assertEqual(len(people), 3)
        # Left, middle and right of the frame.
        centres = sorted((d["bbox"][0] + d["bbox"][2]) / 2 for d in people)
        self.assertLess(centres[0], 200)
        self.assertTrue(250 < centres[1] < 450, centres)
        self.assertGreater(centres[2], 500)

    def test_every_score_is_a_probability(self) -> None:
        for frame in (CATS, STREET):
            self.assertTrue(all(0.0 <= s <= 1.0 for s in frame["outputs"]["2"][0]))


class ClassOffsetTest(unittest.TestCase):
    """Emitted class index = COCO-90 line number of `coco_labels.txt`, 0 = person."""

    def test_raw_indices_behind_the_labels(self) -> None:
        classes = STREET["outputs"]["1"][0]
        scores = STREET["outputs"]["2"][0]
        top = [int(c) for c, s in zip(classes, scores) if s >= 0.7]
        self.assertEqual(set(top), {0})  # the three people
        cat_classes = {int(c) for c, s in zip(CATS["outputs"]["1"][0], CATS["outputs"]["2"][0]) if s >= 0.7}
        self.assertEqual(cat_classes, {16})

    def test_label_map(self) -> None:
        self.assertEqual(len(COCO_90), 90)
        self.assertEqual(label_for_class(0), "person")
        self.assertEqual(label_for_class(2), "car")
        self.assertEqual(label_for_class(16), "cat")
        self.assertEqual(label_for_class(17), "dog")
        self.assertEqual(label_for_class(89), "toothbrush")
        self.assertEqual(label_for_class(11), "n/a")
        self.assertEqual(label_for_class(90), "90")

    def test_gap_classes_are_dropped(self) -> None:
        out = {k: v for k, v in STREET["outputs"].items()}
        out["1"] = [[11.0] + list(STREET["outputs"]["1"][0][1:])]  # "n/a" on the top row
        labels = [d["class"] for d in _decode(STREET, outputs=out)]
        self.assertNotIn("n/a", labels)
        self.assertEqual(labels.count("person"), 2)


class CountClampTest(unittest.TestCase):
    """All 100 rows are read when count says 100, and only `count` rows otherwise."""

    def test_low_threshold_reads_past_row_20(self) -> None:
        # SSD MobileNet V2 stops at 20 rows; MobileDet's detections go on to row 100.
        dets = _decode(STREET, confidence=0.01)
        self.assertGreater(len(dets), 20)

    def test_count_limits_the_rows(self) -> None:
        out = dict(STREET["outputs"])
        out["3"] = [2.0]
        self.assertEqual(len(_decode(STREET, confidence=0.01, outputs=out)), 2)


class LetterboxGeometryTest(unittest.TestCase):
    """Boxes land in ORIGINAL-frame pixels, where another detector puts the same cats."""

    # DETR ResNet-50 on this exact COCO frame (the facebook/detr-resnet-50 model
    # card example): an independent reference for where the two cats are.
    DETR_CATS = ([13.24, 52.05, 314.02, 470.93], [345.4, 23.85, 640.37, 368.72])

    def test_cats_match_the_reference_boxes(self) -> None:
        cats = [d["bbox"] for d in _decode(CATS) if d["class"] == "cat"]
        for ref in self.DETR_CATS:
            best = max(_iou(ref, box) for box in cats)
            self.assertGreater(best, 0.85, (ref, cats))

    def test_boxes_stay_inside_the_frame(self) -> None:
        for frame in (CATS, STREET):
            width, height = frame["orig"]
            for d in _decode(frame, confidence=0.01):
                x1, y1, x2, y2 = d["bbox"]
                self.assertTrue(0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height, d)


class ScoreCeilingTest(unittest.TestCase):
    """This graph cannot score above ~0.771, so a stricter threshold returns nothing."""

    def test_no_score_exceeds_the_ceiling(self) -> None:
        for frame in (CATS, STREET):
            self.assertLessEqual(max(frame["outputs"]["2"][0]), SCORE_CEILING)

    def test_the_ceiling_is_reached(self) -> None:
        self.assertAlmostEqual(max(CATS["outputs"]["2"][0]), 0.76953125)

    def test_threshold_above_the_ceiling_finds_nothing(self) -> None:
        self.assertEqual(_decode(STREET, confidence=0.78), [])
        self.assertEqual(len([d for d in _decode(STREET, confidence=0.65) if d["class"] == "person"]), 3)


class ConfigLabelsTest(unittest.TestCase):
    """Custom label maps from the pool; absent labels keep COCO-90 in Python."""

    _SYNTH = {
        "0": [[[0.1, 0.1, 0.5, 0.5]]],
        "1": [[3.0]],
        "2": [[0.9]],
        "3": [1.0],
    }

    def test_custom_labels_name_classes(self) -> None:
        # Index 3 is dog and index 29 is car — the Plus map the COCO-90 table misnames.
        labels = ["person", "bicycle", "x", "dog"] + ["pad"] * 25 + ["car"]
        self.assertEqual(labels[3], "dog")
        self.assertEqual(labels[29], "car")
        dog = postprocess_ssd(
            self._SYNTH,
            {"confidence": 0.4, "inputSize": 100, "labels": labels},
            100,
            100,
            1.0,
            (0, 0),
        )["detections"]
        self.assertEqual(len(dog), 1)
        self.assertEqual(dog[0]["class"], "dog")
        car_out = dict(self._SYNTH)
        car_out["1"] = [[29.0]]
        car = postprocess_ssd(
            car_out,
            {"confidence": 0.4, "inputSize": 100, "labels": labels},
            100,
            100,
            1.0,
            (0, 0),
        )["detections"]
        self.assertEqual(len(car), 1)
        self.assertEqual(car[0]["class"], "car")

    def test_no_labels_key_uses_coco90_and_skips_na(self) -> None:
        out = dict(self._SYNTH)
        out["1"] = [[29.0]]
        dets = postprocess_ssd(
            out,
            {"confidence": 0.4, "inputSize": 100},
            100,
            100,
            1.0,
            (0, 0),
        )["detections"]
        self.assertEqual(dets, [])
        out2 = dict(self._SYNTH)
        out2["1"] = [[3.0]]
        dets2 = postprocess_ssd(
            out2,
            {"confidence": 0.4, "inputSize": 100},
            100,
            100,
            1.0,
            (0, 0),
        )["detections"]
        self.assertEqual(len(dets2), 1)
        self.assertEqual(dets2[0]["class"], "motorcycle")


class NumpyInputTest(unittest.TestCase):
    """The pool hands ndarrays; they must decode exactly like the lists above."""

    @unittest.skipUnless(_HAS_REAL_NUMPY, "needs real numpy (not on CI's bare interpreter)")
    def test_ndarrays_decode_like_lists(self) -> None:
        np = _numpy_probe
        for frame in (CATS, STREET):
            arrays = {k: np.asarray(v, dtype=np.float32) for k, v in frame["outputs"].items()}
            self.assertEqual(_decode(frame, confidence=0.3, outputs=arrays), _decode(frame, confidence=0.3))


if __name__ == "__main__":
    unittest.main()
