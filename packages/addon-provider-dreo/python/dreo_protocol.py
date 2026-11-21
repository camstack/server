"""Session logic of the long-lived Dreo worker: no `pydreo` import, so it is unit-tested
with a fake library (`test_dreo_protocol.py`).

The worker speaks line-delimited JSON on stdin/stdout, one process per Dreo account:

  request   {"id": "1", "op": "login", "email": "...", "password": "...", "region": "us"}
  response  {"id": "1", "ok": true, "result": {...}}
            {"id": "1", "ok": false, "code": "auth", "error": "..."}
  push      {"push": "state", "deviceId": "...", "state": {...}}
            {"push": "channel", "state": "up" | "down"}

The password arrives only in the `login` line, never in argv or the environment, and is
never written back on any stream. A `state` is what the DEVICE reported: the library's own
local echo of a command is never emitted as state, so the hub can hold a commanded value
until the device confirms it.
"""
from __future__ import annotations

import threading
from typing import Any, Callable, Dict, List, Optional

COMMANDS = ("power", "speed", "oscillating")
REGIONS = ("us", "eu")
UNKNOWN_TYPE = "Unknown"


class WorkerError(Exception):
    """A failure the worker answers with a typed code (the TS side maps the code)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _read(device: Any, *names: str) -> Any:
    """First readable property among `names`; a property that raises is an unknown value."""
    for name in names:
        if not hasattr(type(device), name):
            continue
        try:
            return getattr(device, name)
        except Exception:  # noqa: BLE001 - one unreadable property must not sink the snapshot
            return None
    return None


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _boolean(value: Any) -> Optional[bool]:
    return value if isinstance(value, bool) else None


def _celsius(device: Any) -> Optional[float]:
    value = _number(_read(device, "temperature"))
    if value is None:
        return None
    units = _read(device, "temperature_units")
    if getattr(units, "name", None) == "FAHRENHEIT":
        return round((value - 32) * 5 / 9, 1)
    return value


def snapshot_of(device: Any) -> Dict[str, Any]:
    """What the device reports, as plain JSON values; None where the model has no such value."""
    speed = _number(_read(device, "fan_speed"))
    speed_range = _read(device, "speed_range")
    low = high = None
    if isinstance(speed_range, (tuple, list)) and len(speed_range) == 2:
        low, high = _number(speed_range[0]), _number(speed_range[1])
    return {
        "on": _boolean(_read(device, "is_on", "poweron")),
        "speed": None if speed is None else int(speed),
        "speedMin": None if low is None else int(low),
        "speedMax": None if high is None else int(high),
        "oscillating": _boolean(_read(device, "oscillating")),
        "temperature": _celsius(device),
        "humidity": _number(_read(device, "humidity")),
        "pm25": _number(_read(device, "pm25")),
        "connected": _boolean(_read(device, "connected")),
    }


def descriptor_of(device: Any) -> Dict[str, Any]:
    return {
        "deviceId": str(_read(device, "device_id")),
        "model": str(_read(device, "model") or ""),
        "name": str(_read(device, "name") or ""),
        # The library builds a placeholder for a model it does not know; it has no state to read.
        "supported": str(_read(device, "type")) != UNKNOWN_TYPE,
    }


class Session:
    """One Dreo account. `library` is built at login by `library_factory(email, password, region)`.

    The library object offers: `login()`, `load_devices() -> list`, `start_push(on_channel)`,
    `reload_state(device)`, `apply(device, command, value)`, `stop()`; each raises
    `WorkerError` for a failure it can name.
    """

    def __init__(
        self,
        library_factory: Callable[[str, str, str], Any],
        emit: Callable[[Dict[str, Any]], None],
    ) -> None:
        self._factory = library_factory
        self._emit = emit
        self._library: Any = None
        self._devices: Dict[str, Any] = {}
        self._reported: Dict[str, Dict[str, Any]] = {}
        self._commanding: Dict[str, int] = {}
        self._lock = threading.Lock()

    def handle(self, message: Dict[str, Any]) -> Dict[str, Any]:
        """The `result` of one request, or a raised `WorkerError`."""
        op = message.get("op")
        if op == "login":
            return self._login(message)
        if op == "close":
            return self._close()
        library = self._library
        if library is None:
            raise WorkerError("not-logged-in", "login first")
        if op == "snapshot":
            return {"states": self._states()}
        if op == "refresh":
            return self._refresh(library)
        if op == "command":
            return self._command(library, message)
        raise WorkerError("bad-request", f"unknown op {op!r}")

    @staticmethod
    def _text(message: Dict[str, Any], key: str) -> str:
        value = message.get(key)
        if not isinstance(value, str) or value == "":
            raise WorkerError("bad-request", f"{key} must be a non-empty string")
        return value

    def _login(self, message: Dict[str, Any]) -> Dict[str, Any]:
        email = self._text(message, "email")
        password = self._text(message, "password")
        region = message.get("region")
        if region not in REGIONS:
            raise WorkerError("bad-request", f"region must be one of {', '.join(REGIONS)}")
        if self._library is not None:
            raise WorkerError("bad-request", "already logged in")
        library = self._factory(email, password, region)
        library.login()
        devices: List[Any] = list(library.load_devices())
        described: List[Dict[str, Any]] = []
        for device in devices:
            info = descriptor_of(device)
            device_id = info["deviceId"]
            self._devices[device_id] = device
            self._reported[device_id] = snapshot_of(device)
            if info["supported"]:
                # The library calls a callback with no arguments (`_do_callbacks`).
                device.add_attr_callback(lambda *_args, did=device_id: self._on_device(did))
            described.append({**info, "state": self._reported[device_id]})
        self._library = library
        library.start_push(lambda state: self._emit({"push": "channel", "state": state}))
        return {"devices": described}

    def _on_device(self, device_id: str) -> None:
        """A server update (or an online/offline notice): emit only what changed."""
        device = self._devices.get(device_id)
        if device is None:
            return
        with self._lock:
            if self._commanding.get(device_id, 0) > 0:
                # A setter folds the commanded value into the device's own attributes before
                # the cloud answers; reading them now would report that echo as device state.
                return
        snapshot = snapshot_of(device)
        with self._lock:
            if self._reported.get(device_id) == snapshot:
                return
            self._reported[device_id] = snapshot
        self._emit({"push": "state", "deviceId": device_id, "state": snapshot})

    def _states(self) -> Dict[str, Dict[str, Any]]:
        with self._lock:
            return dict(self._reported)

    def _refresh(self, library: Any) -> Dict[str, Any]:
        """Read every device again from the cloud, never from the local cache."""
        for device_id, device in self._devices.items():
            if descriptor_of(device)["supported"]:
                library.reload_state(device)
                self._on_device(device_id)
        return {"states": self._states()}

    def _command(self, library: Any, message: Dict[str, Any]) -> Dict[str, Any]:
        device = self._devices.get(self._text(message, "deviceId"))
        if device is None:
            raise WorkerError("unknown-device", "no such device on this account")
        command = message.get("command")
        if command not in COMMANDS:
            raise WorkerError("bad-request", f"command must be one of {', '.join(COMMANDS)}")
        value = message.get("value")
        if command == "speed":
            if isinstance(value, bool) or not isinstance(value, int):
                raise WorkerError("bad-request", "speed must be an integer")
        elif not isinstance(value, bool):
            raise WorkerError("bad-request", f"{command} must be a boolean")
        device_id = self._text(message, "deviceId")
        with self._lock:
            self._commanding[device_id] = self._commanding.get(device_id, 0) + 1
        try:
            library.apply(device, command, value)
        finally:
            with self._lock:
                self._commanding[device_id] -= 1
        return {}

    def _close(self) -> Dict[str, Any]:
        library, self._library = self._library, None
        if library is not None:
            library.stop()
        return {}
