"""Echo media ops with a mocked AlexaAPI. These tests must not contact Amazon."""

from __future__ import annotations

import asyncio
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from alexa_gateway import AlexaPyGateway, RateLimitedError
from alexa_protocol import Session


class AlexapyTooManyRequestsError(Exception):
    pass


def run(coro):
    return asyncio.run(coro)


def install_fake(state=None, dnd=None, raises=None):
    calls: dict = {"behaviors": [], "media": [], "dnd_set": [], "state_for": [], "active": 0, "max_active": 0}

    class FakeAPI:
        def __init__(self, device, login):
            self.device = device

        async def get_state(self):
            calls["active"] += 1
            calls["max_active"] = max(calls["max_active"], calls["active"])
            await asyncio.sleep(0.01)
            calls["active"] -= 1
            calls["state_for"].append((self.device.device_serial_number, self.device._device_type))
            if raises:
                raise raises
            return state

        async def set_media(self, data):
            if raises:
                raise raises
            calls["media"].append((self.device.device_serial_number, data))

        async def set_dnd_state(self, enabled):
            if raises:
                raise raises
            calls["dnd_set"].append((self.device.device_serial_number, enabled))

        async def run_behavior(self, node, queue_delay=0):
            if raises:
                raise raises
            calls["behaviors"].append(node)

        @staticmethod
        async def get_dnd_state(login):
            if raises:
                raise raises
            return dnd

    package = types.ModuleType("alexapy")
    package.AlexaAPI = FakeAPI
    package.AlexaLogin = object
    sys.modules["alexapy"] = package
    gateway = AlexaPyGateway()
    gateway._login = object()
    gateway._devices = [{"id": "s1", "deviceType": "T1", "customerId": "c1"}]
    return gateway, calls


class EchoMediaTests(unittest.TestCase):
    def tearDown(self) -> None:
        sys.modules.pop("alexapy", None)

    def test_player_state_returns_the_raw_player_info(self) -> None:
        gateway, calls = install_fake(state={"playerInfo": {"state": "PLAYING", "volume": {"volume": 30}}})
        result = run(gateway.player_state("s1", "T1"))
        self.assertEqual(result["playerInfo"]["state"], "PLAYING")
        self.assertEqual(calls["state_for"], [("s1", "T1")])

    def test_a_missing_body_is_an_error_never_an_idle_player(self) -> None:
        gateway, _ = install_fake(state=None)
        with self.assertRaises(RuntimeError):
            run(gateway.player_state("s1", "T1"))

    def test_a_429_is_a_typed_error_through_the_protocol(self) -> None:
        gateway, _ = install_fake(raises=AlexapyTooManyRequestsError("Too Many Requests"))
        response = run(Session(gateway).handle({"id": "1", "op": "player_state", "serial": "s1", "deviceType": "T1"}))
        self.assertFalse(response["ok"])
        self.assertEqual(response["code"], "rate-limited")
        with self.assertRaises(RateLimitedError):
            run(gateway.dnd_state())

    def test_requests_for_one_serial_never_overlap(self) -> None:
        gateway, calls = install_fake(state={"playerInfo": {}})

        async def both():
            await asyncio.gather(gateway.player_state("s1", "T1"), gateway.player_state("s1", "T1"))

        run(both())
        self.assertEqual(calls["max_active"], 1)

    def test_np_command_maps_the_four_commands_and_refuses_others(self) -> None:
        gateway, calls = install_fake()
        for name in ("play", "pause", "next", "previous"):
            run(gateway.np_command("s1", name))
        self.assertEqual(
            [data["type"] for _, data in calls["media"]],
            ["PlayCommand", "PauseCommand", "NextCommand", "PreviousCommand"],
        )
        with self.assertRaises(ValueError):
            run(gateway.np_command("s1", "rewind"))

    def test_set_volume_posts_the_volume_behaviour_clamped(self) -> None:
        gateway, calls = install_fake()
        run(gateway.set_volume("s1", 140))
        node = calls["behaviors"][0]
        self.assertEqual(node["type"], "Alexa.DeviceControls.Volume")
        self.assertEqual(node["operationPayload"]["value"], 100)
        self.assertEqual(node["operationPayload"]["deviceSerialNumber"], "s1")

    def test_dnd_state_is_one_call_for_every_device(self) -> None:
        gateway, _ = install_fake(
            dnd={
                "doNotDisturbDeviceStatusList": [
                    {"deviceSerialNumber": "s1", "enabled": True},
                    {"deviceSerialNumber": "s2", "enabled": False},
                    {"deviceSerialNumber": "s3"},
                ]
            }
        )
        result = run(gateway.dnd_state())
        self.assertEqual(result["devices"], [{"serial": "s1", "enabled": True}, {"serial": "s2", "enabled": False}])

    def test_set_dnd_goes_to_the_device(self) -> None:
        gateway, calls = install_fake()
        run(gateway.set_dnd("s1", True))
        self.assertEqual(calls["dnd_set"], [("s1", True)])

    def test_an_unknown_echo_is_refused(self) -> None:
        gateway, _ = install_fake()
        with self.assertRaises(ValueError):
            run(gateway.set_volume("nope", 10))


if __name__ == "__main__":
    unittest.main()
