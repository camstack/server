from __future__ import annotations

import json

import pytest

from camstack_train.errors import EXIT_BAD_SPEC, TrainerError
from camstack_train.spec import load_job, parse_job


def test_valid_job_parses(job_dict):
    job = parse_job(job_dict)
    assert job.job_key == job_dict["jobKey"]
    assert job.int8_gate.max_map50_drop == 0.02
    assert job.baseline.onnx_url.startswith("https://")


def test_unknown_schema_exits_64(job_dict):
    job_dict["schema"] = "camstack.training/v2"
    with pytest.raises(TrainerError) as err:
        parse_job(job_dict)
    assert err.value.exit_code == EXIT_BAD_SPEC
    assert err.value.code == "unknown-schema"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda j: j.pop("hyper"),  # every field is required: no defaults
        lambda j: j.update(extra=1),  # unknown keys refused
        lambda j: j["catalog"].update(id="../escape"),  # file-name safe id
        lambda j: j.update(exports=["openvino-fp16"]),  # onnx is required
        lambda j: j["baseline"]["floors"].pop("animal"),
        lambda j: j["dataset"].update(sha256="nothex"),
    ],
)
def test_refusals_are_bad_spec(job_dict, mutate):
    mutate(job_dict)
    with pytest.raises(TrainerError) as err:
        parse_job(job_dict)
    assert err.value.exit_code == EXIT_BAD_SPEC


def test_load_job_reports_unreadable_json(tmp_path):
    path = tmp_path / "job.json"
    path.write_text("{nope")
    with pytest.raises(TrainerError) as err:
        load_job(path)
    assert err.value.exit_code == EXIT_BAD_SPEC


def test_load_job_roundtrip(tmp_path, job_dict):
    path = tmp_path / "job.json"
    path.write_text(json.dumps(job_dict))
    assert load_job(path).catalog.id == job_dict["catalog"]["id"]
