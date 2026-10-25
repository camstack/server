"""Loading the hub's annotated export (annotations.json v2) as ground truth."""
import io
import json
import tarfile

from camstack_eval.dataset import load_export

FRAME_A = "retrain:t:a"
FRAME_B = "retrain:t:b"


def manifest():
    def frame(fid, complete, night, annotations, device=101):
        return {
            "frameId": fid,
            "path": f"frames/{device}/t/{fid[-1]}.jpg",
            "deviceId": device,
            "trackId": "t",
            "width": 1920,
            "height": 1080,
            "capturedAt": 1,
            "complete": complete,
            "lighting": None if night is None else {"condition": "x", "night": night, "source": "sun"},
            "annotations": annotations,
        }

    def ann(cls, kind="subject", bbox=(0.1, 0.1, 0.2, 0.3)):
        return {"id": cls, "macroClass": cls, "kind": kind, "source": "operator",
                "bbox": dict(zip("xywh", bbox)), "derived": {}}

    return {
        "schema": "camstack.retrain-export/v2",
        "layout": "frames",
        "frames": [
            frame(FRAME_A, True, True, [ann("person"), ann("vehicle", "model_error"), ann("face")]),
            frame(FRAME_B, False, False, [ann("person")]),
        ],
    }


def write_tar(path):
    with tarfile.open(path, "w") as tar:
        body = json.dumps(manifest()).encode()
        info = tarfile.TarInfo("annotations.json")
        info.size = len(body)
        tar.addfile(info, io.BytesIO(body))
        for name in ("frames/101/t/a.jpg", "frames/101/t/b.jpg"):
            info = tarfile.TarInfo(name)
            info.size = 3
            tar.addfile(info, io.BytesIO(b"jpg"))


def test_only_complete_frames_are_ground_truth_by_default(tmp_path):
    archive = tmp_path / "x.tar"
    write_tar(archive)

    frames = load_export(str(archive))

    assert [f.truth.frame_id for f in frames] == [FRAME_A]
    truth = frames[0].truth
    assert truth.camera == 101
    assert truth.night is True
    # A model_error box is not a subject; face is not a detector class.
    assert [b.cls for b in truth.boxes] == ["person"]
    assert frames[0].read() == b"jpg"


def test_incomplete_frames_can_be_included_on_request(tmp_path):
    archive = tmp_path / "x.tar"
    write_tar(archive)
    frames = load_export(str(archive), complete_only=False)
    assert {f.truth.frame_id for f in frames} == {FRAME_A, FRAME_B}


def test_an_extracted_directory_loads_the_same(tmp_path):
    archive = tmp_path / "x.tar"
    write_tar(archive)
    out = tmp_path / "x"
    with tarfile.open(archive) as tar:
        tar.extractall(out, filter="data")
    assert [f.truth.frame_id for f in load_export(str(out))] == [FRAME_A]
