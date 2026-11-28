"""result.json validates against the published model; the schemas are current."""
from __future__ import annotations

import io
import json
import subprocess
import sys
from pathlib import Path

from camstack_train.events import Emitter
from camstack_train.manifest import failed_result
from camstack_train.result_model import TrainingResult
from camstack_train.run import Deps, run_job

from .fakes import FakeToolchain, detector_factory, fake_fetch, fake_trainer
from .test_run import setup

ROOT = Path(__file__).resolve().parents[1]


def test_succeeded_result_matches_the_model(tmp_path, make_export, job_dict):
    job, paths = setup(tmp_path, make_export, job_dict)
    deps = Deps(fetch=fake_fetch, trainer=fake_trainer, toolchain=FakeToolchain(fail=("coreml",)),
                detector=detector_factory(), emitter=Emitter(io.StringIO()))
    assert run_job(job, paths, deps) == 0
    TrainingResult.model_validate(json.loads((paths.out / "result.json").read_text()))


def test_failed_result_matches_the_model():
    TrainingResult.model_validate(failed_result("k", {"stage": "prepare", "code": "bad-spec", "message": "m"}))


def test_checked_in_schemas_are_current():
    proc = subprocess.run([sys.executable, str(ROOT / "tools" / "gen_schemas.py"), "--check"], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout
