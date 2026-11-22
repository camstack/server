"""The worker's mapping and session logic against a fake library (no network, no account)."""
import dataclasses
import datetime
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

from kia_protocol import Session, WorkerError, descriptor_of, snapshot_of

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "sportage_hybrid_vehicle.json"
DATETIME_FIELDS = ("_location_last_set_time", "_last_updated_at")


class Engine:
    """Stands for the library's ENGINE_TYPES member: only `.value` is read."""

    def __init__(self, value: str) -> None:
        self.value = value


# The library derives these public names from private storage through properties.
PROPERTY_OF = {
    "odometer": "_odometer",
    "odometer_unit": "_odometer_unit",
    "total_driving_range": "_total_driving_range",
    "total_driving_range_unit": "_total_driving_range_unit",
    "fuel_driving_range": "_fuel_driving_range",
    "next_service_distance": "_next_service_distance",
    "air_temperature": "_air_temperature",
    "location_latitude": "_location_latitude",
    "location_longitude": "_location_longitude",
    "location_last_updated_at": "_location_last_set_time",
    "last_updated_at": "_last_updated_at",
}


def recorded_vehicle(**overrides: Any) -> SimpleNamespace:
    raw = {k: v for k, v in json.loads(FIXTURE.read_text()).items() if not k.startswith("_comment")}
    for key in DATETIME_FIELDS:
        if raw.get(key) is not None:
            raw[key] = datetime.datetime.fromisoformat(raw[key])
    raw["engine_type"] = Engine(raw["engine_type"])
    raw.update(overrides)
    for public, private in PROPERTY_OF.items():
        raw[public] = raw.get(private)
    return SimpleNamespace(**raw)


class SnapshotTest(unittest.TestCase):
    def test_maps_a_reported_state_into_si_units(self) -> None:
        state = snapshot_of(recorded_vehicle())
        self.assertEqual(state["odometerM"], 18432700.0)
        self.assertEqual(state["rangeM"], 812000.0)
        self.assertEqual(state["nextServiceM"], 7600000.0)
        self.assertEqual(state["fuelLevelPct"], 64.0)
        self.assertEqual(state["auxBatteryPct"], 87.0)
        self.assertIs(state["locked"], True)
        self.assertIs(state["climateOn"], False)
        self.assertEqual(state["climateTargetC"], 21.0)
        self.assertEqual(state["doors"], {"frontLeft": False, "frontRight": False, "rearLeft": False, "rearRight": True})
        self.assertEqual(state["tyreWarnings"]["rearLeft"], True)
        self.assertEqual(state["latitude"], 45.4642)
        self.assertEqual(state["longitude"], 9.19)
        self.assertEqual(state["fixAtMs"], 1795335300000)
        self.assertEqual(state["reportedAtMs"], 1795335630000)

    def test_miles_are_converted(self) -> None:
        state = snapshot_of(recorded_vehicle(_odometer_unit="mi", odometer_unit="mi"))
        self.assertEqual(state["odometerM"], round(18432.7 * 1609.344, 1))

    def test_a_field_the_cloud_does_not_report_is_none_never_zero_or_false(self) -> None:
        state = snapshot_of(recorded_vehicle())
        self.assertIsNone(state["sunroofOpen"])
        self.assertIsNone(state["smartKeyBatteryLow"])
        blank = snapshot_of(SimpleNamespace())
        self.assertIsNone(blank["odometerM"])
        self.assertIsNone(blank["locked"])
        self.assertIsNone(blank["latitude"])
        self.assertIsNone(blank["fuelLow"])
        self.assertEqual(set(blank["doors"].values()), {None})
        self.assertEqual(set(blank["tyreWarnings"].values()), {None})

    def test_an_unknown_distance_unit_is_unknown_not_assumed(self) -> None:
        state = snapshot_of(recorded_vehicle(_odometer_unit=None, odometer_unit=None))
        self.assertIsNone(state["odometerM"])

    def test_the_range_falls_back_to_the_fuel_range(self) -> None:
        state = snapshot_of(recorded_vehicle(_total_driving_range=None, total_driving_range=None))
        self.assertEqual(state["rangeM"], 790000.0)

    def test_an_out_of_range_percentage_is_unknown(self) -> None:
        state = snapshot_of(recorded_vehicle(car_battery_percentage=140, fuel_level=-3.0))
        self.assertIsNone(state["auxBatteryPct"])
        self.assertIsNone(state["fuelLevelPct"])

    def test_a_property_that_raises_does_not_sink_the_snapshot(self) -> None:
        class Broken(SimpleNamespace):
            @property
            def odometer(self) -> float:  # type: ignore[override]
                raise ValueError("boom")

        state = snapshot_of(Broken(is_locked=False))
        self.assertIsNone(state["odometerM"])
        self.assertIs(state["locked"], False)

    def test_descriptor(self) -> None:
        info = descriptor_of(recorded_vehicle())
        self.assertEqual(info["vin"], "U5YPH81ABPL000000")
        self.assertEqual(info["engineType"], "HEV")
        self.assertEqual(info["year"], 2023)

    def test_every_attribute_read_exists_on_the_pinned_library(self) -> None:
        try:
            from hyundai_kia_connect_api import Vehicle
        except ImportError:
            self.skipTest("hyundai-kia-connect-api is not installed here")
        names = {field.name for field in dataclasses.fields(Vehicle)} | {
            name for name in dir(Vehicle) if not name.startswith("__")
        }
        read_by_the_worker = {
            key for key in json.loads(FIXTURE.read_text()) if not key.startswith("_comment")
        }
        public_properties = {
            "odometer", "odometer_unit", "total_driving_range", "total_driving_range_unit",
            "fuel_driving_range", "next_service_distance", "air_temperature",
            "location_latitude", "location_longitude", "location_last_updated_at", "last_updated_at",
        }
        self.assertEqual((read_by_the_worker | public_properties) - names, set())


