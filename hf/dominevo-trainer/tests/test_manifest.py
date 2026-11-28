from __future__ import annotations

import hashlib
import tarfile

from camstack_train.manifest import MLPACKAGE_FILES, catalog_draft, file_rows, write_bundle
from camstack_train.spec import parse_job

CID = "custom-yolov9m-640-ab12cd34"


def stage(tmp_path, with_int8=True, with_coreml=True):
    s = tmp_path / "artifacts"
    s.mkdir()
    (s / f"{CID}.pt").write_bytes(b"pt")
    (s / f"{CID}.onnx").write_bytes(b"onnx")
    (s / f"{CID}-fp16.xml").write_bytes(b"<xml/>")
    (s / f"{CID}-fp16.bin").write_bytes(b"fp16w")
    if with_int8:
        (s / f"{CID}-int8.xml").write_bytes(b"<xml8/>")
        (s / f"{CID}-int8.bin").write_bytes(b"int8w")
    if with_coreml:
        for m in MLPACKAGE_FILES:
            p = s / f"{CID}.mlpackage" / m
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(m.encode())
    return s


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def test_rows_classify_every_file(tmp_path):
    rows = {r["path"]: r for r in file_rows(stage(tmp_path), CID)}
    assert rows[f"{CID}.onnx"] == {"path": f"{CID}.onnx", "bytes": 4, "sha256": sha(b"onnx"), "format": "onnx", "variant": "base"}
    assert rows[f"{CID}-int8.bin"]["variant"] == "int8" and rows[f"{CID}-int8.bin"]["format"] == "openvino"
    assert rows[f"{CID}-fp16.bin"]["variant"] == "base"
    assert rows[f"{CID}.mlpackage/Data/com.apple.CoreML/weights/weight.bin"]["format"] == "coreml"
    assert rows[f"{CID}.pt"]["format"] == "pt"
    assert len(rows) == 9


def test_bundle_holds_exactly_the_rows(tmp_path):
    s = stage(tmp_path)
    rows = file_rows(s, CID)
    bundle = write_bundle(s, rows, tmp_path / "out" / "bundle.tar")
    assert bundle["path"] == "bundle.tar" and bundle["sha256"] == sha((tmp_path / "out" / "bundle.tar").read_bytes())
    with tarfile.open(tmp_path / "out" / "bundle.tar") as tar:
        assert sorted(tar.getnames()) == sorted(r["path"] for r in rows)
    again = write_bundle(s, rows, tmp_path / "out2" / "bundle.tar")
    assert again["sha256"] == bundle["sha256"]  # deterministic


def test_catalog_draft_formats_and_revisions(tmp_path, job_dict):
    job = parse_job(job_dict)
    rows = file_rows(stage(tmp_path), CID)
    floors = {"candidate": {"person": 0.5}, "candidateInt8": {"person": 0.45}}
    draft = catalog_draft(job, rows, floors)
    base = draft["base"]
    assert base["id"] == CID and base["defaultClassFloors"] == {"person": 0.5}
    assert base["inputSize"] == {"width": 640, "height": 640} and base["preprocessMode"] == "letterbox"
    assert base["formats"]["onnx"] == {"url": f"{CID}.onnx", "sizeMB": 0.0, "revision": sha(b"onnx")}
    assert base["formats"]["openvino"]["url"] == f"{CID}-fp16.xml"
    assert base["formats"]["openvino"]["files"] == [f"{CID}-fp16.bin"]
    assert base["formats"]["openvino"]["revision"] == sha(b"fp16w")
    cm = base["formats"]["coreml"]
    assert cm["url"] == f"{CID}.mlpackage" and cm["isDirectory"] and cm["files"] == list(MLPACKAGE_FILES)
    assert cm["revision"] == sha(b"Data/com.apple.CoreML/weights/weight.bin")
    assert draft["int8"]["id"] == f"{CID}-int8"
    assert list(draft["int8"]["formats"]) == ["openvino"]
    assert draft["int8"]["defaultClassFloors"] == {"person": 0.45}


def test_draft_without_int8_or_coreml(tmp_path, job_dict):
    job = parse_job(job_dict)
    rows = file_rows(stage(tmp_path, with_int8=False, with_coreml=False), CID)
    draft = catalog_draft(job, rows, {"candidate": {}, "candidateInt8": None})
    assert draft["int8"] is None and "coreml" not in draft["base"]["formats"]
