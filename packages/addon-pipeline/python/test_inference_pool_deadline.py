"""Unit tests for the deadline-on-the-wire shed (D350).

On a pool timeout the TS runner drops the frame and returns null — but the
Python worker still executed the abandoned request and its late reply was
discarded as `Response for unknown request id`. Measured 2026-09-04: a 4h15m
storm, 16 146 timeouts, the accelerator at 100% on results nobody read.

Each SHEDDABLE request (infer_jpeg / infer_raw / infer_batch / infer_cached)
now carries its ABSOLUTE deadline (epoch ms, uint64 LE) on the wire when both
sides negotiated protocol v2; the worker checks it immediately before predict
and answers `{dropped: true, shedReason: "deadline-expired"}` instead of
running dead work. Commands and model loads NEVER carry a deadline — a shed
command desynchronizes model state.

Pure-python: stubs numpy / PIL / postprocessors in sys.modules so the module
imports without the ML runtime installed (inference_pool uses
`from __future__ import annotations`, so annotations never touch the stubs).

Run: python3 -m unittest test_inference_pool_deadline -v
"""
from __future__ import annotations

import struct
import sys
import time
import types
import unittest

# ---------------------------------------------------------------------------
# Stub the heavy third-party imports BEFORE importing inference_pool.
# ---------------------------------------------------------------------------

try:  # real numpy when the sandbox has it — a blind stub POISONS the whole
    import numpy  # noqa: F401  # pytest session for every sibling that needs it
except ImportError:
    _np = types.ModuleType("numpy")
    _np.float32 = float
    _np.array = lambda values, dtype=None: values
    sys.modules["numpy"] = _np

try:  # real PIL when present, for the same reason
    import PIL.Image  # noqa: F401
except ImportError:
    _pil = types.ModuleType("PIL")
    _pil_image = types.ModuleType("PIL.Image")
    _pil.Image = _pil_image
    sys.modules["PIL"] = _pil
    sys.modules["PIL.Image"] = _pil_image

if "postprocessors" not in sys.modules:
    _pp = types.ModuleType("postprocessors")
    _pp.POSTPROCESSORS = {}
    sys.modules["postprocessors"] = _pp

from inference_pool import (  # noqa: E402
    MSG_COMMAND,
    MSG_INFER_BATCH,
    MSG_INFER_CACHED,
    MSG_INFER_JPEG,
    MSG_INFER_RAW,
    PROTOCOL_VERSION,
    SHEDDABLE_MSG_TYPES,
    ModelSlot,
    PoolCounters,
    _deadline_expired,
    _execute_inference,
    _negotiate_wire_version,
    _split_deadline,
)


# ---------------------------------------------------------------------------
# Fakes — duck-typed stand-ins for the loop's writer / dispatcher.
# ---------------------------------------------------------------------------


class _FakeWriter:
    """Collects (req_id, payload) pairs the loop would write to stdout."""

    def __init__(self) -> None:
        self.sent: list[tuple[int, dict]] = []

    async def send(self, req_id: int, payload: dict) -> None:
        self.sent.append((req_id, payload))


class _FakeDispatcher:
    """Counts predict dispatches — the thing an expired request must NOT do."""

    def __init__(self) -> None:
        self.run_calls = 0

    async def run(self, slot: object, img: object) -> dict:
        self.run_calls += 1
        return {"kind": "detections", "detections": [], "inferenceMs": 1.0}


def _loaded_models() -> list:
    slot = ModelSlot()
    slot.loaded = True
    return [slot]


def _now_ms() -> int:
    return int(time.time() * 1000)


# ---------------------------------------------------------------------------
# The gate: expired ⇒ dropped, NO predict. Fresh ⇒ predict runs.
# ---------------------------------------------------------------------------


