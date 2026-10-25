"""Unit tests for WebGPU process isolation (no real ORT/WebGPU required)."""
from __future__ import annotations

import io
import pickle
import struct
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import webgpu_isolated as wi  # noqa: E402


class FramingTests(unittest.TestCase):
    def test_roundtrip(self) -> None:
        buf = io.BytesIO()
        payload = {"cmd": "predict", "inputs": {"x": [1, 2, 3]}}
        wi._write_msg(buf, payload)
        buf.seek(0)
        self.assertEqual(wi._read_msg(buf), payload)

    def test_eof(self) -> None:
        with self.assertRaises(EOFError):
            wi._read_msg(io.BytesIO(b""))

    def test_short_reads_are_assembled(self) -> None:
        """Pipe read() may return short; framing must loop until n bytes."""
        payload = pickle.dumps({"ok": True, "n": 42}, protocol=pickle.HIGHEST_PROTOCOL)
        frame = struct.pack(">I", len(payload)) + payload

        class ShortReader:
            def __init__(self) -> None:
                self._data = frame
                self._i = 0

            def read(self, n: int) -> bytes:
                # At most 3 bytes per call.
                take = min(3, n, len(self._data) - self._i)
                chunk = self._data[self._i : self._i + take]
                self._i += take
                return chunk

        self.assertEqual(wi._read_msg(ShortReader()), {"ok": True, "n": 42})


class IsolatedSessionTests(unittest.TestCase):
    def test_open_load_predict_close(self) -> None:
        replies = [
            {
                "ok": True,
                "providers": ["WebGpuExecutionProvider", "CPUExecutionProvider"],
                "input_name": "images",
                "input_shape": [1, 3, 640, 640],
                "input_type": "tensor(float)",
                "output_names": ["output0"],
            },
            {"ok": True, "outputs": {"output0": [[0.1, 0.2]]}},
            {"ok": True},
        ]
        written: list = []
        resp_buf = bytearray()

        class FakeIpcOut:
            def write(self, b: bytes) -> int:
                # Parse complete frames as they arrive and enqueue replies.
                if not hasattr(self, "_req"):
                    self._req = bytearray()
                self._req.extend(b)
                while len(self._req) >= 4:
                    (size,) = struct.unpack(">I", self._req[:4])
                    if len(self._req) < 4 + size:
                        break
                    msg = pickle.loads(bytes(self._req[4 : 4 + size]))
                    del self._req[: 4 + size]
                    written.append(msg)
                    reply = pickle.dumps(replies.pop(0))
                    resp_buf.extend(struct.pack(">I", len(reply)))
                    resp_buf.extend(reply)
                return len(b)

            def flush(self) -> None:
                pass

            def close(self) -> None:
                pass

        class FakeIpcIn:
            def read(self, n: int) -> bytes:
                chunk = bytes(resp_buf[:n])
                del resp_buf[:n]
                return chunk

            def close(self) -> None:
                pass

        proc = MagicMock()
        proc.pid = 4242
        proc.poll.return_value = None
        proc.wait.return_value = 0

        fake_out = FakeIpcOut()
        fake_in = FakeIpcIn()
        pipes = iter([(10, 11), (12, 13)])

        def fake_pipe() -> tuple[int, int]:
            return next(pipes)

        with (
            patch("webgpu_isolated.os.pipe", side_effect=fake_pipe),
            patch("webgpu_isolated.os.close"),
            patch("webgpu_isolated.os.fdopen", side_effect=[fake_out, fake_in]),
            patch("webgpu_isolated.subprocess.Popen", return_value=proc),
        ):
            sess = wi.WebGpuIsolatedSession.open("/tmp/model.onnx", python_exe="python3")
        self.assertEqual(sess.input_name, "images")
        self.assertEqual(written[0]["cmd"], "load")
        out = sess.run({"images": [[1.0]]})
        self.assertEqual(out["output0"], [[0.1, 0.2]])
        self.assertEqual(written[1]["cmd"], "predict")
        sess.close()
        self.assertEqual(written[2]["cmd"], "shutdown")

    def test_load_failure_kills_child(self) -> None:
        reply = pickle.dumps({"ok": False, "error": "boom"})
        frame = struct.pack(">I", len(reply)) + reply

        class FakeIpcOut:
            def write(self, b: bytes) -> int:
                return len(b)

            def flush(self) -> None:
                pass

            def close(self) -> None:
                pass

        class FakeIpcIn:
            def __init__(self) -> None:
                self._data = frame
                self._i = 0

            def read(self, n: int) -> bytes:
                chunk = self._data[self._i : self._i + n]
                self._i += n
                return chunk

            def close(self) -> None:
                pass

        proc = MagicMock()
        proc.pid = 1
        proc.poll.return_value = None
        proc.wait.return_value = 0
        pipes = iter([(10, 11), (12, 13)])

        with (
            patch("webgpu_isolated.os.pipe", side_effect=lambda: next(pipes)),
            patch("webgpu_isolated.os.close"),
            patch("webgpu_isolated.os.fdopen", side_effect=[FakeIpcOut(), FakeIpcIn()]),
            patch("webgpu_isolated.subprocess.Popen", return_value=proc),
        ):
            with self.assertRaises(RuntimeError) as ctx:
                wi.WebGpuIsolatedSession.open("/tmp/x.onnx")
        self.assertIn("boom", str(ctx.exception))
        proc.kill.assert_called()


class _FakeEpDevice:
    ep_name = "WebGpuExecutionProvider"


