"""COCO as a holdout: file-name order after the calibration images, macro
classes, crowd boxes as don't care, AP50-95 below AP50."""
import json

from camstack_eval.dataset import load_coco, load_pseudo_gt
from camstack_eval.metrics import Detection, average_precision, average_precision_coco


def write_coco(tmp_path):
    data = {
        "categories": [{"id": 1, "name": "person"}, {"id": 3, "name": "car"}, {"id": 44, "name": "bottle"}],
        "images": [
            {"id": 9, "file_name": "c.jpg", "width": 100, "height": 50},
            {"id": 7, "file_name": "a.jpg", "width": 100, "height": 50},
            {"id": 8, "file_name": "b.jpg", "width": 100, "height": 50},
        ],
        "annotations": [
            {"image_id": 8, "category_id": 1, "bbox": [10, 5, 20, 10], "iscrowd": 0},
            {"image_id": 8, "category_id": 1, "bbox": [50, 5, 40, 40], "iscrowd": 1},
            {"image_id": 8, "category_id": 44, "bbox": [0, 0, 5, 5], "iscrowd": 0},
            {"image_id": 9, "category_id": 3, "bbox": [0, 0, 50, 25], "iscrowd": 0},
        ],
    }
    path = tmp_path / "instances.json"
    path.write_text(json.dumps(data))
    return path


def test_the_calibration_images_are_skipped_in_file_name_order(tmp_path):
    frames = load_coco(str(write_coco(tmp_path)), str(tmp_path), skip=1)
    assert [f.path for f in frames] == ["b.jpg", "c.jpg"]
    assert len(load_coco(str(write_coco(tmp_path)), str(tmp_path), skip=1, limit=1)) == 1


def test_boxes_are_macro_normalised_and_crowds_are_dont_care(tmp_path):
    b, c = load_coco(str(write_coco(tmp_path)), str(tmp_path), skip=1)
    assert [(g.cls, g.bbox) for g in b.truth.boxes] == [("person", (0.1, 0.1, 0.2, 0.2))]
    assert [g.cls for g in b.truth.dont_care] == ["person"]
    assert [g.cls for g in c.truth.boxes] == ["vehicle"]


def test_ap5095_rewards_a_tight_box_more_than_a_loose_one(tmp_path):
    (b,) = load_coco(str(write_coco(tmp_path)), str(tmp_path), skip=1, limit=1)
    tight = [(b.truth, [Detection("person", 0.9, (0.1, 0.1, 0.2, 0.2))])]
    loose = [(b.truth, [Detection("person", 0.9, (0.1, 0.1, 0.24, 0.2))])]
    assert average_precision("person", tight) == average_precision("person", loose) == 1.0
    assert average_precision_coco("person", tight) == 1.0
    assert average_precision_coco("person", loose) < 1.0


def test_a_pseudo_gt_file_loads_positives_and_dont_care(tmp_path):
    (tmp_path / "pgt.json").write_text(json.dumps({
        "schema": "camstack.pseudo-gt/v1",
        "frames": [{"file": "f.jpg", "deviceId": 101, "night": True,
                    "boxes": [{"cls": "person", "bbox": [0.1, 0.1, 0.2, 0.3]}],
                    "dontCare": [{"cls": "animal", "bbox": [0.5, 0.5, 0.1, 0.1]}]}],
    }))
    (f,) = load_pseudo_gt(str(tmp_path / "pgt.json"))
    assert f.truth.camera == 101 and f.truth.night is True
    assert [g.cls for g in f.truth.boxes] == ["person"] and [g.cls for g in f.truth.dont_care] == ["animal"]
