"""A command fails fast instead of riding alexapy's 90-120 s retry; backoff lines reach stderr."""

from __future__ import annotations

import asyncio
import io
import logging
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import alexa_gateway
from alexa_logging import configure_logging
from test_alexa_gateway_echo import install_fake


class CommandTimeoutTests(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = alexa_gateway.COMMAND_TIMEOUT_S
        alexa_gateway.COMMAND_TIMEOUT_S = 0.05

    def tearDown(self) -> None:
        alexa_gateway.COMMAND_TIMEOUT_S = self._saved
        sys.modules.pop("alexapy", None)

    def _stall(self, gateway, name: str) -> None:
        async def forever(*_a, **_k):
            await asyncio.sleep(30)  # alexapy backing off a 429

        import alexapy

        setattr(alexapy.AlexaAPI, name, forever)

    def test_set_volume_gives_up_instead_of_retrying_for_minutes(self) -> None:
        gateway, _ = install_fake()
        self._stall(gateway, "run_behavior")
        with self.assertRaisesRegex(RuntimeError, "did not accept the volume"):
            asyncio.run(gateway.set_volume("s1", 30))

    def test_np_command_gives_up_too(self) -> None:
        gateway, _ = install_fake()
        self._stall(gateway, "set_media")
        with self.assertRaisesRegex(RuntimeError, "did not accept the media command"):
            asyncio.run(gateway.np_command("s1", "play"))

    def test_a_stalled_command_releases_the_per_device_lock(self) -> None:
        gateway, calls = install_fake()
        self._stall(gateway, "run_behavior")

        async def go():
            with self.assertRaises(RuntimeError):
                await gateway.set_volume("s1", 30)
            await gateway.np_command("s1", "play")

        asyncio.run(go())
        self.assertEqual(len(calls["media"]), 1)


class LoggingTests(unittest.TestCase):
    def test_backoff_lines_pass_and_other_alexapy_records_do_not(self) -> None:
        stream = io.StringIO()
        handler = configure_logging(stream)
        try:
            log = logging.getLogger("alexapy.alexaapi")
            log.info("Backing off _request(...) for 1.2s (AlexapyTooManyRequestsError: 429)")
            log.info("cookie=SECRET csrf=SECRET")
            log.warning("HTTP (URL: https://x/?token=SECRET) error status 500")
            logging.getLogger("camstack.worker").warning("our own warning")
        finally:
            logging.getLogger().removeHandler(handler)
        out = stream.getvalue()
        self.assertIn("Backing off _request(...)", out)
        self.assertIn("our own warning", out)
        self.assertNotIn("SECRET", out)


if __name__ == "__main__":
    unittest.main()