class _FakeSessionOptions:
    def __init__(self) -> None:
        self.intra_op_num_threads = 0
        self.devices: list = []

    def add_provider_for_devices(self, devices, options) -> None:
        self.devices = list(devices)


class _FakeSession:
    def __init__(self, path: str, sess_options=None, providers=None) -> None:
        self.path = path
        self.sess_options = sess_options
        self._providers = (
            list(providers)
            if providers is not None
            else ["WebGpuExecutionProvider", "CPUExecutionProvider"]
        )

    def get_providers(self) -> list[str]:
        return self._providers


class _FakeOrt:
    """Mirrors the one ORT behaviour that matters: a second registration RAISES."""

    SessionOptions = _FakeSessionOptions
    InferenceSession = _FakeSession

    def __init__(self) -> None:
        self.register_calls = 0

    def register_execution_provider_library(self, name: str, path: str) -> None:
        self.register_calls += 1
        if self.register_calls > 1:
            raise RuntimeError(f"EP library is already registered under {name}")

    def get_ep_devices(self) -> list:
        return [_FakeEpDevice()]


class LoaderTests(unittest.TestCase):
    """D845: register once per process; refuse a render node that cannot be opened."""

    def setUp(self) -> None:
        wi._webgpu_registered = False
        fake_plugin = MagicMock()
        fake_plugin.get_library_path.return_value = "/fake/libwebgpu_ep.so"
        fake_plugin.get_ep_name.return_value = "WebGpuExecutionProvider"
        self._plugin_patch = patch.dict(sys.modules, {"onnxruntime_ep_webgpu": fake_plugin})
        self._plugin_patch.start()

    def tearDown(self) -> None:
        self._plugin_patch.stop()
        wi._webgpu_registered = False

    def test_registers_the_plugin_once_across_sessions(self) -> None:
        ort = _FakeOrt()
        s1, p1 = wi.load_onnx_webgpu_session(ort, "/m/a.onnx", render_node_ok=True)
        s2, p2 = wi.load_onnx_webgpu_session(ort, "/m/b.onnx", render_node_ok=True)
        self.assertEqual(ort.register_calls, 1)
        self.assertEqual(p1, ["WebGpuExecutionProvider", "CPUExecutionProvider"])
        self.assertEqual(p2, p1)
        # Both sessions were placed on the WebGPU device, not the CPU fallback.
        self.assertEqual(len(s1.sess_options.devices), 1)
        self.assertEqual(len(s2.sess_options.devices), 1)

    def test_a_registration_that_raises_is_a_cpu_fallback_not_a_crash(self) -> None:
        """Disarm check: without the guard the second load re-registers and the
        fake raises — the loader must then hand back CPU providers, never a
        WebGPU session built on a poisoned registration."""
        ort = _FakeOrt()
        wi.load_onnx_webgpu_session(ort, "/m/a.onnx", render_node_ok=True)
        wi._webgpu_registered = False  # simulate the pre-D845 loader forgetting
        _, providers = wi.load_onnx_webgpu_session(ort, "/m/b.onnx", render_node_ok=True)
        self.assertEqual(ort.register_calls, 2)
        self.assertEqual(providers, [wi.ONNX_CPU_EP])

    def test_bounds_the_cpu_thread_pool(self) -> None:
        ort = _FakeOrt()
        session, _ = wi.load_onnx_webgpu_session(ort, "/m/a.onnx", render_node_ok=True)
        self.assertEqual(session.sess_options.intra_op_num_threads, wi.WEBGPU_INTRA_OP_THREADS)

    def test_refuses_without_an_openable_render_node(self) -> None:
        ort = _FakeOrt()
        with self.assertRaises(wi.WebGpuDeviceUnavailable) as ctx:
            wi.load_onnx_webgpu_session(ort, "/m/a.onnx", render_node_ok=False)
        self.assertIn("/dev/dri/renderD", str(ctx.exception))
        self.assertIn("uid=", str(ctx.exception))
        self.assertEqual(ort.register_calls, 0)

    def test_no_render_node_check_outside_linux(self) -> None:
        ort = _FakeOrt()
        with patch.object(wi, "render_node_accessible", return_value=None):
            _, providers = wi.load_onnx_webgpu_session(ort, "/m/a.onnx")
        self.assertEqual(providers[0], "WebGpuExecutionProvider")


class RenderNodeProbeTests(unittest.TestCase):
    def test_non_linux_is_not_checked(self) -> None:
        self.assertIsNone(wi.render_node_accessible(platform="darwin"))

    def test_missing_dir_or_no_nodes(self) -> None:
        def missing(_: str) -> list[str]:
            raise FileNotFoundError

        self.assertFalse(wi.render_node_accessible(platform="linux", listdir=missing))
        self.assertFalse(
            wi.render_node_accessible(platform="linux", listdir=lambda _: ["card1", "by-path"])
        )

    def test_denied_node_is_false_and_granted_is_true(self) -> None:
        def nodes(_: str) -> list[str]:
            return ["card1", "renderD128"]

        self.assertFalse(
            wi.render_node_accessible(platform="linux", listdir=nodes, access=lambda p, m: False)
        )
        seen: list[str] = []

        def grant(p: str, m: int) -> bool:
            seen.append(p)
            return True

        self.assertTrue(wi.render_node_accessible(platform="linux", listdir=nodes, access=grant))
        self.assertEqual(seen, ["/dev/dri/renderD128"])


if __name__ == "__main__":
    unittest.main()
