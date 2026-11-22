"""Session logic of the long-lived Kia worker: no `hyundai_kia_connect_api` import, so it is
unit-tested with a fake library (`test_kia_protocol.py`).

The worker speaks line-delimited JSON on stdin/stdout, one process per Kia account:

  request   {"id": "1", "op": "login", "username": "...", "password": "...", "pin": "...",
             "region": "europe", "brand": "kia"}
  response  {"id": "1", "ok": true, "result": {...}}
            {"id": "1", "ok": false, "code": "auth", "error": "..."}

Ops after the login: `read` (the cloud's CACHED state of every vehicle: it never wakes a car),
`refresh` (wake ONE car, then read it), `command` (lock, unlock, climate start / stop on ONE
car), `close`. The credentials arrive only in the `login` line, never in argv or the
environment, and are never written back on any stream.

A snapshot is what the car last REPORTED to its maker's cloud, in SI units. A value the cloud
does not report is None (never 0, never False): the hub keeps "unknown" distinct from "off".
There is no push channel and no retry here: the one caller decides when to read again.
"""
from __future__ import annotations

import datetime
import threading
from typing import Any, Callable, Dict, List, Optional

COMMANDS = ("lock", "unlock", "climate-start", "climate-stop")
REGIONS = ("europe", "europe-cci")
BRANDS = ("kia", "hyundai", "genesis")
METRES_PER_UNIT = {"km": 1000.0, "mi": 1609.344}
# Seconds a command waits for the car to answer the cloud's action record: every poll is one
# call against the maker's daily quota, so the wait is short and a late answer is read later.
ACTION_TIMEOUT_S = 30
CLIMATE_MIN_C = 16.0
CLIMATE_MAX_C = 30.0
CLIMATE_DEFAULT_C = 21.0
CLIMATE_DEFAULT_MINUTES = 10


class WorkerError(Exception):
    """A failure the worker answers with a typed code (the TS side maps the code)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _read(owner: Any, name: str) -> Any:
    """A readable attribute; one that raises (a property over a missing field) is unknown."""
    try:
        return getattr(owner, name, None)
    except Exception:  # noqa: BLE001 - one unreadable property must not sink the snapshot
        return None


def _boolean(value: Any) -> Optional[bool]:
    return value if isinstance(value, bool) else None


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if number == number and abs(number) != float("inf") else None


def _metres(value: Any, unit: Any) -> Optional[float]:
    """A distance in the unit the car's display uses, as metres; no known unit is unknown."""
    amount = _number(value)
    scale = METRES_PER_UNIT.get(unit) if isinstance(unit, str) else None
    if amount is None or scale is None or amount < 0:
        return None
    return round(amount * scale, 1)


def _epoch_ms(value: Any) -> Optional[int]:
    if not isinstance(value, datetime.datetime):
        return None
    return int(value.timestamp() * 1000)


def _percentage(value: Any) -> Optional[float]:
    number = _number(value)
    return number if number is not None and 0 <= number <= 100 else None


def _wheels(vehicle: Any, template: str, positions: Dict[str, str]) -> Dict[str, Optional[bool]]:
    return {key: _boolean(_read(vehicle, template.format(position))) for key, position in positions.items()}


DOOR_POSITIONS = {
    "frontLeft": "front_left",
    "frontRight": "front_right",
    "rearLeft": "back_left",
    "rearRight": "back_right",
}
TYRE_POSITIONS = {
    "frontLeft": "front_left",
    "frontRight": "front_right",
    "rearLeft": "rear_left",
    "rearRight": "rear_right",
}


def snapshot_of(vehicle: Any) -> Dict[str, Any]:
    """What the car last reported, as plain JSON values; None where the cloud says nothing."""
    range_value = _read(vehicle, "total_driving_range")
    range_unit = _read(vehicle, "total_driving_range_unit")
    if _number(range_value) is None:
        range_value = _read(vehicle, "fuel_driving_range")
        range_unit = _read(vehicle, "_fuel_driving_range_unit")
    service_value = _read(vehicle, "next_service_distance")
    service_unit = _read(vehicle, "_next_service_distance_unit")
    return {
        "odometerM": _metres(_read(vehicle, "odometer"), _read(vehicle, "odometer_unit")),
        "rangeM": _metres(range_value, range_unit),
        "fuelLevelPct": _percentage(_read(vehicle, "fuel_level")),
        "fuelLow": _boolean(_read(vehicle, "fuel_level_is_low")),
        "engineOn": _boolean(_read(vehicle, "engine_is_running")),
        "doors": _wheels(vehicle, "{}_door_is_open", DOOR_POSITIONS),
        "windows": _wheels(vehicle, "{}_window_is_open", DOOR_POSITIONS),
        "trunkOpen": _boolean(_read(vehicle, "trunk_is_open")),
        "hoodOpen": _boolean(_read(vehicle, "hood_is_open")),
        "sunroofOpen": _boolean(_read(vehicle, "sunroof_is_open")),
        "tyreWarnings": _wheels(vehicle, "tire_pressure_{}_warning_is_on", TYRE_POSITIONS),
        "auxBatteryPct": _percentage(_read(vehicle, "car_battery_percentage")),
        "locked": _boolean(_read(vehicle, "is_locked")),
        "climateOn": _boolean(_read(vehicle, "air_control_is_on")),
        "climateTargetC": _climate_target(_read(vehicle, "air_temperature")),
        "washerFluidLow": _boolean(_read(vehicle, "washer_fluid_warning_is_on")),
        "brakeFluidLow": _boolean(_read(vehicle, "brake_fluid_warning_is_on")),
        "smartKeyBatteryLow": _boolean(_read(vehicle, "smart_key_battery_warning_is_on")),
        "nextServiceM": _metres(service_value, service_unit),
        "latitude": _number(_read(vehicle, "location_latitude")),
        "longitude": _number(_read(vehicle, "location_longitude")),
        "fixAtMs": _epoch_ms(_read(vehicle, "location_last_updated_at")),
        "reportedAtMs": _epoch_ms(_read(vehicle, "last_updated_at")),
    }


