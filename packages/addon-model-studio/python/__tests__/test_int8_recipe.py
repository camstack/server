"""The INT8 recipe (D818, docs/benchmarks/2026-10-09-int8-recipe.md). A DFL
head (YOLOv9): the Detect head's OWN ops — the DFL and the box decode (anchor
± distance, × stride, the class sigmoid, the concat/split around them) — stay
in float, its conv branches stay INT8. An end-to-end head (YOLO26, its
`one2one_*` branches): the whole head stays float, as NNCF's own YOLO26
recipe keeps it. Quantising the decode put pixel coordinates on a
256-level grid: yolov9m-640 lost 0.07 mAP50-95 on COCO, ~0.11 on hub frames.

NNCF matches an ignored-scope pattern with ``re.match`` — a PREFIX match — so
a pattern for the head's own ops must be anchored, or it swallows the convs."""
import re

from convert_lib import detect_head_prefix, int8_ignored_patterns


def _matches(patterns, name):
    return any(re.match(p, name) for p in patterns)


YOLOV9 = [
    ("/model.21/cv4/act/Sigmoid", "Sigmoid"),
    ("/model.22/cv2.0/cv2.0.0/act/Sigmoid", "Sigmoid"),
    ("/model.22/cv2.0/cv2.0.2/Conv", "Convolution"),
    ("/model.22/dfl/Softmax", "SoftMax"),
    ("/model.22/Sigmoid", "Sigmoid"),
    ("/model.22/Concat_3", "Concat"),
]


def test_the_head_is_the_module_of_the_last_sigmoid():
    assert detect_head_prefix(YOLOV9) == "/model.22"


def test_yolo26_end2end_head():
    ops = [("/model.23/one2one_cv2.2/one2one_cv2.2.2/Conv", "Convolution"),
           ("/model.23/one2one_cv3.2/one2one_cv3.2.1/act/Sigmoid", "Sigmoid"),
           ("/model.23/Sigmoid", "Sigmoid"), ("/model.23/TopK", "TopK")]
    assert detect_head_prefix(ops) == "/model.23"


def test_a_model_without_an_ultralytics_head_gets_none():
    assert detect_head_prefix([("conv1", "Convolution"), ("sigmoid_out", "Sigmoid")]) is None
    assert detect_head_prefix([]) is None


def test_a_torch_sequential_named_model_is_not_a_detect_head():
    # `self.model = nn.Sequential(...)` names ops /model.N/ too — without the
    # Detect head's box branch (cv2.* / one2one_cv2.*) it is not one.
    ops = [("/model.3/conv/Conv", "Convolution"), ("/model.4/act/Sigmoid", "Sigmoid"),
           ("/model.5/Sigmoid", "Sigmoid")]
    assert detect_head_prefix(ops) is None


def test_the_patterns_keep_the_decode_and_dfl_float_and_the_convs_int8():
    p = int8_ignored_patterns("/model.22", end_to_end=False)
    for own in ("/model.22/Sub_1", "/model.22/Add_1", "/model.22/Div_1", "/model.22/Mul_2",
                "/model.22/Concat_3", "/model.22/Sigmoid", "/model.22/dfl/Softmax", "/model.22/dfl/conv/Conv"):
        assert _matches(p, own), own
    for conv in ("/model.22/cv2.0/cv2.0.0/conv/Conv", "/model.22/cv3.2/cv3.2.2/Conv"):
        assert not _matches(p, conv), conv
    assert not _matches(p, "/model.21/Concat"), "the neck is not the head"
    assert not _matches(p, "/model.220/Sub"), "the prefix is a module boundary"


def test_an_end_to_end_head_stays_float_whole():
    p = int8_ignored_patterns("/model.23", end_to_end=True)
    for name in ("/model.23/one2one_cv2.0/one2one_cv2.0.2/Conv", "/model.23/one2one_cv3.2/one2one_cv3.2.2/Conv",
                 "/model.23/Sub", "/model.23/TopK", "/model.23/Sigmoid"):
        assert _matches(p, name), name
    assert not _matches(p, "/model.22/cv2/conv/Conv"), "the neck stays INT8"
    assert not _matches(p, "/model.230/Sub")


def test_end_to_end_is_told_by_the_one2one_branch():
    from convert_lib import is_end_to_end_head
    assert is_end_to_end_head(["/model.23/one2one_cv2.0/one2one_cv2.0.0/conv/Conv", "/model.23/TopK"], "/model.23")
    assert not is_end_to_end_head([n for n, _ in YOLOV9], "/model.22")
