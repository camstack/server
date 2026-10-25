"""``result.json`` (schema ``camstack.training-result/v1``) and ``bundle.tar``.

``bundle.tar`` holds every artefact under its FLAT catalog name (a Core ML
package as its directory), and ``files[]`` lists one row per regular file in it
with its size and sha256, so the hub verifies what it fetched file by file.

``catalogDraft`` is a ``ModelCatalogEntry`` per variant whose format URLs are
RELATIVE file names (the hub rewrites them to ``camstack-local://``), with the
revision every format carries under D743/D744: the sha256 of its weight file
(the ONNX itself, an IR's ``.bin``, a Core ML package's ``weight.bin``).
"""
from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import platform
import tarfile
from pathlib import Path
from typing import Optional

from . import __version__
from .dataset import sha256_file
from .spec import JobSpec

RESULT_SCHEMA = "camstack.training-result/v1"
LICENCE = "AGPL-3.0 (Ultralytics derivative)"
MLPACKAGE_FILES = (
    "Manifest.json",
    "Data/com.apple.CoreML/model.mlmodel",
    "Data/com.apple.CoreML/weights/weight.bin",
)
TOOLCHAIN_PACKAGES = ("torch", "ultralytics", "openvino", "nncf", "coremltools", "onnx")


def toolchain_versions() -> dict[str, Optional[str]]:
    out: dict[str, Optional[str]] = {"python": platform.python_version()}
    for name in TOOLCHAIN_PACKAGES:
        try:
            out[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            out[name] = None
    return out


def trainer_block() -> dict[str, str]:
    return {"version": __version__, "revision": os.environ.get("TRAINER_REVISION", "local")}


def classify(rel: str, catalog_id: str) -> tuple[str, str]:
    """(format, variant) of a bundle file."""
    if rel.startswith(f"{catalog_id}.mlpackage/"):
        return "coreml", "base"
    if rel.endswith(".pt"):
        return "pt", "base"
    if rel.endswith(".onnx"):
        return "onnx", "base"
    return "openvino", "int8" if rel.startswith(f"{catalog_id}-int8.") else "base"


def file_rows(staging: Path, catalog_id: str) -> list[dict]:
    rows = []
    for path in sorted(p for p in staging.rglob("*") if p.is_file()):
        rel = path.relative_to(staging).as_posix()
        fmt, variant = classify(rel, catalog_id)
        rows.append({"path": rel, "bytes": path.stat().st_size, "sha256": sha256_file(path), "format": fmt, "variant": variant})
    return rows


def write_bundle(staging: Path, rows: list[dict], out: Path) -> dict:
    """A plain, deterministic tar of exactly the listed files."""
    out.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(out, "w", format=tarfile.PAX_FORMAT) as tar:
        for row in rows:
            info = tar.gettarinfo(str(staging / row["path"]), arcname=row["path"])
            info.mtime, info.uid, info.gid, info.uname, info.gname = 0, 0, 0, "", ""
            with (staging / row["path"]).open("rb") as handle:
                tar.addfile(info, handle)
    return {"path": out.name, "bytes": out.stat().st_size, "sha256": sha256_file(out)}


def _row(rows: list[dict], path: str) -> Optional[dict]:
    return next((r for r in rows if r["path"] == path), None)


def _mb(*rows: Optional[dict]) -> float:
    return round(sum(r["bytes"] for r in rows if r is not None) / 1e6, 2)


def _openvino_format(rows: list[dict], stem: str) -> Optional[dict]:
    xml, weights = _row(rows, f"{stem}.xml"), _row(rows, f"{stem}.bin")
    if xml is None or weights is None:
        return None
    return {"url": xml["path"], "files": [weights["path"]], "runtimes": ["python"], "sizeMB": _mb(xml, weights), "revision": weights["sha256"]}


def _formats_base(rows: list[dict], cid: str) -> dict:
    formats: dict = {}
    onnx = _row(rows, f"{cid}.onnx")
    if onnx is not None:
        formats["onnx"] = {"url": onnx["path"], "sizeMB": _mb(onnx), "revision": onnx["sha256"]}
    ov = _openvino_format(rows, f"{cid}-fp16")
    if ov is not None:
        formats["openvino"] = ov
    members = [_row(rows, f"{cid}.mlpackage/{m}") for m in MLPACKAGE_FILES]
    if all(m is not None for m in members):
        formats["coreml"] = {
            "url": f"{cid}.mlpackage",
            "isDirectory": True,
            "files": list(MLPACKAGE_FILES),
            "runtimes": ["python"],
            "sizeMB": _mb(*members),
            "revision": members[2]["sha256"],
        }
    return formats


def _entry(job: JobSpec, entry_id: str, name: str, description: str, formats: dict, floors: dict) -> dict:
    return {
        "id": entry_id,
        "name": name,
        "description": description,
        "inputSize": {"width": job.base.imgsz, "height": job.base.imgsz},
        "labels": [],
        "preprocessMode": "letterbox",
        "defaultClassFloors": floors,
        "formats": formats,
    }


def catalog_draft(job: JobSpec, rows: list[dict], floors: dict) -> dict:
    cid = job.catalog.id
    origin = f"fine-tuned from {job.base.model_id} on dataset version {job.dataset.version_id}"
    base = _entry(job, cid, job.catalog.name, f"{job.catalog.name} — {origin}", _formats_base(rows, cid), floors["candidate"])
    int8 = None
    int8_format = _openvino_format(rows, f"{cid}-int8")
    if int8_format is not None and floors.get("candidateInt8") is not None:
        int8 = _entry(
            job, f"{cid}-int8", f"{job.catalog.name} (INT8)",
            f"{job.catalog.name} — OpenVINO INT8 calibrated on the user's own frames; {origin}",
            {"openvino": int8_format}, floors["candidateInt8"],
        )
    return {"base": base, "int8": int8}


def result_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_result(path: Path, result: dict) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, indent=2, sort_keys=False) + "\n", "utf-8")
    return result_sha256(path)


def failed_result(job_key: str, error: dict) -> dict:
    return {
        "schema": RESULT_SCHEMA,
        "jobKey": job_key,
        "status": "failed",
        "error": error,
        "trainer": trainer_block(),
        "toolchain": toolchain_versions(),
        "licence": LICENCE,
    }
