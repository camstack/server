"""A model load never runs on the event loop, and never runs unbounded (D653).

2026-09-26, hub `openvino:gpu`: ONE synchronous `core.compile_model()` of
`camstack-yunet-2023mar.xml` never returned. It ran inline on the asyncio loop,
so from 18:33:48 until a container restart at 22:41 the worker read no request
and wrote no reply — 786 client-side timeouts across six cameras, 123 of 123
`mem_stats` probes lost, and a pool that looked alive the whole time.

Pinned here, against the SAME `CommandRouter` / `ModelLoader` that `_run` uses:
  1. a command that is not a model load (`mem_stats`) is answered WHILE a load
     is blocked in native code;
  2. a load past its bound answers `compile-timeout`, naming the model, and
     POISONS the worker — a stuck native thread cannot be killed, so every later
     load is refused at once instead of queueing behind it;
  3. model-management commands keep their order (a `status` sent after a
     `load` describes the load);
  4. a slot is installed only when its load COMPLETED in time — a compile that
     returns after the bound fired never reaches `models`.

Heavy runtime deps are stubbed exactly as the sibling pool tests do, so the
module imports on a bare interpreter.
"""
import asyncio
import sys
import threading
import time
import types
import unittest

try:  # real numpy when the sandbox has it — a blind stub POISONS the whole
    import numpy  # noqa: F401  # pytest session for every sibling that needs it
except ImportError:
    _np = types.ModuleType("numpy")
    _np.array = lambda seq, dtype=None: list(seq)  # noqa: E731
    _np.float32 = "float32"
    sys.modules["numpy"] = _np
try:  # real PIL when present, for the same reason
    import PIL.Image  # noqa: F401
except ImportError:
    _pil = types.ModuleType("PIL")
    _pil_image = types.ModuleType("PIL.Image")
    _pil.Image = _pil_image
    sys.modules["PIL"] = _pil
    sys.modules["PIL.Image"] = _pil_image

from inference_pool import (  # noqa: E402
    MODEL_LOAD_TIMEOUT_SEC,
    CommandRouter,
    ModelLoader,
    ModelSlot,
    _model_load_timeout_sec,
)

YUNET = "/models/openvino/camstack-yunet-2023mar.xml"


def _load_cmd(index: int = 0, path: str = YUNET) -> dict:
    return {"cmd": "load", "index": index, "config": {"path": path}}


class _Harness:
    """A router wired to a recording `send`, with a controllable load_fn."""

    def __init__(self, timeout_sec: float, block: bool = True) -> None:
        self.release = threading.Event()
        self.load_calls: list[str] = []
        self.sent: list[tuple[int, dict]] = []
        self.models: list[ModelSlot] = []
        block_on = self.release if block else None

        def load_fn(slot: ModelSlot, config: dict) -> None:
            self.load_calls.append(config["path"])
            if block_on is not None:
                # Bounded so a failing test can never hang the suite.
                block_on.wait(5.0)
            slot.config = dict(config)
            slot.loaded = True

        self.events: list[dict] = []

        async def notify(event: dict) -> None:
            self.events.append(event)

        self.loader = ModelLoader(timeout_sec=timeout_sec, load_fn=load_fn, notify=notify)

        async def send(req_id: int, payload: dict) -> None:
            self.sent.append((req_id, payload))

        def inline(cmd: dict) -> dict:
            return {"cmd": cmd.get("cmd"), "status": "ok", "modelLoad": self.loader.snapshot()}

        self.router = CommandRouter(self.models, self.loader, send, inline)

    def reply(self, req_id: int) -> "dict | None":
        for rid, payload in self.sent:
            if rid == req_id:
                return payload
        return None

    async def wait_for_reply(self, req_id: int, timeout: float = 3.0) -> dict:
        deadline = asyncio.get_running_loop().time() + timeout
        while asyncio.get_running_loop().time() < deadline:
            found = self.reply(req_id)
            if found is not None:
                return found
            await asyncio.sleep(0.01)
        raise AssertionError(f"no reply to request {req_id} within {timeout}s")


