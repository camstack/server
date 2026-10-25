"""Runtime conversion subprocess. Invoked as: python convert.py <job.json>

job.json: { onnxPath, outDir, modelId, imgsz, targets: [...], calibDir? }
stdout: one JSON object per line — progress {"phase","pct","detail"} then a
final {"result": {"artifacts": [...]}} line. Errors -> stderr, non-zero exit."""
import json
import sys
from pathlib import Path

import convert_lib as cl


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> int:
    job = json.loads(Path(sys.argv[1]).read_text())
    onnx_path = job["onnxPath"]
    out_dir = Path(job["outDir"])
    model_id = job["modelId"]
    imgsz = int(job["imgsz"])
    artifacts = []

    for target in job["targets"]:
        fmt = target["format"]
        if fmt == "openvino":
            for precision in target["precisions"]:
                emit({"phase": "convert", "pct": 0, "detail": f"openvino/{precision}"})
                suffix = "" if precision == "fp16" else f"-{precision}"
                xml = out_dir / f"camstack-{model_id}{suffix}.xml"
                if precision == "fp16":
                    cl.export_openvino(onnx_path, str(xml), fp16=True)
                else:
                    calib = job.get("calibDir")
                    if not calib:
                        emit({"phase": "skip", "detail": "int8: no calibration set"})
                        continue
                    cl.quantize_openvino_int8(onnx_path, str(xml), calib, imgsz)
                emit({"phase": "validate", "detail": f"openvino/{precision}"})
                cl.validate_openvino_ir(str(xml))
                bin_path = xml.with_suffix(".bin")
                size_mb = (xml.stat().st_size + bin_path.stat().st_size) / 1e6
                artifacts.append({
                    "format": "openvino", "precision": precision, "sizeMB": round(size_mb, 2),
                    "validated": True, "files": [xml.name, bin_path.name],
                })
        elif fmt == "coreml":
            emit({"phase": "convert", "pct": 0, "detail": "coreml"})
            pkg = out_dir / f"camstack-{model_id}.mlpackage"
            cl.export_coreml_from_onnx(onnx_path, str(pkg), imgsz)
            cl.validate_coreml(str(pkg))
            size_mb = sum(f.stat().st_size for f in pkg.rglob("*") if f.is_file()) / 1e6
            artifacts.append({
                "format": "coreml", "sizeMB": round(size_mb, 2),
                "validated": True, "files": [pkg.name],
            })

    emit({"result": {"artifacts": artifacts}})
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 — surface to the parent on stderr
        sys.stderr.write(f"convert.py failed: {exc}\n")
        sys.exit(1)
