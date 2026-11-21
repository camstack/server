"""The worker's session logic against a fake library (no pydreo needed)."""
import unittest
from typing import Any, Callable, Dict, List

from dreo_protocol import Session, WorkerError, snapshot_of


class FakeUnits:
    name = "FAHRENHEIT"


class FakeFan:
    """Class-level properties, like the library's devices."""

    def __init__(self, **values: Any) -> None:
        self.values = {
            "device_id": "dev-1",
            "model": "DR-HAF001S",
            "name": "Fan",
            "type": "Air Circulator",
            "is_on": False,
            "fan_speed": 2,
            "speed_range": (1, 4),
            "oscillating": False,
            "temperature": 68.0,
            "temperature_units": FakeUnits(),
            "connected": True,
            **values,
        }
        self.callbacks: List[Callable[[], None]] = []

    def add_attr_callback(self, cb: Callable[[], None]) -> None:
        self.callbacks.append(cb)

    def server_update(self, **changes: Any) -> None:
        self.values.update(changes)
        for cb in self.callbacks:
            cb()


def _prop(name: str) -> property:
    return property(lambda self: self.values[name])


for _name in (
    "device_id", "model", "name", "type", "is_on", "fan_speed", "speed_range",
    "oscillating", "temperature", "temperature_units", "connected",
):
    setattr(FakeFan, _name, _prop(_name))


class FakeLibrary:
    def __init__(self, devices: List[FakeFan]) -> None:
        self.devices = devices
        self.applied: List[Any] = []
        self.on_channel: Callable[[str], None] = lambda _s: None
        self.fail_apply: str = ""

    def login(self) -> None:
        pass

    def load_devices(self) -> List[FakeFan]:
        return self.devices

    def start_push(self, on_channel: Callable[[str], None]) -> None:
        self.on_channel = on_channel

    def reload_state(self, device: FakeFan) -> None:
        device.values["is_on"] = True  # what the cloud answers on a read

    def apply(self, device: FakeFan, command: str, value: Any) -> None:
        if self.fail_apply:
            raise WorkerError(self.fail_apply, "refused")
        self.applied.append((command, value))
        # The real library echoes a command into its own attributes.
        device.values["fan_speed" if command == "speed" else "is_on"] = value

    def stop(self) -> None:
        self.applied.append("stopped")


def login_message() -> Dict[str, Any]:
    return {"op": "login", "email": "u@example.com", "password": "pw", "region": "eu"}


class SessionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.fan = FakeFan()
        self.library = FakeLibrary([self.fan])
        self.pushed: List[Dict[str, Any]] = []
        self.session = Session(lambda *_a: self.library, self.pushed.append)

    def test_snapshot_reports_celsius_and_the_speed_range(self) -> None:
        state = snapshot_of(self.fan)
        self.assertEqual(state["temperature"], 20.0)
        self.assertEqual((state["speedMin"], state["speedMax"]), (1, 4))
        self.assertIsNone(state["humidity"])

    def test_login_lists_devices_with_their_state(self) -> None:
        result = self.session.handle(login_message())
        self.assertEqual(result["devices"][0]["deviceId"], "dev-1")
        self.assertTrue(result["devices"][0]["supported"])
        self.assertEqual(result["devices"][0]["state"]["on"], False)

    def test_a_server_update_is_pushed_once_and_an_identical_one_is_not(self) -> None:
        self.session.handle(login_message())
        self.fan.server_update(is_on=True)
        self.fan.server_update(is_on=True)
        self.assertEqual(len(self.pushed), 1)
        self.assertEqual(self.pushed[0]["state"]["on"], True)

    def test_a_command_is_not_reported_as_state(self) -> None:
        self.session.handle(login_message())
        self.session.handle({"op": "command", "deviceId": "dev-1", "command": "power", "value": True})
        self.assertEqual(self.pushed, [])
        self.assertEqual(self.library.applied, [("power", True)])

    def test_a_refused_command_names_its_code(self) -> None:
        self.session.handle(login_message())
        self.library.fail_apply = "rejected"
        with self.assertRaises(WorkerError) as caught:
            self.session.handle(
                {"op": "command", "deviceId": "dev-1", "command": "speed", "value": 3}
            )
        self.assertEqual(caught.exception.code, "rejected")

    def test_refresh_reads_the_cloud_and_pushes_the_difference(self) -> None:
        self.session.handle(login_message())
        result = self.session.handle({"op": "refresh"})
        self.assertTrue(result["states"]["dev-1"]["on"])
        self.assertEqual(len(self.pushed), 1)

    def test_a_reconnect_is_a_channel_push(self) -> None:
        self.session.handle(login_message())
        self.library.on_channel("down")
        self.library.on_channel("up")
        self.assertEqual(
            self.pushed,
            [{"push": "channel", "state": "down"}, {"push": "channel", "state": "up"}],
        )

    def test_bad_requests_are_refused_before_the_library(self) -> None:
        with self.assertRaises(WorkerError) as caught:
            self.session.handle({"op": "refresh"})
        self.assertEqual(caught.exception.code, "not-logged-in")
        with self.assertRaises(WorkerError):
            self.session.handle({**login_message(), "region": "mars"})
        self.session.handle(login_message())
        for bad in (
            {"command": "speed", "value": True},
            {"command": "power", "value": 1},
            {"command": "fly", "value": True},
        ):
            with self.assertRaises(WorkerError):
                self.session.handle({"op": "command", "deviceId": "dev-1", **bad})


if __name__ == "__main__":
    unittest.main()