class DeadlineGateTest(unittest.IsolatedAsyncioTestCase):
    async def test_expired_request_is_answered_dropped_and_no_predict_ran(self) -> None:
        writer = _FakeWriter()
        dispatcher = _FakeDispatcher()
        counters = PoolCounters()
        await _execute_inference(
            7,
            object(),
            0,
            _now_ms() - 5_000,  # expired 5s ago — the storm's steady state
            models=_loaded_models(),
            dispatcher=dispatcher,
            writer=writer,
            batch_mode="none",
            get_accumulator=None,
            counters=counters,
        )
        # THE fix: dead work is not executed.
        self.assertEqual(dispatcher.run_calls, 0)
        self.assertEqual(len(writer.sent), 1)
        req_id, payload = writer.sent[0]
        self.assertEqual(req_id, 7)
        self.assertIs(payload.get("dropped"), True)
        self.assertEqual(payload.get("shedReason"), "deadline-expired")
        self.assertEqual(payload.get("kind"), "detections")
        self.assertEqual(payload.get("detections"), [])
        # The shed is COUNTABLE — a silent drop is what let the original
        # collapse run for four hours.
        self.assertEqual(counters.shed_deadline_expired, 1)
        self.assertEqual(counters.as_dict().get("shedDeadlineExpired"), 1)

    async def test_future_deadline_runs_normally(self) -> None:
        writer = _FakeWriter()
        dispatcher = _FakeDispatcher()
        counters = PoolCounters()
        await _execute_inference(
            8,
            object(),
            0,
            _now_ms() + 60_000,
            models=_loaded_models(),
            dispatcher=dispatcher,
            writer=writer,
            batch_mode="none",
            get_accumulator=None,
            counters=counters,
        )
        self.assertEqual(dispatcher.run_calls, 1)
        req_id, payload = writer.sent[0]
        self.assertEqual(req_id, 8)
        self.assertNotIn("dropped", payload)
        self.assertEqual(counters.shed_deadline_expired, 0)

    async def test_no_deadline_runs_normally(self) -> None:
        """deadline 0 = old host / no deadline — never sheds (skew safety)."""
        writer = _FakeWriter()
        dispatcher = _FakeDispatcher()
        counters = PoolCounters()
        await _execute_inference(
            9,
            object(),
            0,
            0,
            models=_loaded_models(),
            dispatcher=dispatcher,
            writer=writer,
            batch_mode="none",
            get_accumulator=None,
            counters=counters,
        )
        self.assertEqual(dispatcher.run_calls, 1)
        self.assertEqual(counters.shed_deadline_expired, 0)


# ---------------------------------------------------------------------------
# Wire parsing — both layouts, chosen by the negotiated version.
# ---------------------------------------------------------------------------


class SplitDeadlineTest(unittest.TestCase):
    def test_v1_payload_passes_through_untouched(self) -> None:
        """An OLD host never stamps a deadline — the payload is the old layout
        and must not lose its first 8 bytes to a prefix that is not there."""
        payload = bytes([3]) + b"jpegdata"
        self.assertEqual(_split_deadline(MSG_INFER_JPEG, payload, 1), (0, payload))

    def test_v2_sheddable_payload_strips_the_deadline_prefix(self) -> None:
        deadline = 1_757_000_000_123
        rest = bytes([3]) + b"jpegdata"
        payload = struct.pack("<Q", deadline) + rest
        self.assertEqual(_split_deadline(MSG_INFER_JPEG, payload, 2), (deadline, rest))

    def test_v2_applies_to_every_sheddable_opcode(self) -> None:
        deadline = 42
        rest = b"\x01payload"
        for msg_type in (MSG_INFER_JPEG, MSG_INFER_RAW, MSG_INFER_BATCH, MSG_INFER_CACHED):
            payload = struct.pack("<Q", deadline) + rest
            self.assertEqual(_split_deadline(msg_type, payload, 2), (deadline, rest))
            self.assertIn(msg_type, SHEDDABLE_MSG_TYPES)

    def test_commands_never_carry_a_deadline_even_at_v2(self) -> None:
        """A shed command desynchronizes model state — commands keep the old
        layout at every version."""
        payload = b'{"cmd": "status"}'
        self.assertEqual(_split_deadline(MSG_COMMAND, payload, 2), (0, payload))
        self.assertNotIn(MSG_COMMAND, SHEDDABLE_MSG_TYPES)

    def test_truncated_deadline_prefix_raises(self) -> None:
        with self.assertRaises(ValueError):
            _split_deadline(MSG_INFER_JPEG, b"\x00\x01\x02", 2)


class DeadlineExpiredTest(unittest.TestCase):
    def test_zero_deadline_never_expires(self) -> None:
        self.assertFalse(_deadline_expired(0, 1e15))

    def test_future_deadline_is_not_expired(self) -> None:
        self.assertFalse(_deadline_expired(2_000, 1_999.0))

    def test_past_deadline_is_expired(self) -> None:
        self.assertTrue(_deadline_expired(2_000, 2_001.0))


class NegotiateWireVersionTest(unittest.TestCase):
    def test_old_host_without_declaration_negotiates_v1(self) -> None:
        """A host at a different version is the NORMAL state during a deploy —
        no declaration means the old layout, always."""
        self.assertEqual(_negotiate_wire_version({}), 1)

    def test_matching_host_negotiates_v2(self) -> None:
        self.assertEqual(_negotiate_wire_version({"protocolVersion": 2}), 2)

    def test_newer_host_is_capped_at_our_version(self) -> None:
        self.assertEqual(_negotiate_wire_version({"protocolVersion": 99}), PROTOCOL_VERSION)

    def test_garbage_declaration_falls_back_to_v1(self) -> None:
        self.assertEqual(_negotiate_wire_version({"protocolVersion": "banana"}), 1)


if __name__ == "__main__":
    unittest.main()