def _climate_target(value: Any) -> Optional[float]:
    number = _number(value)
    return number if number is not None and CLIMATE_MIN_C <= number <= CLIMATE_MAX_C else None


def descriptor_of(vehicle: Any) -> Dict[str, Any]:
    engine = _read(vehicle, "engine_type")
    return {
        "vehicleId": str(_read(vehicle, "id")),
        "vin": _text_or_none(_read(vehicle, "VIN")),
        "name": str(_read(vehicle, "name") or ""),
        "model": str(_read(vehicle, "model") or ""),
        "year": _int_or_none(_read(vehicle, "year")),
        "engineType": getattr(engine, "value", None) if engine is not None else None,
    }


def _text_or_none(value: Any) -> Optional[str]:
    return value.strip() if isinstance(value, str) and value.strip() != "" else None


def _int_or_none(value: Any) -> Optional[int]:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


class Session:
    """One Kia account. `library` is built at login by `library_factory(credentials)`.

    The library object offers: `login() -> list` (the account's vehicles), `read_cached()`,
    `force_refresh(vehicle_id)`, `act(vehicle_id, command, options) -> outcome` and `stop()`;
    each raises `WorkerError` for a failure it can name.
    """

    def __init__(self, library_factory: Callable[[Dict[str, str]], Any]) -> None:
        self._factory = library_factory
        self._library: Any = None
        self._vehicles: Dict[str, Any] = {}
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
        if op == "read":
            return self._read_all(library)
        if op == "refresh":
            return self._refresh(library, message)
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
        credentials = {
            "username": self._text(message, "username"),
            "password": self._text(message, "password"),
            "pin": self._text(message, "pin"),
        }
        region, brand = message.get("region"), message.get("brand")
        if region not in REGIONS:
            raise WorkerError("bad-request", f"region must be one of {', '.join(REGIONS)}")
        if brand not in BRANDS:
            raise WorkerError("bad-request", f"brand must be one of {', '.join(BRANDS)}")
        if self._library is not None:
            raise WorkerError("bad-request", "already logged in")
        library = self._factory({**credentials, "region": region, "brand": brand})
        vehicles: List[Any] = list(library.login())
        described: List[Dict[str, Any]] = []
        for vehicle in vehicles:
            info = descriptor_of(vehicle)
            self._vehicles[info["vehicleId"]] = vehicle
            described.append({**info, "state": snapshot_of(vehicle)})
        self._library = library
        return {"vehicles": described}

    def _states(self) -> Dict[str, Dict[str, Any]]:
        return {vehicle_id: snapshot_of(vehicle) for vehicle_id, vehicle in self._vehicles.items()}

    def _read_all(self, library: Any) -> Dict[str, Any]:
        """The cloud's cached state of every vehicle: no car is woken."""
        library.read_cached()
        return {"states": self._states()}

    def _vehicle_id(self, message: Dict[str, Any]) -> str:
        vehicle_id = self._text(message, "vehicleId")
        if vehicle_id not in self._vehicles:
            raise WorkerError("unknown-vehicle", "no such vehicle on this account")
        return vehicle_id

    def _refresh(self, library: Any, message: Dict[str, Any]) -> Dict[str, Any]:
        """Wake ONE car and read it: the call that spends the daily quota."""
        vehicle_id = self._vehicle_id(message)
        library.force_refresh(vehicle_id)
        return {"state": snapshot_of(self._vehicles[vehicle_id])}

    def _command(self, library: Any, message: Dict[str, Any]) -> Dict[str, Any]:
        vehicle_id = self._vehicle_id(message)
        command = message.get("command")
        if command not in COMMANDS:
            raise WorkerError("bad-request", f"command must be one of {', '.join(COMMANDS)}")
        options = self._climate_options(message) if command == "climate-start" else {}
        with self._lock:
            outcome = library.act(vehicle_id, command, options)
        return {"outcome": outcome, "state": snapshot_of(self._vehicles[vehicle_id])}

    @staticmethod
    def _climate_options(message: Dict[str, Any]) -> Dict[str, Any]:
        temperature = message.get("temperature", CLIMATE_DEFAULT_C)
        minutes = message.get("durationMinutes", CLIMATE_DEFAULT_MINUTES)
        if isinstance(temperature, bool) or not isinstance(temperature, (int, float)):
            raise WorkerError("bad-request", "temperature must be a number")
        if not CLIMATE_MIN_C <= temperature <= CLIMATE_MAX_C:
            raise WorkerError("bad-request", f"temperature must be {CLIMATE_MIN_C}..{CLIMATE_MAX_C}")
        if isinstance(minutes, bool) or not isinstance(minutes, int) or not 1 <= minutes <= 30:
            raise WorkerError("bad-request", "durationMinutes must be an integer 1..30")
        # The cloud takes half-degree steps only.
        return {"temperature": round(float(temperature) * 2) / 2, "durationMinutes": minutes}

    def _close(self) -> Dict[str, Any]:
        library, self._library = self._library, None
        if library is not None:
            library.stop()
        return {}
