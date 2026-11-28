from __future__ import annotations

import io
import json
import zipfile

from camstack_train.dataset import coco_80
from camstack_train.replay import ANNOTATIONS_URL, prepare_replay, select_images

ANN = {
    "categories": [{"id": 1, "name": "person"}, {"id": 3, "name": "car"}, {"id": 44, "name": "bottle"}],
    "images": [
        {"id": 1, "file_name": "000000000003.jpg", "width": 100, "height": 50},
        {"id": 2, "file_name": "000000000001.jpg", "width": 100, "height": 50},
        {"id": 3, "file_name": "000000000002.jpg", "width": 100, "height": 50},
    ],
    "annotations": [
        {"image_id": 1, "category_id": 1, "bbox": [10, 5, 20, 10], "iscrowd": 0},
        {"image_id": 1, "category_id": 44, "bbox": [0, 0, 10, 10], "iscrowd": 0},
        {"image_id": 2, "category_id": 3, "bbox": [0, 0, 50, 25], "iscrowd": 0},
        {"image_id": 3, "category_id": 44, "bbox": [0, 0, 10, 10], "iscrowd": 0},
    ],
}


def fetcher(calls: list[str]):
    def fetch(url: str) -> bytes:
        calls.append(url)
        if url == ANNOTATIONS_URL:
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w") as z:
                z.writestr("annotations/instances_val2017.json", json.dumps(ANN))
            return buf.getvalue()
        return b"jpeg"

    return fetch


def test_pinned_slice_is_detector_images_in_name_order():
    assert [im["file_name"] for im in select_images(ANN, 10)] == ["000000000001.jpg", "000000000003.jpg"]
    assert len(select_images(ANN, 1)) == 1


def test_replay_writes_all_80_classes_and_caches(tmp_path):
    calls: list[str] = []
    n = prepare_replay(5, tmp_path / "cache", tmp_path / "yolo", coco_80(), fetcher(calls))
    assert n == 2
    label = (tmp_path / "yolo" / "labels" / "replay" / "000000000003.txt").read_text().splitlines()
    assert label[0] == "0 0.200000 0.200000 0.200000 0.200000"
    assert label[1].startswith(f"{coco_80().index('bottle')} ")  # the head is kept whole
    first = len(calls)
    prepare_replay(5, tmp_path / "cache", tmp_path / "yolo2", coco_80(), fetcher(calls))
    assert len(calls) == first  # served from the cache volume


def test_zero_count_fetches_nothing(tmp_path):
    calls: list[str] = []
    assert prepare_replay(0, tmp_path, tmp_path, coco_80(), fetcher(calls)) == 0 and calls == []
