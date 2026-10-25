"""``job.json``, schema ``camstack.training/v1``.

The hub fills EVERY field: nothing here relies on a default, and an unknown
key is refused, so a hub and a trainer that disagree about the contract fail
loudly at the first line instead of training on a silently ignored setting.
An unknown ``schema`` exits 64 before anything is read.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from pydantic.alias_generators import to_camel

from .errors import TrainerError, spec_error

JOB_SCHEMA = "camstack.training/v1"

ExportName = Literal["onnx", "openvino-fp16", "openvino-int8", "coreml-fp16"]

#: Macro classes a root detector's floors are kept for.
FLOOR_CLASSES = ("person", "vehicle", "animal")

#: A catalog id becomes file names on every node: lower-case, no path parts.
CATALOG_ID_PATTERN = r"^[a-z0-9][a-z0-9._-]{0,95}$"


class _Model(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        frozen=True,
        protected_namespaces=(),
    )


class Target(_Model):
    kind: Literal["detector"]
    step: Literal["object-detection"]


class Base(_Model):
    model_id: str = Field(min_length=1)
    weights: str = Field(pattern=r"^[A-Za-z0-9._-]+\.pt$")
    imgsz: int = Field(ge=64, le=2048)


class Baseline(_Model):
    model_id: str = Field(min_length=1)
    onnx_url: str = Field(pattern=r"^https://")
    imgsz: int = Field(ge=64, le=2048)
    floors: dict[str, float]

    @field_validator("floors")
    @classmethod
    def _every_class(cls, value: dict[str, float]) -> dict[str, float]:
        missing = [c for c in FLOOR_CLASSES if c not in value]
        if missing:
            raise ValueError(f"baseline floors miss {', '.join(missing)}")
        if any(not 0.0 <= v <= 1.0 for v in value.values()):
            raise ValueError("a baseline floor is outside [0, 1]")
        return value


class Dataset(_Model):
    version_id: str = Field(min_length=1)
    annotation_hash: str
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class Split(_Model):
    holdout_cameras: list[int]
    holdout_last_days: int = Field(ge=0, le=365)
    val_fraction: float = Field(ge=0.0, le=0.5)
    seed: int


class Hyper(_Model):
    epochs: int = Field(ge=1, le=1000)
    batch: int = Field(ge=1, le=512)
    lr0: float = Field(gt=0.0, le=1.0)
    freeze: int = Field(ge=0, le=100)
    patience: int = Field(ge=0, le=1000)
    seed: int


class Replay(_Model):
    source: Literal["coco2017"]
    count: int = Field(ge=0, le=20000)


class Calibration(_Model):
    max_frames: int = Field(ge=1, le=5000)


class Floors(_Model):
    min_support: int = Field(ge=0)
    clamp: float = Field(ge=0.0, le=1.0)


class Int8Gate(_Model):
    max_map50_drop: float = Field(ge=0.0, le=1.0)


class Catalog(_Model):
    id: str = Field(pattern=CATALOG_ID_PATTERN)
    name: str = Field(min_length=1, max_length=120)


class JobSpec(_Model):
    schema_: Literal["camstack.training/v1"] = Field(alias="schema")
    job_key: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9-]+$")
    target: Target
    base: Base
    baseline: Baseline
    dataset: Dataset
    split: Split
    hyper: Hyper
    replay: Replay
    exports: list[ExportName] = Field(min_length=1)
    calibration: Calibration
    floors: Floors
    int8_gate: Int8Gate
    catalog: Catalog

    @field_validator("exports")
    @classmethod
    def _onnx_first(cls, value: list[str]) -> list[str]:
        if "onnx" not in value:
            raise ValueError("exports must include onnx: every other format is built from it")
        if len(set(value)) != len(value):
            raise ValueError("exports lists a format twice")
        return value


def parse_job(raw: object) -> JobSpec:
    """Validate a decoded ``job.json``; any refusal is a spec error (exit 64)."""
    if not isinstance(raw, dict):
        raise spec_error("bad-spec", "job.json is not an object")
    schema = raw.get("schema")
    if schema != JOB_SCHEMA:
        raise spec_error("unknown-schema", f"job schema {schema!r} is not {JOB_SCHEMA}")
    try:
        return JobSpec.model_validate(raw)
    except ValidationError as exc:
        fields = sorted({".".join(str(p) for p in e["loc"]) for e in exc.errors()})
        raise spec_error("bad-spec", f"job.json refused at: {', '.join(fields)}") from exc


def load_job(path: Path) -> JobSpec:
    try:
        raw = json.loads(path.read_text("utf-8"))
    except FileNotFoundError as exc:
        raise spec_error("bad-spec", "job.json not found") from exc
    except json.JSONDecodeError as exc:
        raise spec_error("bad-spec", f"job.json is not JSON (line {exc.lineno})") from exc
    return parse_job(raw)


def job_key_of(path: Path) -> str:
    """The ``jobKey`` of a job file even when the rest is refused (for result.json)."""
    try:
        raw = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""
    key = raw.get("jobKey") if isinstance(raw, dict) else None
    return key if isinstance(key, str) else ""


__all__ = ["JobSpec", "JOB_SCHEMA", "TrainerError", "parse_job", "load_job", "job_key_of"]
