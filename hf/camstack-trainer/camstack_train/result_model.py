"""The shape of ``result.json`` (``camstack.training-result/v1``), as pydantic.

``manifest.py`` builds the document as plain dicts; this model is the contract
it is checked against (in the tests, and by ``tools/gen_schemas.py`` into
``schemas/result.schema.json``, which the hub mirrors in zod). The harness's
per-class reports stay open (``dict``): their shape is the harness's own.
"""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class _Open(BaseModel):
    model_config = ConfigDict(extra="forbid", protected_namespaces=())


class ErrorBlock(_Open):
    stage: str
    code: str
    message: str


class TrainerBlock(_Open):
    version: str
    revision: str


class Frames(_Open):
    train: int
    val: int
    holdout: int


class DatasetBlock(_Open):
    versionId: str
    annotationHash: str
    sha256: str
    frames: Frames
    holdoutCameras: list[int]
    replayImages: int


class TrainingBlock(_Open):
    epochsRun: int
    bestEpoch: int
    bestMap50: float
    bestMap50_95: float
    seconds: float


class EvaluationBlock(_Open):
    holdoutFrames: int
    baseline: Optional[dict[str, Any]]
    candidate: Optional[dict[str, Any]]
    candidateInt8: Optional[dict[str, Any]]
    recallDeltaByCamera: Optional[dict[str, dict[str, float]]]
    map50: dict[str, Optional[float]]


class FloorsBlock(_Open):
    baseline: dict[str, float]
    candidate: dict[str, float]
    candidateInt8: Optional[dict[str, float]]
    notes: list[str]


class Int8Block(_Open):
    kept: bool
    map50Fp16: Optional[float]
    map50Int8: Optional[float]
    reason: Optional[str]


class Dropped(_Open):
    export: str
    reason: str


class FileRow(_Open):
    path: str
    bytes: int
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    format: Literal["onnx", "openvino", "coreml", "pt"]
    variant: Literal["base", "int8"]


class Bundle(_Open):
    path: Literal["bundle.tar"]
    bytes: int
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class FormatEntry(_Open):
    url: str
    sizeMB: float
    revision: str
    files: Optional[list[str]] = None
    runtimes: Optional[list[Literal["python"]]] = None
    isDirectory: Optional[bool] = None


class CatalogEntryDraft(_Open):
    id: str
    name: str
    description: str
    inputSize: dict[Literal["width", "height"], int]
    labels: list[Any]
    preprocessMode: Literal["letterbox"]
    defaultClassFloors: dict[str, float]
    formats: dict[Literal["onnx", "openvino", "coreml"], FormatEntry]


class CatalogDraft(_Open):
    base: CatalogEntryDraft
    int8: Optional[CatalogEntryDraft]


class TrainingResult(_Open):
    """A succeeded result carries every block; a failed one the error and whatever was known."""

    schema_: Literal["camstack.training-result/v1"] = Field(alias="schema")
    jobKey: str
    status: Literal["succeeded", "failed"]
    error: Optional[ErrorBlock]
    trainer: TrainerBlock
    toolchain: dict[str, Optional[str]]
    dataset: Optional[DatasetBlock] = None
    training: Optional[TrainingBlock] = None
    evaluation: Optional[EvaluationBlock] = None
    floors: Optional[FloorsBlock] = None
    int8: Optional[Int8Block] = None
    exportsDropped: Optional[list[Dropped]] = None
    files: Optional[list[FileRow]] = None
    bundle: Optional[Bundle] = None
    catalogDraft: Optional[CatalogDraft] = None
    licence: str