class CompileRunsOffTheLoop(unittest.TestCase):
    def test_mem_stats_is_answered_while_a_load_is_blocked(self) -> None:
        async def scenario() -> None:
            h = _Harness(timeout_sec=5.0)
            await h.router.submit(1, _load_cmd())
            await asyncio.sleep(0.05)  # the compile is now running
            await h.router.submit(2, {"cmd": "mem_stats"})
            stats = await h.wait_for_reply(2, timeout=1.0)
            # The load is still running — and the probe was answered anyway,
            # reporting what is compiling.
            self.assertIsNone(h.reply(1))
            self.assertEqual(stats["status"], "ok")
            in_flight = stats["modelLoad"]["inFlight"]
            self.assertIsNotNone(in_flight)
            self.assertEqual(in_flight["modelId"], "camstack-yunet-2023mar")
            self.assertEqual(in_flight["index"], 0)
            h.release.set()
            loaded = await h.wait_for_reply(1)
            self.assertEqual(loaded["status"], "ok")
            self.assertTrue(h.models[0].loaded)

        asyncio.run(scenario())

    def test_model_commands_keep_their_order(self) -> None:
        async def scenario() -> None:
            h = _Harness(timeout_sec=5.0)
            await h.router.submit(1, _load_cmd())
            await h.router.submit(2, {"cmd": "status"})
            await asyncio.sleep(0.1)
            # `status` queues BEHIND the load; answering it first would
            # describe a model set the host is about to change.
            self.assertIsNone(h.reply(2))
            h.release.set()
            await h.wait_for_reply(1)
            status = await h.wait_for_reply(2)
            self.assertEqual([rid for rid, _ in h.sent], [1, 2])
            self.assertTrue(status["models"][0]["loaded"])

        asyncio.run(scenario())


