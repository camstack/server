"""The worker's row extraction against a RenderBatch captured from a real box (fw 8.52.2).

Serial-like values in the capture are masked with X, byte for byte, so the offsets hold.
"""
import gzip
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from enpal_worker import merge_rows  # noqa: E402


def load_batch() -> bytes:
    return gzip.decompress((HERE / "fixtures" / "render-batch-fw852.bin.gz").read_bytes())


def test_the_initial_render_yields_every_device_table():
    rows = {r["key"]: r for r in merge_rows([load_batch()])}
    assert len(rows) > 100
    assert rows["Energy.Battery.Charge.Level"]["value"] == "98.9"
    assert rows["Energy.Battery.Charge.Level"]["unit"] == "%"
    assert rows["Power.DC.Total"]["unit"] == "W"
    assert rows["Heatpump.Power.Consumption.Total"]["value"] == "2991"


def test_a_later_batch_replaces_an_earlier_reading_of_the_same_key():
    first = load_batch()
    rows = merge_rows([first, first])
    assert len({r["key"] for r in rows}) == len(rows)


def test_a_missing_host_answers_json_and_exits_nonzero():
    done = subprocess.run(
        [sys.executable, str(HERE / "enpal_worker.py")],
        input="{}", capture_output=True, text=True, timeout=30,
    )
    assert done.returncode == 1
    assert json.loads(done.stdout)["ok"] is False
