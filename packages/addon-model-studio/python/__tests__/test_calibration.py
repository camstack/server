"""INT8 calibration inputs (cloud-training P6): which images, and how they are
fed. Calibration must see frames the way the runtime feeds the model — the
inference pool's letterbox is CENTRED (pad = (size - new) // 2, grey 114) —
and must be able to use the operator's own frames, i.e. the hub's annotated
export, whose frames sit in nested folders next to `annotations.json`."""
import numpy as np
import pytest

cv2 = pytest.importorskip("cv2")

from convert_lib import calibration_images, letterbox_for_calibration  # noqa: E402


def _touch(path, data=b"x"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def test_a_flat_folder_is_read_in_file_name_order(tmp_path):
    for name in ("b.jpg", "a.jpg", "c.png", "notes.txt"):
        _touch(tmp_path / name)
    assert [p.name for p in calibration_images(str(tmp_path), 10)] == ["a.jpg", "b.jpg", "c.png"]


def test_the_sample_count_is_a_cap(tmp_path):
    for i in range(5):
        _touch(tmp_path / f"{i}.jpg")
    assert len(calibration_images(str(tmp_path), 3)) == 3


def test_an_export_directory_calibrates_on_its_frames_only(tmp_path):
    _touch(tmp_path / "annotations.json", b"{}")
    _touch(tmp_path / "frames" / "101" / "t1" / "a.jpg")
    _touch(tmp_path / "frames" / "102" / "t2" / "b.jpg")
    _touch(tmp_path / "crops" / "person" / "x.jpg")
    names = [p.relative_to(tmp_path).as_posix() for p in calibration_images(str(tmp_path), 10)]
    assert names == ["frames/101/t1/a.jpg", "frames/102/t2/b.jpg"]


def test_an_empty_folder_is_refused(tmp_path):
    with pytest.raises(ValueError):
        calibration_images(str(tmp_path), 10)


def test_the_letterbox_is_centred_like_the_runtime():
    rgb = np.full((100, 200, 3), 255, dtype=np.uint8)  # 2:1 white frame
    out = letterbox_for_calibration(rgb, 64)
    assert out.shape == (1, 3, 64, 64)
    assert out.dtype == np.float32
    # Content 64x32, centred: grey rows 0..15 and 48..63, white in between.
    column = out[0, 0, :, 32]
    assert column[0] == pytest.approx(114 / 255)
    assert column[63] == pytest.approx(114 / 255)
    assert column[32] == pytest.approx(1.0)
    assert column[15] == pytest.approx(114 / 255)
    assert column[16] == pytest.approx(1.0)
