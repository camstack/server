from __future__ import annotations

import io
import tarfile

import pytest

from camstack_train.dataset import (
    coco_80, coco_index_for, extract_archive, frames_from_manifest, verify_archive, write_layout,
)
from camstack_train.errors import EXIT_DATASET, TrainerError

from .conftest import frame, subject


def test_coco_mapping_is_honest():
    names = coco_80()
    assert coco_index_for("person", None, names) == 0
    assert coco_index_for("vehicle", "Car", names) == names.index("car")
    assert coco_index_for("animal", "dog", names) == names.index("dog")
    assert coco_index_for("vehicle", None, names) is None  # no class to give it
    assert coco_index_for("animal", "car", names) is None  # label of another macro


def test_boxes_become_yolo_lines_and_model_errors_are_not_positives(make_export, tmp_path):
    frames = [
        frame("f1", 101, 0, [subject("person"), subject("vehicle", "car", x=0.5), subject("person", kind="model_error", x=0.6)]),
        frame("f2", 101, 0, []),  # complete, empty: a hard negative
        frame("f3", 102, 0, [subject("animal")]),  # animal without a COCO label: unmappable
        frame("f4", 102, 0, [subject("package")], complete=False),  # incomplete, no detector subject…
        frame("f5", 102, 0, [], complete=False),  # incomplete, nothing: never trains
    ]
    path, digest = make_export(frames)
    verify_archive(path, digest)
    manifest = extract_archive(path, tmp_path / "x")
    parsed = {f.frame_id: f for f in frames_from_manifest(manifest)}
    f1 = parsed["f1"]
    assert [b.cls_index for b in f1.labels] == [0, coco_80().index("car")]
    assert f1.model_errors == 1 and f1.trainable
    assert parsed["f2"].trainable and parsed["f2"].labels == ()
    assert not parsed["f3"].trainable and parsed["f3"].unmappable == 1
    assert not parsed["f4"].trainable  # a package box is not a root-detector subject
    assert not parsed["f5"].trainable
    box = f1.labels[0]
    assert (round(box.cx, 3), round(box.cy, 3), round(box.w, 3), round(box.h, 3)) == (0.25, 0.4, 0.3, 0.4)

    counts = write_layout({"train": [f for f in parsed.values() if f.trainable]}, tmp_path / "x", tmp_path / "yolo")
    assert counts.frames["train"] == 2
    label_files = sorted((tmp_path / "yolo" / "labels" / "train").glob("*.txt"))
    assert [p.name for p in label_files] == ["000001.txt", "000002.txt"]  # neutral names
    assert label_files[0].read_text().splitlines()[0].startswith("0 0.250000 0.400000")
    assert label_files[1].read_text() == ""


def test_incomplete_frame_with_a_box_trains(make_export, tmp_path):
    path, _ = make_export([frame("f1", 1, 0, [subject("person")], complete=False)])
    f = frames_from_manifest(extract_archive(path, tmp_path / "x"))[0]
    assert f.trainable and not f.complete


def test_out_of_frame_box_is_clamped_or_dropped():
    names = coco_80()
    from camstack_train.dataset import frame_from_entry

    entry = frame("f", 1, 0, [
        {**subject("person"), "bbox": {"x": -0.2, "y": 0.0, "w": 0.4, "h": 0.5}},
        {**subject("person"), "bbox": {"x": 1.2, "y": 0.0, "w": 0.4, "h": 0.5}},
    ])
    f = frame_from_entry(entry, names)
    assert len(f.labels) == 1 and round(f.labels[0].w, 3) == 0.2


def test_sha256_mismatch_is_a_dataset_error(make_export):
    path, _ = make_export([frame("f1", 1, 0, [])])
    with pytest.raises(TrainerError) as err:
        verify_archive(path, "1" * 64)
    assert err.value.exit_code == EXIT_DATASET and err.value.code == "dataset-sha256"


def test_unknown_export_schema_refused(make_export, tmp_path):
    path, _ = make_export([frame("f1", 1, 0, [])], schema="camstack.retrain-export/v9")
    with pytest.raises(TrainerError) as err:
        extract_archive(path, tmp_path / "x")
    assert err.value.code == "dataset-schema"


def test_extraction_skips_unsafe_members(tmp_path, make_export):
    path, _ = make_export([frame("f1", 1, 0, [])])
    with tarfile.open(path, "a") as tar:
        info = tarfile.TarInfo("../evil.jpg")
        info.size = 1
        tar.addfile(info, io.BytesIO(b"x"))
    extract_archive(path, tmp_path / "x")
    assert not (tmp_path / "evil.jpg").exists()
