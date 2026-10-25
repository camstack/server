from __future__ import annotations

import io
import json

from camstack_train.events import PREFIX, Emitter
from camstack_train.run import Deps, Paths, run_job
from camstack_train.spec import parse_job

from .conftest import frame, subject
from .fakes import FakeToolchain, detector_factory, fake_fetch, fake_trainer


def setup(tmp_path, make_export, job_dict, holdout=(2,)):
    frames = [frame(f"a{i}", 1, i, [subject("person")]) for i in range(4)]
    frames += [frame(f"b{i}", 2, i, [subject("person")]) for i in range(3)]
    path, digest = make_export(frames)
    job_dict["dataset"]["sha256"] = digest
    job_dict["split"]["holdoutCameras"] = list(holdout)
    job_dict["floors"]["minSupport"] = 2
    paths = Paths(job=tmp_path / "job.json", dataset=path, out=tmp_path / "out", cache=tmp_path / "cache", work=tmp_path / "work")
    return parse_job(job_dict), paths


def events(buf: io.StringIO) -> list[dict]:
    return [json.loads(l[len(PREFIX):]) for l in buf.getvalue().splitlines() if l.startswith(PREFIX)]


def deps(buf, **kw) -> Deps:
    return Deps(fetch=fake_fetch, trainer=fake_trainer, toolchain=kw.get("toolchain", FakeToolchain()),
                detector=kw.get("detector", detector_factory()), emitter=Emitter(buf))


def test_end_to_end_success(tmp_path, make_export, job_dict):
    job, paths = setup(tmp_path, make_export, job_dict)
    buf = io.StringIO()
    assert run_job(job, paths, deps(buf)) == 0
    result = json.loads((paths.out / "result.json").read_text())
    assert result["schema"] == "camstack.training-result/v1" and result["status"] == "succeeded"
    assert result["error"] is None
    assert result["dataset"]["frames"]["holdout"] == 3 and result["dataset"]["holdoutCameras"] == [2]
    assert result["evaluation"]["holdoutFrames"] == 3
    assert result["evaluation"]["candidate"]["classes"]["person"]["recall"] == 1.0
    assert result["int8"]["kept"] is True
    assert result["catalogDraft"]["int8"] is not None
    assert {f["path"] for f in result["files"]} >= {"custom-yolov9m-640-ab12cd34.onnx"}
    assert result["bundle"]["path"] == "bundle.tar" and (paths.out / "bundle.tar").is_file()
    stages = [e["stage"] for e in events(buf) if e["type"] == "stage"]
    assert stages == ["prepare", "replay", "train", "export", "eval", "package"]
    done = events(buf)[-1]
    assert done["type"] == "done" and done["status"] == "succeeded"
    import hashlib
    assert done["resultSha256"] == hashlib.sha256((paths.out / "result.json").read_bytes()).hexdigest()


def test_int8_gate_drops_a_worse_int8(tmp_path, make_export, job_dict):
    job, paths = setup(tmp_path, make_export, job_dict)
    buf = io.StringIO()
    assert run_job(job, paths, deps(buf, detector=detector_factory(int8_score=0.0))) == 0
    result = json.loads((paths.out / "result.json").read_text())
    assert result["int8"]["kept"] is False and result["int8"]["reason"].startswith("mAP50 drop")
    assert result["catalogDraft"]["int8"] is None
    assert not any(f["variant"] == "int8" for f in result["files"])
    assert any(d["export"] == "openvino-int8" for d in result["exportsDropped"])


def test_no_holdout_inherits_floors(tmp_path, make_export, job_dict):
    job, paths = setup(tmp_path, make_export, job_dict, holdout=())
    assert run_job(job, paths, deps(io.StringIO())) == 0
    result = json.loads((paths.out / "result.json").read_text())
    assert result["floors"]["candidate"] == job_dict["baseline"]["floors"]
    assert result["evaluation"]["candidate"] is None


def test_dataset_failure_writes_a_failed_result(tmp_path, make_export, job_dict):
    job, paths = setup(tmp_path, make_export, job_dict)
    job = job.model_copy(update={"dataset": job.dataset.model_copy(update={"sha256": "1" * 64})})
    buf = io.StringIO()
    assert run_job(job, paths, deps(buf)) == 65
    result = json.loads((paths.out / "result.json").read_text())
    assert result["status"] == "failed" and result["error"]["code"] == "dataset-sha256"
    kinds = [e["type"] for e in events(buf)]
    assert kinds[-2:] == ["error", "done"]


def test_unexpected_crash_is_internal_and_scrubbed(tmp_path, make_export, job_dict):
    job, paths = setup(tmp_path, make_export, job_dict)

    def boom(job, data_yaml, work, cache, emitter):
        raise RuntimeError(f"cannot read {work}/export/frames/101/t1/x.jpg")

    d = deps(io.StringIO())
    d.trainer = boom
    assert run_job(job, paths, d) == 70
    result = json.loads((paths.out / "result.json").read_text())
    assert result["error"]["code"] == "internal"
    assert str(paths.work) not in result["error"]["message"] and "<work>" in result["error"]["message"]
    assert result["dataset"]["frames"]["train"] > 0  # what was known is kept
