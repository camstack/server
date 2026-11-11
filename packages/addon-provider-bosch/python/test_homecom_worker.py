"""The worker's normalization of a `homecom_alt` K40 reading, and its stdin contract.

The fixture is shaped like the library's `BHCDeviceK40` (as `dataclasses.asdict` gives it),
with the values a live K40 air/water heat pump answered. Runs under pytest, or plainly:
`python3 test_homecom_worker.py`. Neither needs `homecom_alt` installed.
"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from homecom_normalize import normalize_reading, probe_outcome  # noqa: E402
from homecom_worker import WorkerError, parse_request  # noqa: E402

FORBIDDEN = {}  # the library turns a 403/404 into an empty dict


def env(value, **extra):
    return {"id": "/x", "type": "stringValue", "value": value, **extra}


def k40_device():
    return {
        "device": "101000000",
        "notifications": [],
        "holiday_mode": {"id": "/holidayMode/activeModes", "values": [], "allowedValues": []},
        "away_mode": env("off", allowedValues=["on", "off"], writeable=1),
        "power_limitation": FORBIDDEN,
        "outdoor_temp": env(7.5, type="floatValue", unitOfMeasure="C"),
        "heat_sources": {
            "pumpType": env("air_water"),
            "starts": {"id": "/heatSources/hs1/numberOfStarts", "type": "emonValue",
                       "values": [{"ch": 400}, {"total": 516}]},
            "returnTemperature": env(47.8, type="floatValue"),
            "actualSupplyTemperature": env(52.2, type="floatValue"),
            "actualModulation": env(89, type="floatValue"),
            "systemPressure": env(1.7, type="floatValue"),
            "consumption": FORBIDDEN,
            "totalWorkingTime": FORBIDDEN,
        },
        "dhw_circuits": [
            {
                "id": "/dhwCircuits/dhw1",
                "operationMode": env("eco", allowedValues=["Off", "low", "high", "ownprogram", "eco"],
                                     writeable=1),
                "actualTemp": env(48.0, type="floatValue"),
                "charge": env("stop", allowedValues=["start", "stop"], writeable=1),
                "chargeRemainingTime": env(0, type="floatValue"),
                "currentTemperatureLevel": env("eco", allowedValues=["off", "low", "high", "eco"],
                                               writeable=0),
                "singleChargeSetpoint": env(60, type="floatValue", minValue=50, maxValue=70),
                "tempLevel": {"eco": env(51, type="floatValue", minValue=30, maxValue=60),
                              "low": FORBIDDEN},
            }
        ],
        "heating_circuits": [
            {
                "id": "/heatingCircuits/hc1",
                "operationMode": env("manual", allowedValues=["off", "manual", "auto"], writeable=1),
                "currentSuWiMode": env("forced"),
                "suWiSwitchMode": FORBIDDEN,
                "heatCoolMode": env("heat", allowedValues=["heat", "cool", "heatCool"], writeable=0),
                "roomTemp": env(-3276.8, type="floatValue", state=[{"open": -3276.8}, {"short": 3276.7}]),
                "actualHumidity": FORBIDDEN,
                "manualRoomSetpoint": env(30, type="floatValue", minValue=5, maxValue=30, writeable=1),
                "currentRoomSetpoint": env(30, type="floatValue"),
                "maxFlowTemp": env(60, type="floatValue", minValue=30, maxValue=60, writeable=1),
                "temperatureLevelComfort2": None,
            },
            {"id": "/heatingCircuits/hc2"},
        ],
    }


def extras():
    return {
        "silentMode": FORBIDDEN,
        "additionalHeaterMode": FORBIDDEN,
        "aggregateStarts": env(516, type="floatValue"),
        "chargeDuration": {"dhw1": env(60, type="floatValue", minValue=60, maxValue=2880)},
    }


def test_heat_source_values_come_from_the_k40_keys():
    hs = normalize_reading(k40_device(), extras())["heatSource"]
    assert hs["heatPumpType"] == "air_water"
    assert hs["supplyTemp"] == 52.2
    assert hs["returnTemp"] == 47.8
    assert hs["modulationPct"] == 89
    assert hs["pressureBar"] == 1.7
    assert hs["starts"] == 516
    assert hs["outdoorTemp"] == 7.5


def test_a_forbidden_resource_is_null_never_zero():
    reading = normalize_reading(k40_device(), extras())
    assert reading["heatSource"]["thermalKwh"] is None
    assert reading["heatSource"]["electricalKwh"] is None
    assert reading["system"]["silent"] is None
    assert reading["system"]["additionalHeater"] is None
    hc1 = reading["heatingCircuits"][0]
    assert hc1["suWiSwitchMode"] is None
    assert hc1["humidity"] is None
    assert hc1["comfortSetpoint"] is None


def test_a_sensor_fault_marker_is_null():
    device = k40_device()
    device["heat_sources"]["returnTemperature"] = env(
        3276.7, type="floatValue", state=[{"open": -3276.8}, {"short": 3276.7}]
    )
    reading = normalize_reading(device, extras())
    assert reading["heatSource"]["returnTemp"] is None
    assert reading["heatingCircuits"][0]["roomTemp"] is None


def test_energy_is_split_from_the_emon_parts_and_electrical_needs_both_parts():
    device = k40_device()
    device["heat_sources"]["consumption"] = {
        "type": "emonValue", "values": [{"outputProduced": 9000.5}, {"eheater": 12}, {"compressor": 2500}],
    }
    hs = normalize_reading(device, extras())["heatSource"]
    assert hs["thermalKwh"] == 9000.5
    assert hs["electricalKwh"] == 2512
    device["heat_sources"]["consumption"] = {"type": "emonValue", "values": [{"compressor": 2500}]}
    assert normalize_reading(device, extras())["heatSource"]["electricalKwh"] is None


def test_starts_fall_back_to_the_aggregate_when_hs1_has_no_total():
    device = k40_device()
    device["heat_sources"]["starts"] = FORBIDDEN
    assert normalize_reading(device, extras())["heatSource"]["starts"] == 516
    assert normalize_reading(device, {})["heatSource"]["starts"] is None


def test_circuits_keep_their_settings_with_limits_and_allowed_values():
    reading = normalize_reading(k40_device(), extras())
    assert [c["id"] for c in reading["heatingCircuits"]] == ["hc1", "hc2"]
    hc1 = reading["heatingCircuits"][0]
    assert hc1["operationMode"] == {"value": "manual", "min": None, "max": None,
                                    "allowed": ["off", "manual", "auto"], "writeable": True}
    assert hc1["heatCoolMode"]["writeable"] is False
    assert hc1["manualRoomSetpoint"]["min"] == 5 and hc1["manualRoomSetpoint"]["max"] == 30
    assert hc1["maxFlowTemp"]["value"] == 60
    assert reading["heatingCircuits"][1]["operationMode"] is None


def test_a_heating_circuit_keeps_the_name_the_gateway_gave():
    device = k40_device()
    device["heating_circuits"][0]["name"] = "Living room"
    circuits = normalize_reading(device, extras())["heatingCircuits"]
    assert circuits[0]["name"] == "Living room"
    assert circuits[1]["name"] is None


def test_a_heat_source_probe_separates_refused_from_absent_and_transient():
    assert [probe_outcome(s) for s in (200, 403, 500, 404, 429, 503, 502)] == [
        "answered", "refused", "refused", "absent", "transient", "transient", "transient"
    ]
    probe = {"/heatSources/hs1/heatPumpType": "refused", "/x": "bogus", 3: "absent"}
    reading = normalize_reading(k40_device(), {**extras(), "heatSourceProbe": probe})
    assert reading["heatSourceProbe"] == {"/heatSources/hs1/heatPumpType": "refused"}
    assert normalize_reading(k40_device(), extras())["heatSourceProbe"] == {}


def test_setpoint_limits_come_only_from_the_gateway_answer():
    device = k40_device()
    hc1 = device["heating_circuits"][0]
    hc1["manualRoomSetpoint"] = env(30, type="floatValue", writeable=1)
    hc1["temperatureLevelComfort2"] = env(22, type="floatValue", minValue=15, maxValue=28, writeable=1)
    hc1["temperatureLevelEco"] = env(19, type="floatValue", minValue=10, maxValue=25, writeable=1)
    out = normalize_reading(device, extras())["heatingCircuits"][0]
    assert out["manualRoomSetpoint"]["min"] is None and out["manualRoomSetpoint"]["max"] is None
    assert (out["comfortSetpoint"]["value"], out["comfortSetpoint"]["min"], out["comfortSetpoint"]["max"]) == (22, 15, 28)
    assert (out["ecoSetpoint"]["value"], out["ecoSetpoint"]["min"], out["ecoSetpoint"]["max"]) == (19, 10, 25)


def test_dhw_carries_levels_charge_and_the_separately_read_duration():
    dhw1 = normalize_reading(k40_device(), extras())["dhwCircuits"][0]
    assert dhw1["id"] == "dhw1"
    assert dhw1["actualTemp"] == 48.0
    assert dhw1["charge"]["value"] == "stop"
    assert dhw1["chargeDuration"]["max"] == 2880
    assert dhw1["currentTemperatureLevel"]["value"] == "eco"
    assert dhw1["currentSetpoint"] is None
    assert list(dhw1["temperatureLevels"]) == ["eco"]
    assert dhw1["temperatureLevels"]["eco"]["value"] == 51


def test_holiday_answered_with_no_active_mode_is_an_empty_value_not_null():
    reading = normalize_reading(k40_device(), extras())
    assert reading["system"]["holiday"]["value"] == ""
    assert reading["system"]["away"]["value"] == "off"


def test_icom_aliases_are_read():
    device = {
        "heat_sources": {
            "type": env("Heatpump"),
            "supplyTemperature": env(40.0, type="floatValue"),
            "modulation": env(50, type="floatValue"),
            "numberOfStarts": env(12, type="floatValue"),
            "outdoorTemp": env(3.0, type="floatValue"),
        },
        "heating_circuits": [{"id": "/heatingCircuits/hc1", "roomtemperature": env(20.5, type="floatValue")}],
        "dhw_circuits": [{"id": "/dhwCircuits/dhw1", "chargeDuration": env(90, type="floatValue"),
                          "currentSetpoint": env(52, type="floatValue")}],
    }
    reading = normalize_reading(device, {})
    assert reading["heatSource"]["heatPumpType"] == "Heatpump"
    assert reading["heatSource"]["supplyTemp"] == 40.0
    assert reading["heatSource"]["modulationPct"] == 50
    assert reading["heatSource"]["starts"] == 12
    assert reading["heatSource"]["outdoorTemp"] == 3.0
    assert reading["heatingCircuits"][0]["roomTemp"] == 20.5
    assert reading["dhwCircuits"][0]["chargeDuration"]["value"] == 90
    assert reading["dhwCircuits"][0]["currentSetpoint"]["value"] == 52


def test_the_request_is_validated_before_the_library_loads():
    good = {"token": "t", "gatewayId": "g", "deviceType": "k40", "action": "read"}
    assert parse_request(json.dumps(good))["action"] == "read"
    for bad in (
        "not json",
        json.dumps({**good, "token": ""}),
        json.dumps({**good, "deviceType": "rac"}),
        json.dumps({**good, "action": "write", "write": {"op": "rm -rf"}}),
    ):
        try:
            parse_request(bad)
        except WorkerError as err:
            assert err.kind == "bad-request"
        else:
            raise AssertionError(f"accepted {bad}")


def test_a_bad_request_answers_one_json_line_without_echoing_the_token():
    secret = "secret-token-value"
    proc = subprocess.run(
        [sys.executable, str(HERE / "homecom_worker.py")],
        input=json.dumps({"token": secret, "gatewayId": "g", "deviceType": "rac", "action": "read"}),
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 1
    answer = json.loads(proc.stdout.strip())
    assert answer["ok"] is False and answer["kind"] == "bad-request"
    assert secret not in proc.stdout and secret not in proc.stderr


if __name__ == "__main__":
    tests = [(name, fn) for name, fn in sorted(globals().items()) if name.startswith("test_")]
    for name, fn in tests:
        fn()
        print(f"ok  {name}")
    print(f"{len(tests)} passed")
