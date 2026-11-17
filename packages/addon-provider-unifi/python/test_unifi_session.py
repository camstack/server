"""The UniFi worker session against aiounifi 85's own request builders and message handling.

The controller is a REAL aiounifi `Controller` whose `request` is replaced: what reaches the
console is what aiounifi built (the PoE override list above all), and websocket frames go
through aiounifi's own message handler.

Run: python -m unittest test_unifi_session (with aiounifi installed).
"""

from __future__ import annotations

import asyncio
import copy
import sys
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from aiounifi.controller import Controller
from aiounifi.errors import LoginRequired, TwoFaTokenRequired, Unauthorized
from aiounifi.models.configuration import Configuration

from unifi_session import UnifiSession, WorkerFailure, classify, normalize_device

SWITCH_ID = "64aa00000000000000000001"
SWITCH_MAC = "aa:bb:cc:00:00:01"


def port(idx: int, *, up: bool = True, mode: str = "auto", conf: str | None = None) -> dict:
    p: dict[str, Any] = {
        "port_idx": idx,
        "up": up,
        "speed": 1000 if up else 0,
        "port_poe": True,
        "poe_mode": mode,
        "poe_power": "2.50",
        "poe_voltage": "53.1",
        "poe_current": "47.0",
    }
    if conf is not None:
        p["portconf_id"] = conf
    return p


def switch(overrides: list[dict], ports: list[dict] | None = None) -> dict:
    return {
        "_id": SWITCH_ID,
        "device_id": SWITCH_ID,
        "mac": SWITCH_MAC,
        "type": "usw",
        "model": "USL8LP",
        "name": "Rack switch",
        "state": 1,
        "uptime": 1000,
        "num_sta": 2,
        "system-stats": {"cpu": "7.5", "mem": "63.1", "uptime": "1000"},
        "port_overrides": overrides,
        "port_table": ports if ports is not None else [port(i) for i in range(1, 5)],
    }


CAMERA = {"mac": "11:22:33:44:55:66", "hostname": "cam", "is_wired": True, "sw_mac": SWITCH_MAC, "sw_port": 3}


class FakeConsole:
    """Answers aiounifi's requests from tables; records every write."""

    def __init__(self, devices: list[dict], clients: list[dict]) -> None:
        self.devices = devices
        self.clients = clients
        self.writes: list[tuple[str, str, Any]] = []
        self.calls: list[str] = []

    async def request(self, api_request: Any) -> dict:
        self.calls.append(api_request.path)
        if api_request.method == "get" and api_request.path == "/stat/device":
            return {"data": copy.deepcopy(self.devices)}
        if api_request.method == "get" and api_request.path == "/stat/sta":
            return {"data": copy.deepcopy(self.clients)}
        self.writes.append((api_request.method, api_request.path, copy.deepcopy(api_request.data)))
        return {"data": []}


def signed_in(console: FakeConsole, pushes: list[dict] | None = None) -> UnifiSession:
    controller = Controller(Configuration(MagicMock(), "console.example", username="u", password="p"))
    controller.request = console.request  # type: ignore[method-assign]
    session = UnifiSession((pushes if pushes is not None else []).append)
    session.controller = controller
    return session


class PoePreservesOtherPorts(unittest.TestCase):
    def test_switching_one_port_keeps_every_other_override_whole(self) -> None:
        others = [
            {"port_idx": 1, "name": "Uplink", "poe_mode": "off", "portconf_id": "conf-a", "stp_port_mode": True},
            {"port_idx": 2, "name": "Doorbell", "poe_mode": "auto", "op_mode": "switch"},
        ]
        console = FakeConsole([switch(others)], [CAMERA])
        session = signed_in(console)

        asyncio.run(session.set_poe(SWITCH_ID, 2, False))

        self.assertEqual(len(console.writes), 1)
        method, path, body = console.writes[0]
        self.assertEqual((method, path), ("put", f"/rest/device/{SWITCH_ID}"))
        self.assertEqual(
            body["port_overrides"],
            [others[0], {**others[1], "poe_mode": "off"}],
        )

    def test_a_port_without_override_is_appended_and_the_rest_survive(self) -> None:
        others = [{"port_idx": 1, "name": "Uplink", "poe_mode": "off"}]
        console = FakeConsole([switch(others)], [])
        session = signed_in(console)

        asyncio.run(session.set_poe(SWITCH_ID, 4, True))

        _, _, body = console.writes[0]
        self.assertEqual(body["port_overrides"], [others[0], {"port_idx": 4, "poe_mode": "auto"}])

    def test_the_device_is_read_fresh_so_an_override_added_since_the_poll_survives(self) -> None:
        console = FakeConsole([switch([])], [])
        session = signed_in(console)
        asyncio.run(session.list(True))  # the poll: no overrides yet
        added = {"port_idx": 1, "name": "Set in the console UI", "poe_mode": "auto"}
        console.devices = [switch([added])]

        asyncio.run(session.set_poe(SWITCH_ID, 3, False))

        _, _, body = console.writes[0]
        self.assertEqual(body["port_overrides"], [added, {"port_idx": 3, "poe_mode": "off"}])

    def test_a_port_the_device_does_not_have_is_refused_without_a_write(self) -> None:
        console = FakeConsole([switch([])], [])
        session = signed_in(console)
        with self.assertRaises(WorkerFailure) as caught:
            asyncio.run(session.set_poe(SWITCH_ID, 9, False))
        self.assertEqual(caught.exception.kind, "bad-request")
        self.assertEqual(console.writes, [])


