from __future__ import annotations

import io
import json

from camstack_train.cli import main
from camstack_train.events import Emitter
from camstack_train.run import Deps

from .conftest import frame, subject
from .fakes import FakeToolchain, detector_factory, fake_fetch, fake_trainer


def test_bad_spec_exits_64_with_a_failed_result(tmp_path, job_dict):
    job_dict["schema"] = "camstack.training/v0"
    (tmp_path / "job.json").write_text(json.dumps(job_dict))
    buf = io.StringIO()
    code = main(["run", "--job", str(tmp_path / "job.json"), "--dataset", str(tmp_path / "d.tar"),
                 "--out", str(tmp_path / "out"), "--cache", str(tmp_path / "c")], deps=Deps(emitter=Emitter(buf)))
    assert code == 64
    result = json.loads((tmp_path / "out" / "result.json").read_text())
    assert result["status"] == "failed" and result["jobKey"] == job_dict["jobKey"]
    assert result["error"]["code"] == "unknown-schema"


def test_run_ok_exits_0(tmp_path, job_dict, make_export):
    path, digest = make_export([frame(f"a{i}", 1, i, [subject("person")]) for i in range(3)])
    job_dict["dataset"]["sha256"] = digest
    (tmp_path / "job.json").write_text(json.dumps(job_dict))
    deps = Deps(fetch=fake_fetch, trainer=fake_trainer, toolchain=FakeToolchain(),
                detector=detector_factory(), emitter=Emitter(io.StringIO()))
    code = main(["run", "--job", str(tmp_path / "job.json"), "--dataset", str(path), "--out", str(tmp_path / "out"),
                 "--cache", str(tmp_path / "c"), "--work", str(tmp_path / "w")], deps=deps)
    assert code == 0


def test_dataset_command(tmp_path, make_export, capsys):
    path, _ = make_export([frame("a", 1, 0, [subject("person")]), frame("b", 1, 0, [subject("animal")])])
    assert main(["dataset", "--export", str(path), "--out", str(tmp_path / "o")]) == 0
    assert "1 frames, 1 boxes" in capsys.readouterr().out