class CompileIsBounded(unittest.TestCase):
    def test_a_load_past_its_bound_answers_compile_timeout_and_poisons(self) -> None:
        async def scenario() -> None:
            h = _Harness(timeout_sec=0.2)
            await h.router.submit(1, _load_cmd())
            reply = await h.wait_for_reply(1, timeout=2.0)
            self.assertEqual(reply["status"], "error")
            self.assertEqual(reply["reason"], "compile-timeout")
            self.assertEqual(reply["modelId"], "camstack-yunet-2023mar")
            self.assertEqual(reply["index"], 0)
            self.assertTrue(reply["poisoned"])
            self.assertEqual(reply["timeoutMs"], 200)
            self.assertGreaterEqual(reply["compileElapsedMs"], 200)
            # Nothing half-built reached the slot table.
            self.assertFalse(h.models[0].loaded)
            snap = h.loader.snapshot()
            self.assertIsNotNone(snap["poisonedBy"])
            self.assertEqual(snap["poisonedBy"]["modelId"], "camstack-yunet-2023mar")
            self.assertEqual(snap["timedOut"], 1)
            h.release.set()

        asyncio.run(scenario())

    def test_a_poisoned_worker_refuses_further_loads_at_once(self) -> None:
        async def scenario() -> None:
            h = _Harness(timeout_sec=0.2)
            await h.router.submit(1, _load_cmd())
            await h.wait_for_reply(1, timeout=2.0)
            await h.router.submit(2, _load_cmd(1, "/models/openvino/camstack-scrfd.xml"))
            refused = await h.wait_for_reply(2, timeout=0.5)
            self.assertEqual(refused["status"], "error")
            self.assertEqual(refused["reason"], "worker-poisoned")
            self.assertEqual(refused["modelId"], "camstack-scrfd")
            # Round 2: the refusal reports how long the EARLIER compile has
            # run, so the host's hard bound counts from its start.
            self.assertGreaterEqual(refused["compileElapsedMs"], 200)
            self.assertTrue(refused["poisoned"])
            # The second compile was never STARTED behind the stuck one.
            self.assertEqual(h.load_calls, [YUNET])
            h.release.set()

        asyncio.run(scenario())

    def test_a_slow_compile_finishes_writes_its_cache_and_the_next_load_is_warm(self) -> None:
        """Fix round 1, item 1(b): a slow but FINITE compile is not killed by
        its own timeout. It runs on, writes its cache, and hands the worker
        its loads back — so the retry is a warm hit instead of the same cold
        compile timing out again on a respawned worker, three times, to
        `failed`."""

        async def scenario() -> None:
            cache: set[str] = set()
            release = threading.Event()
            loads: list[str] = []

            def load_fn(slot: ModelSlot, config: dict) -> None:
                path = config["path"]
                if path in cache:
                    loads.append("warm")
                else:
                    loads.append("cold")
                    release.wait(5.0)
                    cache.add(path)  # what OpenVINO's CACHE_DIR write does
                slot.config = dict(config)
                slot.loaded = True

            h = _Harness(timeout_sec=0.2)
            h.loader = ModelLoader(timeout_sec=0.2, load_fn=load_fn, notify=h.loader._notify)
            h.router = CommandRouter(h.models, h.loader, h.router._send, h.router._inline)

            await h.router.submit(1, _load_cmd())
            timed_out = await h.wait_for_reply(1, timeout=2.0)
            self.assertEqual(timed_out["reason"], "compile-timeout")
            release.set()  # the compile finishes at "130 s"
            for _ in range(100):
                if h.events:
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(len(h.events), 1)
            self.assertEqual(h.loader._pending_notifications, set())
            self.assertEqual(h.events[0]["event"], "compile-finished-late")
            self.assertEqual(h.events[0]["modelId"], "camstack-yunet-2023mar")
            self.assertTrue(h.events[0]["ok"])
            self.assertIn(YUNET, cache)
            self.assertIsNone(h.loader.snapshot()["poisonedBy"])

            await h.router.submit(2, _load_cmd())
            warm = await h.wait_for_reply(2, timeout=1.0)
            self.assertEqual(warm["status"], "ok")
            self.assertEqual(loads, ["cold", "warm"])
            self.assertTrue(h.models[0].loaded)

        asyncio.run(scenario())

    def test_a_compile_that_returns_after_the_bound_is_never_installed(self) -> None:
        async def scenario() -> None:
            h = _Harness(timeout_sec=0.2)
            await h.router.submit(1, _load_cmd())
            await h.wait_for_reply(1, timeout=2.0)
            h.release.set()
            await asyncio.sleep(0.2)
            self.assertFalse(h.models[0].loaded)
            self.assertIsNone(h.loader.snapshot()["inFlight"])

        asyncio.run(scenario())

    def test_a_load_that_raises_is_an_error_not_a_poisoning(self) -> None:
        async def scenario() -> None:
            h = _Harness(timeout_sec=5.0, block=False)

            def failing(slot: ModelSlot, config: dict) -> None:
                raise RuntimeError("compile on GPU failed: CL_OUT_OF_RESOURCES")

            h.loader = ModelLoader(timeout_sec=5.0, load_fn=failing)
            h.router = CommandRouter(h.models, h.loader, h.router._send, h.router._inline)
            await h.router.submit(1, _load_cmd())
            reply = await h.wait_for_reply(1)
            self.assertEqual(reply["status"], "error")
            self.assertNotIn("reason", reply)
            self.assertIn("CL_OUT_OF_RESOURCES", reply["error"])
            self.assertIsNone(h.loader.snapshot()["poisonedBy"])

        asyncio.run(scenario())


class ALoadThatReturnsAtTheBound(unittest.TestCase):
    """Release review: a load returning exactly as the bound fires must be one
    outcome or the other — never a finished load with a worker poisoned
    forever for it."""

    def test_the_thread_claims_first_so_the_load_counts_as_in_time(self) -> None:
        async def scenario() -> None:
            loaded: list[str] = []

            def load_fn(slot: ModelSlot, config: dict) -> None:
                slot.config = dict(config)
                slot.loaded = True
                loaded.append(config["path"])

            loader = ModelLoader(timeout_sec=0.05, load_fn=load_fn)
            # Hold the thread in the race window — outcome claimed, settle
            # not yet scheduled — until well past the bound.
            loader._after_claim = lambda: time.sleep(0.3)
            slot = ModelSlot()
            await loader.load(slot, {"path": YUNET}, 0)
            self.assertTrue(slot.loaded)
            self.assertIsNone(loader.snapshot()["poisonedBy"])
            self.assertEqual(loader.snapshot()["timedOut"], 0)
            self.assertEqual(loader.snapshot()["completed"], 1)

        asyncio.run(scenario())