class FakeLibrary:
    def __init__(self, vehicles: List[Any], fail: Optional[WorkerError] = None) -> None:
        self.vehicles = vehicles
        self.fail = fail
        self.calls: List[str] = []
        self.outcome = "success"
        self.options: Dict[str, Any] = {}

    def login(self) -> List[Any]:
        self.calls.append("login")
        if self.fail is not None:
            raise self.fail
        return self.vehicles

    def read_cached(self) -> None:
        self.calls.append("read_cached")

    def force_refresh(self, vehicle_id: str) -> None:
        self.calls.append(f"force:{vehicle_id}")

    def act(self, vehicle_id: str, command: str, options: Dict[str, Any]) -> str:
        self.calls.append(f"act:{command}")
        self.options = options
        return self.outcome

    def stop(self) -> None:
        self.calls.append("stop")


LOGIN = {"op": "login", "username": "u", "password": "p", "pin": "1234", "region": "europe", "brand": "kia"}


def logged_in(vehicle: Any = None) -> "tuple[Session, FakeLibrary, List[Dict[str, Any]]]":
    library = FakeLibrary([vehicle or recorded_vehicle()])
    seen: List[Dict[str, Any]] = []

    def factory(credentials: Dict[str, str]) -> FakeLibrary:
        seen.append(credentials)
        return library

    session = Session(factory)
    session.handle(LOGIN)
    return session, library, seen


