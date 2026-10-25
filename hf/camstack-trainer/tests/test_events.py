from __future__ import annotations

import io
import json

import pytest

from camstack_train.events import PREFIX, Emitter, parse_line


def lines(buf: io.StringIO) -> list[dict]:
    return [json.loads(l[len(PREFIX):]) for l in buf.getvalue().splitlines()]


def test_every_event_is_one_prefixed_compact_line():
    buf = io.StringIO()
    em = Emitter(buf, clock=lambda: 12.5)
    em.stage("train")
    em.epoch(3, 40, 1.2, 0.5, 0.3, 90.0)
    em.done("succeeded", "f" * 64)
    raw = buf.getvalue().splitlines()
    assert all(l.startswith(PREFIX) for l in raw)
    events = lines(buf)
    assert [e["type"] for e in events] == ["stage", "epoch", "done"]
    assert all(e["v"] == 1 and e["ts"] == 12500 for e in events)
    assert events[1] == {"v": 1, "ts": 12500, "type": "epoch", "epoch": 3, "epochs": 40,
                         "boxLoss": 1.2, "map50": 0.5, "map50_95": 0.3, "etaSec": 90.0}
    assert events[2]["resultSha256"] == "f" * 64
    assert all(", " not in l and ": " not in l for l in raw)


def test_unknown_stage_is_a_bug():
    with pytest.raises(ValueError):
        Emitter(io.StringIO()).stage("bake")


def test_parse_line_ignores_other_output():
    assert parse_line("Epoch 1/40 ...") is None
    assert parse_line(PREFIX + "{not json") is None
    assert parse_line(PREFIX + '{"v":1,"type":"stage"}') == {"v": 1, "type": "stage"}
