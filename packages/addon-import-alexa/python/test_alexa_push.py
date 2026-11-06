"""The push channel parses alexapy's HTTP/2 messages and forwards them, with a fake client.

No network, no alexapy: the client the channel opens is a fake that the test drives.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import alexa_push
from alexa_push import PushChannel, parse_push_message, reconnect_delay_s
from test_alexa_gateway import install_fake_alexapy, remove_fake_alexapy


def message(command: str, payload: dict) -> dict:
    resource = {"command": command, "payload": json.dumps(payload)}
    return {"directive": {"payload": {"renderingUpdates": [{"resourceMetadata": json.dumps(resource)}]}}}


def volume_message(serial: str) -> dict:
    return message("PUSH_VOLUME_CHANGE", {"dopplerId": {"deviceSerialNumber": serial}, "volumeSetting": 30})


class ParseTests(unittest.TestCase):
    def test_reads_command_and_serial_from_the_doppler_id(self) -> None:
        self.assertEqual(
            parse_push_message(volume_message("S1")),
            [{"push": "event", "command": "PUSH_VOLUME_CHANGE", "serial": "S1"}],
        )

    def test_reads_the_serial_from_a_key_entry_id(self) -> None:
        events = parse_push_message(message("PUSH_NOTIFICATION_CHANGE", {"key": {"entryId": "a#b#SERIAL9"}}))
        self.assertEqual(events[0]["serial"], "SERIAL9")

    def test_an_event_without_a_serial_keeps_none_and_never_carries_the_payload(self) -> None:
        events = parse_push_message(message("PUSH_EQUALIZER_STATE_CHANGE", {"bass": 1}))
        self.assertEqual(events, [{"push": "event", "command": "PUSH_EQUALIZER_STATE_CHANGE", "serial": None}])

    def test_garbage_is_skipped_not_raised(self) -> None:
        for bad in (None, [], {}, {"directive": {"payload": {"renderingUpdates": [1, {"resourceMetadata": "{"}]}}}):
            self.assertEqual(parse_push_message(bad), [])

    def test_the_delay_doubles_and_is_bounded(self) -> None:
        self.assertEqual([reconnect_delay_s(n) for n in (0, 1, 2)], [5, 10, 20])
        self.assertEqual(reconnect_delay_s(50), alexa_push.RECONNECT_MAX_S)


class FakeClient:
    """Stands in for HTTP2EchoClient; `script` decides what each connection does."""

    instances: list["FakeClient"] = []

    def __init__(self, login, msg_cb, open_cb, close_cb, error_cb) -> None:
        self.msg_cb, self.open_cb, self.close_cb = msg_cb, open_cb, close_cb
        self.closed_by_channel = False
        FakeClient.instances.append(self)

    async def async_run(self) -> None:
        index = len(FakeClient.instances) - 1
        if index == 0:
            await self.open_cb()
            await self.msg_cb(volume_message("S1"))
            await self.close_cb()
        elif index == 1:
            raise RuntimeError("HTTP2 open timeout")
        else:
            await self.open_cb()
            await self.msg_cb(volume_message("S2"))
            await asyncio.sleep(3600)

    def on_close(self, _reason=None) -> None:
        self.closed_by_channel = True


class ChannelTests(unittest.TestCase):
    def test_forwards_events_and_reconnects_with_a_bounded_delay(self) -> None:
        FakeClient.instances = []
        lines: list[dict] = []
        sleeps: list[float] = []

        async def fake_sleep(seconds: float) -> None:
            sleeps.append(seconds)
            await asyncio.sleep(0)

        async def scenario() -> None:
            channel = PushChannel(object(), lines.append, FakeClient, fake_sleep)
            channel.start()
            for _ in range(50):
                await asyncio.sleep(0)
            channel.stop()

        asyncio.run(scenario())
        kinds = [(line["push"], line.get("state") or line.get("command"), line.get("serial")) for line in lines]
        self.assertEqual(
            kinds,
            [
                ("channel", "up", None),
                ("event", "PUSH_VOLUME_CHANGE", "S1"),
                ("channel", "down", None),  # first stream ended
                ("channel", "down", None),  # second attempt never opened
                ("channel", "up", None),  # third connected
                ("event", "PUSH_VOLUME_CHANGE", "S2"),
            ],
        )
        self.assertEqual(sleeps[:2], [5, 10])
        self.assertTrue(all(client.closed_by_channel for client in FakeClient.instances[:2]))
        self.assertEqual(lines[3]["reason"], "RuntimeError: HTTP2 open timeout")
        self.assertEqual(lines[3]["retryInMs"], 10_000)


class FlapClient:
    """Opens and closes at once, or returns without doing either."""

    mode = "flap"
    made = 0
    hold = 0.0
    now = [0.0]

    def __init__(self, login, msg_cb, open_cb, close_cb, error_cb) -> None:
        self.open_cb, self.close_cb = open_cb, close_cb
        FlapClient.made += 1

    async def async_run(self) -> None:
        if FlapClient.mode == "flap":
            await self.open_cb()
            FlapClient.now[0] += FlapClient.hold  # how long the stream stayed up
            await self.close_cb()
        # mode "silent": returns with neither open nor close

    def on_close(self, _reason=None) -> None:
        pass


class BackoffTests(unittest.TestCase):
    def run_channel(self, mode: str, hold: float, passes: int = 40) -> tuple[list[dict], list[float]]:
        FlapClient.mode, FlapClient.made, FlapClient.hold = mode, 0, hold
        FlapClient.now = now = [0.0]
        lines: list[dict] = []
        sleeps: list[float] = []

        async def fake_sleep(seconds: float) -> None:
            sleeps.append(seconds)
            await asyncio.sleep(0)

        async def scenario() -> None:
            channel = PushChannel(object(), lines.append, FlapClient, fake_sleep, lambda: now[0])
            channel.start()
            for _ in range(passes):
                await asyncio.sleep(0)
            channel.stop()

        asyncio.run(scenario())
        return lines, sleeps

    def test_a_stream_that_opens_and_closes_at_once_keeps_backing_off(self) -> None:
        _, sleeps = self.run_channel("flap", hold=0.0)
        self.assertEqual(sleeps[:5], [5, 10, 20, 40, 80])

    def test_the_backoff_starts_over_only_after_a_stable_stretch(self) -> None:
        _, sleeps = self.run_channel("flap", hold=alexa_push.STABLE_UP_S + 1)
        self.assertEqual(sleeps[:3], [5, 5, 5])

    def test_a_client_that_returns_without_opening_is_retried_and_reported_down(self) -> None:
        lines, sleeps = self.run_channel("silent", hold=0.0)
        self.assertGreaterEqual(FlapClient.made, 2)
        self.assertEqual(sleeps[:2], [5, 10])
        self.assertEqual(lines[0]["state"], "down")
        self.assertEqual(lines[0]["reason"], "stream ended before opening")


class GatewayPushTests(unittest.TestCase):
    def tearDown(self) -> None:
        remove_fake_alexapy()

    def test_a_good_sign_in_opens_the_channel_with_the_same_login(self) -> None:
        from alexa_gateway import AlexaPyGateway

        install_fake_alexapy()
        FakeClient.instances = []
        seen: list[object] = []
        lines: list[dict] = []
        original = alexa_push.default_client_factory

        def factory(login, *callbacks):
            seen.append(login)
            return FakeClient(login, *callbacks)

        alexa_push.default_client_factory = factory

        async def scenario() -> AlexaPyGateway:
            gateway = AlexaPyGateway(lines.append)
            with tempfile.TemporaryDirectory() as directory:
                await gateway.login_broker("alexa_001", "tok", "App", "amazon.it", "EU", str(Path(directory) / "s"))
            for _ in range(10):
                await asyncio.sleep(0)
            return gateway

        try:
            gateway = asyncio.run(scenario())
        finally:
            alexa_push.default_client_factory = original
        self.assertIs(seen[0], gateway._login)
        self.assertEqual(lines[0]["push"], "channel")

    def test_no_emitter_means_no_channel(self) -> None:
        from alexa_gateway import AlexaPyGateway

        install_fake_alexapy()

        async def scenario() -> AlexaPyGateway:
            gateway = AlexaPyGateway()
            with tempfile.TemporaryDirectory() as directory:
                await gateway.login_broker("alexa_001", "tok", "App", "amazon.it", "EU", str(Path(directory) / "s"))
            return gateway

        self.assertIsNone(asyncio.run(scenario())._push)


if __name__ == "__main__":
    unittest.main()
