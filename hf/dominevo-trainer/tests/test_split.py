from __future__ import annotations

import pytest

from camstack_train.dataset import coco_80, frame_from_entry
from camstack_train.errors import TrainerError
from camstack_train.spec import Split
from camstack_train.split import assign

from .conftest import frame, subject


def frames(spec: list[tuple[str, int, int]]):
    names = coco_80()
    return [frame_from_entry(frame(fid, dev, day, [subject("person")]), names) for fid, dev, day in spec]


def policy(**kw) -> Split:
    base = {"holdout_cameras": [], "holdout_last_days": 0, "val_fraction": 0.0, "seed": 1}
    return Split(**{**base, **kw})


def test_holdout_cameras_are_held_out_whole():
    fs = frames([("a", 1, 0), ("b", 1, 1), ("c", 2, 0), ("d", 3, 0)])
    result = assign(fs, policy(holdout_cameras=[2, 3]))
    assert {f.frame_id for f in result.holdout} == {"c", "d"}
    assert {f.frame_id for f in result.train} == {"a", "b"}
    assert result.holdout_cameras == (2, 3)


def test_last_days_per_camera():
    fs = frames([("a", 1, 0), ("b", 1, 5), ("c", 2, 2), ("d", 2, 3), ("e", 2, 4)])
    result = assign(fs, policy(holdout_last_days=2))
    # camera 1: last day 5 → day 5 only (day 4 absent); camera 2: last day 4 → days 3, 4
    assert {f.frame_id for f in result.holdout} == {"b", "d", "e"}


def test_val_takes_whole_groups_deterministically():
    spec = [(f"f{d}-{i}", cam, d) for cam in (1, 2) for d in range(5) for i in range(3)]
    a = assign(frames(spec), policy(val_fraction=0.2, seed=7))
    b = assign(frames(spec), policy(val_fraction=0.2, seed=7))
    assert [f.frame_id for f in a.val] == [f.frame_id for f in b.val]
    groups = {(f.device_id, f.captured_at) for f in a.val}
    for f in a.train:
        assert (f.device_id, f.captured_at) not in groups  # a day never straddles
    assert 0 < len(a.val) <= 9


def test_val_never_takes_the_last_train_group():
    result = assign(frames([("a", 1, 0), ("b", 1, 0)]), policy(val_fraction=0.5))
    assert len(result.train) == 2 and result.val == ()


def test_empty_train_refused():
    with pytest.raises(TrainerError) as err:
        assign(frames([("a", 1, 0)]), policy(holdout_cameras=[1]))
    assert err.value.code == "no-train-frames" and err.value.exit_code == 65


def test_holdout_eval_is_complete_frames_only():
    names = coco_80()
    fs = [
        frame_from_entry(frame("a", 1, 0, [subject("person")]), names),
        frame_from_entry(frame("b", 2, 0, [subject("person")], complete=False), names),
        frame_from_entry(frame("c", 2, 0, [subject("person")]), names),
    ]
    result = assign(fs, policy(holdout_cameras=[2]))
    assert [f.frame_id for f in result.holdout_eval] == ["c"]