class PortTable(unittest.TestCase):
    def test_poe_mode_readings_link_and_the_wired_client_per_port(self) -> None:
        console = FakeConsole([switch([], [port(1), port(3, mode="off"), port(4, up=False)])], [CAMERA])
        session = signed_in(console)
        snapshot = asyncio.run(session.list(True))
        ports = {p["idx"]: p for p in snapshot["devices"][0]["ports"]}
        self.assertEqual(ports[1]["poeOn"], True)
        self.assertEqual(ports[1]["poePowerW"], 2.5)
        self.assertEqual(ports[1]["poeVoltageV"], 53.1)
        self.assertAlmostEqual(ports[1]["poeCurrentA"], 0.047)
        self.assertEqual(ports[1]["speedMbps"], 1000)
        self.assertEqual(ports[3]["poeOn"], False)
        self.assertEqual(ports[3]["clientMac"], CAMERA["mac"])
        self.assertEqual(ports[3]["clientName"], "cam")
        self.assertEqual(ports[4]["linkUp"], False)
        self.assertIsNone(ports[4]["speedMbps"])
        self.assertEqual(snapshot["devices"][0]["id"], SWITCH_ID)
        self.assertEqual(snapshot["devices"][0]["cpuPercent"], 7.5)
        self.assertEqual(snapshot["devices"][0]["memoryPercent"], 63.1)


class DeviceIdentity(unittest.TestCase):
    def test_the_device_ip_and_serial_are_read_and_blank_is_none(self) -> None:
        device = normalize_device({"_id": "x", "mac": "F0:9F:C2:00:00:01", "ip": "192.0.2.10", "serial": "F09FC2000001"}, {})
        self.assertEqual(device["ip"], "192.0.2.10")
        self.assertEqual(device["serial"], "F09FC2000001")
        blank = normalize_device({"_id": "x", "mac": "f0:9f:c2:00:00:01", "serial": ""}, {})
        self.assertIsNone(blank["ip"])
        self.assertIsNone(blank["serial"])


class WebsocketEvents(unittest.TestCase):
    def test_a_device_sync_frame_pushes_the_new_link_state_without_a_poll(self) -> None:
        async def run() -> list[dict]:
            pushes: list[dict] = []
            console = FakeConsole([switch([])], [CAMERA])
            session = signed_in(console, pushes)
            await session.list(True)
            session._subscribe()
            calls_before = len(console.calls)
            frame = {"meta": {"rc": "ok", "message": "device:sync"},
                     "data": [switch([], [port(1), port(2), port(3, up=False), port(4)])]}
            session.controller.messages.handler(frame)
            await asyncio.sleep(0.4)
            self.assertEqual(len(console.calls), calls_before, "a websocket frame must not poll")
            return pushes

        pushes = asyncio.run(run())
        snapshots = [p for p in pushes if p.get("push") == "snapshot"]
        self.assertEqual(len(snapshots), 1)
        ports = {p["idx"]: p for p in snapshots[0]["devices"][0]["ports"]}
        self.assertEqual(ports[3]["linkUp"], False)

    def test_a_client_disconnect_event_drops_it_from_the_next_push(self) -> None:
        async def run() -> list[dict]:
            pushes: list[dict] = []
            session = signed_in(FakeConsole([switch([])], [CAMERA]), pushes)
            await session.list(True)
            session._subscribe()
            frame = {"meta": {"rc": "ok", "message": "events"},
                     "data": [{"key": "EVT_LU_Disconnected", "user": CAMERA["mac"], "msg": "gone",
                               "time": 1, "datetime": "2026-11-16T00:00:00Z"}]}
            session.controller.messages.handler(frame)
            await asyncio.sleep(0.4)
            return pushes

        pushes = asyncio.run(run())
        self.assertEqual(pushes[-1]["clients"], [])
        self.assertIsNone(pushes[-1]["devices"][0]["ports"][2]["clientMac"])


class SignInFailures(unittest.TestCase):
    def test_kinds(self) -> None:
        self.assertEqual(classify(Unauthorized()).kind, "auth")
        self.assertEqual(classify(LoginRequired("401")).kind, "auth")
        self.assertEqual(classify(TwoFaTokenRequired()).kind, "mfa")

    def test_a_499_answer_aiounifi_takes_for_success_is_a_second_factor(self) -> None:
        async def run() -> WorkerFailure:
            session = signed_in(FakeConsole([], []))

            async def login() -> None:
                session._login_status = 499

            session.controller.login = login  # type: ignore[method-assign]
            try:
                await session._login()
            except WorkerFailure as failure:
                return failure
            raise AssertionError("a 499 sign-in must fail")

        self.assertEqual(asyncio.run(run()).kind, "mfa")

    def test_a_refused_password_is_auth_and_the_message_never_carries_it(self) -> None:
        async def run() -> WorkerFailure:
            session = signed_in(FakeConsole([], []))

            async def login() -> None:
                session._login_status = 401
                raise LoginRequired("Call https://console.example/api/auth/login received 401")

            session.controller.login = login  # type: ignore[method-assign]
            try:
                await session._login()
            except WorkerFailure as failure:
                return failure
            raise AssertionError("a refused sign-in must fail")

        failure = asyncio.run(run())
        self.assertEqual(failure.kind, "auth")

    def test_an_unsigned_worker_answers_not_connected(self) -> None:
        session = UnifiSession(lambda _line: None)
        with self.assertRaises(WorkerFailure) as caught:
            asyncio.run(session.list(False))
        self.assertEqual(caught.exception.kind, "not-connected")


if __name__ == "__main__":
    unittest.main()
