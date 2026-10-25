from __future__ import annotations

import pytest

from camstack_train.errors import TrainerError
from camstack_train.export import artefact_names, calibration_frames, export_all, remove_export

from .fakes import FakeToolchain

CID = "custom-x"
ALL = ["onnx", "openvino-fp16", "openvino-int8", "coreml-fp16"]


def run(tmp_path, toolchain, exports=ALL, calib=True):
    pt = tmp_path / "best.pt"
    pt.write_bytes(b"w")
    images = tmp_path / "train"
    images.mkdir()
    for i in range(5):
        (images / f"{i:06d}.jpg").write_bytes(b"j")
    frames = calibration_frames(images, 3) if calib else []
    return export_all(exports, pt, CID, 640, frames, tmp_path / "stage", toolchain)


def test_every_format_lands_under_its_flat_name(tmp_path):
    tc = FakeToolchain()
    out = run(tmp_path, tc)
    assert out.produced == ALL and out.dropped == []
    stage = tmp_path / "stage"
    for name in artefact_names(CID).values():
        assert (stage / name).exists(), name
    assert (stage / f"{CID}-int8.bin").is_file()
    assert [p.name for p in tc.calib] == ["000000.jpg", "000001.jpg", "000002.jpg"]


def test_failing_coreml_drops_only_coreml(tmp_path):
    out = run(tmp_path, FakeToolchain(fail=("coreml",)))
    assert "coreml-fp16" not in out.produced
    assert out.dropped == [{"export": "coreml-fp16", "reason": "coreml exploded"}]
    assert "openvino-int8" in out.produced


def test_onnx_failure_fails_the_job(tmp_path):
    with pytest.raises(TrainerError) as err:
        run(tmp_path, FakeToolchain(fail=("onnx",)))
    assert err.value.code == "export-onnx" and err.value.exit_code == 70


def test_int8_without_calibration_frames_is_dropped(tmp_path):
    out = run(tmp_path, FakeToolchain(), calib=False)
    assert {"export": "openvino-int8", "reason": "no calibration frames in the train split"} in out.dropped


def test_only_requested_exports_run(tmp_path):
    tc = FakeToolchain()
    run(tmp_path, tc, exports=["onnx"])
    assert tc.calls == ["onnx"]


def test_remove_export_deletes_xml_and_bin(tmp_path):
    run(tmp_path, FakeToolchain())
    remove_export(tmp_path / "stage", CID, "openvino-int8")
    assert not (tmp_path / "stage" / f"{CID}-int8.xml").exists()
    assert not (tmp_path / "stage" / f"{CID}-int8.bin").exists()
    assert (tmp_path / "stage" / f"{CID}-fp16.bin").exists()