class SessionTest(unittest.TestCase):
    def test_login_lists_the_vehicles_with_their_state(self) -> None:
        library = FakeLibrary([recorded_vehicle()])
        result = Session(lambda _c: library).handle(LOGIN)
        (vehicle,) = result["vehicles"]
        self.assertEqual(vehicle["vehicleId"], "a1b2c3d4-0000-4000-8000-000000000001")
        self.assertEqual(vehicle["state"]["odometerM"], 18432700.0)

    def test_the_credentials_reach_the_library_and_are_never_answered_back(self) -> None:
        session, _library, seen = logged_in()
        self.assertEqual(seen[0]["pin"], "1234")
        answer = json.dumps(session.handle({"op": "read"}))
        for secret in ("1234", '"p"'):
            self.assertNotIn(secret, answer)

    def test_login_needs_every_credential_and_a_known_region_and_brand(self) -> None:
        for key in ("username", "password", "pin"):
            message = {k: v for k, v in LOGIN.items() if k != key}
            with self.assertRaises(WorkerError) as raised:
                Session(lambda _c: FakeLibrary([])).handle(message)
            self.assertEqual(raised.exception.code, "bad-request")
        for key, value in (("region", "mars"), ("brand", "ford")):
            with self.assertRaises(WorkerError):
                Session(lambda _c: FakeLibrary([])).handle({**LOGIN, key: value})

    def test_a_refused_login_is_a_typed_failure_and_the_session_stays_logged_out(self) -> None:
        session = Session(lambda _c: FakeLibrary([], fail=WorkerError("auth", "refused")))
        with self.assertRaises(WorkerError) as raised:
            session.handle(LOGIN)
        self.assertEqual(raised.exception.code, "auth")
        with self.assertRaises(WorkerError) as again:
            session.handle({"op": "read"})
        self.assertEqual(again.exception.code, "not-logged-in")

    def test_read_is_the_cached_read_and_never_wakes_a_car(self) -> None:
        session, library, _ = logged_in()
        session.handle({"op": "read"})
        self.assertEqual(library.calls, ["login", "read_cached"])

    def test_refresh_forces_one_vehicle(self) -> None:
        session, library, _ = logged_in()
        result = session.handle({"op": "refresh", "vehicleId": "a1b2c3d4-0000-4000-8000-000000000001"})
        self.assertEqual(library.calls[-1], "force:a1b2c3d4-0000-4000-8000-000000000001")
        self.assertEqual(result["state"]["fuelLevelPct"], 64.0)

    def test_an_unknown_vehicle_is_refused_before_any_call(self) -> None:
        session, library, _ = logged_in()
        with self.assertRaises(WorkerError) as raised:
            session.handle({"op": "refresh", "vehicleId": "nope"})
        self.assertEqual(raised.exception.code, "unknown-vehicle")
        self.assertEqual(library.calls, ["login"])

    def test_commands_pass_through_and_return_the_read_back_state(self) -> None:
        session, library, _ = logged_in()
        vid = "a1b2c3d4-0000-4000-8000-000000000001"
        result = session.handle({"op": "command", "vehicleId": vid, "command": "unlock"})
        self.assertEqual(library.calls[-1], "act:unlock")
        self.assertEqual(result["outcome"], "success")
        self.assertIn("state", result)

    def test_climate_start_normalises_and_bounds_its_options(self) -> None:
        session, library, _ = logged_in()
        vid = "a1b2c3d4-0000-4000-8000-000000000001"
        session.handle({"op": "command", "vehicleId": vid, "command": "climate-start", "temperature": 21.3, "durationMinutes": 5})
        self.assertEqual(library.options, {"temperature": 21.5, "durationMinutes": 5})
        for bad in ({"temperature": 99}, {"temperature": True}, {"durationMinutes": 0}, {"durationMinutes": 5.5}):
            with self.assertRaises(WorkerError) as raised:
                session.handle({"op": "command", "vehicleId": vid, "command": "climate-start", **bad})
            self.assertEqual(raised.exception.code, "bad-request")

    def test_an_unknown_command_is_refused(self) -> None:
        session, _library, _ = logged_in()
        with self.assertRaises(WorkerError):
            session.handle({"op": "command", "vehicleId": "a1b2c3d4-0000-4000-8000-000000000001", "command": "open-frunk"})

    def test_close_stops_the_library_once(self) -> None:
        session, library, _ = logged_in()
        session.handle({"op": "close"})
        session.handle({"op": "close"})
        self.assertEqual(library.calls.count("stop"), 1)


if __name__ == "__main__":
    unittest.main()
