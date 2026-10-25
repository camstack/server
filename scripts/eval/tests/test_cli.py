"""The CLI end to end on a synthetic export and two constant ONNX models."""
import io
import json
import tarfile

from PIL import Image

import evaluate
from tests.test_pipeline import tiny_yolo


def export(path):
    buf = io.BytesIO()
    Image.new("RGB", (200, 100), (0, 0, 0)).save(buf, "JPEG")
    jpg = buf.getvalue()
    frames = []
    with tarfile.open(path, "w") as tar:
        for i in range(3):
            name = f"frames/101/t/{i}.jpg"
            info = tarfile.TarInfo(name)
            info.size = len(jpg)
            tar.addfile(info, io.BytesIO(jpg))
            frames.append({
                "frameId": f"retrain:t:{i}", "path": name, "deviceId": 101, "trackId": "t",
                "width": 200, "height": 100, "complete": True, "lighting": None,
                "annotations": [{"id": str(i), "macroClass": "person", "kind": "subject",
                                 "source": "operator", "bbox": {"x": 0, "y": 0, "w": 0.5, "h": 1}}],
            })
        body = json.dumps({"schema": "camstack.retrain-export/v2", "frames": frames}).encode()
        info = tarfile.TarInfo("annotations.json")
        info.size = len(body)
        tar.addfile(info, io.BytesIO(body))


def test_compare_writes_a_report(tmp_path):
    archive = tmp_path / "x.tar"
    export(archive)
    base = tmp_path / "base.onnx"
    cand = tmp_path / "cand.onnx"
    tiny_yolo(str(base), [(16, 32, 32, 32, 0, 0.5)])  # under the 0.65 floor: misses
    tiny_yolo(str(cand), [(16, 32, 32, 32, 0, 0.9)])
    out = tmp_path / "r.json"

    code = evaluate.main([
        "--export", str(archive), "--baseline", str(base), "--baseline-size", "64",
        "--candidate", str(cand), "--candidate-size", "64", "--min-support", "1",
        "--out", str(out),
    ])

    assert code == 0
    person = json.loads(out.read_text())["classes"]["person"]
    assert person["baseline"]["recall"] == 0.0
    assert person["candidate"]["recall"] == 1.0