class TheLateNotificationIsKeptAlive(unittest.TestCase):
    """Round 2: the loop holds `ensure_future` tasks only weakly; the loader
    must hold the notification until it has been sent."""

    def test_the_pending_notification_is_referenced_until_sent(self) -> None:
        async def scenario() -> None:
            gate = asyncio.Event()
            sent: list[dict] = []

            async def notify(event: dict) -> None:
                await gate.wait()
                sent.append(event)

            release = threading.Event()

            def load_fn(slot: ModelSlot, config: dict) -> None:
                release.wait(5.0)

            loader = ModelLoader(timeout_sec=0.1, load_fn=load_fn, notify=notify)
            with self.assertRaises(Exception):
                await loader.load(ModelSlot(), {"path": YUNET}, 0)
            release.set()
            for _ in range(100):
                if loader.finished_late:
                    break
                await asyncio.sleep(0.01)
            await asyncio.sleep(0.01)
            self.assertEqual(len(loader._pending_notifications), 1)
            gate.set()
            for _ in range(100):
                if sent:
                    break
                await asyncio.sleep(0.01)
            self.assertEqual(len(sent), 1)
            self.assertEqual(loader._pending_notifications, set())

        asyncio.run(scenario())


class ReplaceKeepsTheOldModel(unittest.TestCase):
    """Fix round 1, item 6: the old model serves until the new one is in."""

    def _loaded_old(self, h: "_Harness") -> ModelSlot:
        old = ModelSlot()
        old.config = {"path": "/models/old.xml"}
        old.loaded = True
        h.models.append(old)
        return old

    def test_a_replace_that_times_out_leaves_the_old_model_serving(self) -> None:
        async def scenario() -> None:
            h = _Harness(timeout_sec=0.2)
            old = self._loaded_old(h)
            await h.router.submit(1, {"cmd": "replace", "index": 0, "config": {"path": YUNET}})
            # While the new one compiles, the old one is still the slot.
            await asyncio.sleep(0.05)
            self.assertIs(h.models[0], old)
            self.assertTrue(old.loaded)
            reply = await h.wait_for_reply(1, timeout=2.0)
            self.assertEqual(reply["reason"], "compile-timeout")
            self.assertIs(h.models[0], old)
            self.assertTrue(old.loaded)
            h.release.set()

        asyncio.run(scenario())

    def test_a_replace_that_fails_leaves_the_old_model_serving(self) -> None:
        async def scenario() -> None:
            h = _Harness(timeout_sec=5.0)

            def failing(slot: ModelSlot, config: dict) -> None:
                raise RuntimeError("compile failed")

            h.loader = ModelLoader(timeout_sec=5.0, load_fn=failing)
            h.router = CommandRouter(h.models, h.loader, h.router._send, h.router._inline)
            old = self._loaded_old(h)
            await h.router.submit(1, {"cmd": "replace", "index": 0, "config": {"path": YUNET}})
            reply = await h.wait_for_reply(1)
            self.assertEqual(reply["status"], "error")
            self.assertIs(h.models[0], old)
            self.assertTrue(old.loaded)

        asyncio.run(scenario())

    def test_a_successful_replace_swaps_without_mutating_the_old_slot(self) -> None:
        async def scenario() -> None:
            h = _Harness(timeout_sec=5.0, block=False)
            old = self._loaded_old(h)
            await h.router.submit(1, {"cmd": "replace", "index": 0, "config": {"path": YUNET}})
            reply = await h.wait_for_reply(1)
            self.assertEqual(reply["status"], "ok")
            self.assertIsNot(h.models[0], old)
            self.assertEqual(h.models[0].config["path"], YUNET)
            # A predict already holding the old slot finishes normally.
            self.assertTrue(old.loaded)

        asyncio.run(scenario())


class TheBoundComesFromTheHost(unittest.TestCase):
    def test_the_host_declared_bound_wins(self) -> None:
        self.assertEqual(_model_load_timeout_sec({"modelLoadTimeoutMs": 45_000}), 45.0)

    def test_an_old_host_gets_the_default(self) -> None:
        self.assertEqual(_model_load_timeout_sec({}), MODEL_LOAD_TIMEOUT_SEC)
        self.assertEqual(_model_load_timeout_sec({"modelLoadTimeoutMs": "x"}), MODEL_LOAD_TIMEOUT_SEC)
        self.assertEqual(_model_load_timeout_sec({"modelLoadTimeoutMs": 0}), MODEL_LOAD_TIMEOUT_SEC)


if __name__ == "__main__":
    unittest.main()
