"""Normalize a `homecom_alt` K40/icom device reading into the JSON the TypeScript side parses.

Pure: no third-party import, so it is tested without the library installed. Every value the
gateway did not answer, refused (the library turns a 403/404 into `{}`), or flagged as a sensor
fault is `None`, never `0` (D393).

Output shape (camelCase, every key always present):

  heatSource: { heatPumpType, supplyTemp, returnTemp, modulationPct, pressureBar, starts,
                outdoorTemp, thermalKwh, electricalKwh, workingTimeS, heatDemand,
                compressorRunning }
  system:     { away, silent, additionalHeater, holiday }            # Setting | None
  heatingCircuits: [ { id, name, operationMode, heatCoolMode, currentSuWiMode, suWiSwitchMode,
                       roomTemp, humidity, currentRoomSetpoint, manualRoomSetpoint,
                       coolingRoomSetpoint, comfortSetpoint, ecoSetpoint, maxFlowTemp,
                       controlType } ]
  dhwCircuits:     [ { id, operationMode, actualTemp, currentTemperatureLevel, charge,
                       chargeDuration, singleChargeSetpoint, currentSetpoint,
                       temperatureLevels: { <level>: Setting } } ]
  solarCircuits:   [ { id, collectorTemp, tankTemp, tankBottomTemp, maxCylinderTemp, yieldKwh } ]
  zones:           [ { id, userMode, setpointTemp, currentTemp, manualTemp } ]   # answered ones only
  heatSourceProbe: { <path>: "answered" | "refused" | "absent" | "transient" }

Setting = { value: str | number | None, min, max, allowed: [str], writeable: bool | None,
            step: number | None }
  faults:     [ { code, active, severity } ] | None   # None = the notifications read failed
"""
from __future__ import annotations

import math
import sys
from typing import Any, Dict, List, Optional

ROOM_TEMP_RANGE = (-40.0, 60.0)
HUMIDITY_RANGE = (0.0, 100.0)


def _finite(raw: Any) -> Optional[float]:
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    value = float(raw)
    return value if math.isfinite(value) else None


def _fault_markers(envelope: Dict[str, Any]) -> List[float]:
    """The sentinel values a sensor reports when it is open or shorted (`state` list)."""
    markers: List[float] = []
    state = envelope.get("state")
    if not isinstance(state, list):
        return markers
    for entry in state:
        if not isinstance(entry, dict):
            continue
        for raw in entry.values():
            number = _finite(raw)
            if number is not None:
                markers.append(number)
    return markers


def envelope_of(raw: Any) -> Optional[Dict[str, Any]]:
    """A resource payload, or None for an absent, refused (`{}`) or malformed one."""
    if not isinstance(raw, dict) or len(raw) == 0:
        return None
    if "value" not in raw and "values" not in raw:
        return None
    return raw


def number_of(raw: Any, bounds: Optional[tuple] = None) -> Optional[float]:
    envelope = envelope_of(raw)
    if envelope is None:
        return None
    value = _finite(envelope.get("value"))
    if value is None or value in _fault_markers(envelope):
        return None
    if bounds is not None and not bounds[0] <= value <= bounds[1]:
        return None
    return value


def text_of(raw: Any) -> Optional[str]:
    envelope = envelope_of(raw)
    if envelope is None:
        return None
    value = envelope.get("value")
    return value if isinstance(value, str) else None


def _string_list(raw: Any) -> List[str]:
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, str)]


def _writeable(raw: Any) -> Optional[bool]:
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, int):
        return raw != 0
    return None


def setting_of(raw: Any) -> Optional[Dict[str, Any]]:
    """One answered resource as a setting. A `values` list (holiday) answers with its first item."""
    envelope = envelope_of(raw)
    if envelope is None:
        return None
    if "value" in envelope:
        value = envelope.get("value")
        if isinstance(value, bool) or not isinstance(value, (str, int, float)):
            value = None
        elif not isinstance(value, str):
            value = _finite(value)
            if value is not None and value in _fault_markers(envelope):
                value = None
    else:
        listed = _string_list(envelope.get("values"))
        value = listed[0] if listed else ""
    return {
        "value": value,
        "min": _finite(envelope.get("minValue")),
        "max": _finite(envelope.get("maxValue")),
        "allowed": _string_list(envelope.get("allowedValues")),
        "writeable": _writeable(envelope.get("writeable")),
        "step": _finite(envelope.get("stepSize")),
    }


def emon_part(raw: Any, part: str) -> Optional[float]:
    """One part of an `emonValue`: the `values` item that is a dict carrying `part`."""
    envelope = envelope_of(raw)
    if envelope is None:
        return None
    values = envelope.get("values")
    if not isinstance(values, list):
        return None
    for item in values:
        if isinstance(item, dict) and part in item:
            return _finite(item[part])
    return None


def _first(source: Dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in source and source[key] not in (None, {}):
            return source[key]
    return None


def _ref_id(ref: Dict[str, Any]) -> Optional[str]:
    raw = ref.get("id")
    if not isinstance(raw, str):
        return None
    tail = [part for part in raw.split("/") if part]
    return tail[-1] if tail else None


def _starts(heat_sources: Dict[str, Any], aggregate: Any) -> Optional[float]:
    starts = _first(heat_sources, "starts", "numberOfStarts")
    total = emon_part(starts, "total")
    if total is not None:
        return total
    plain = number_of(starts)
    return plain if plain is not None else number_of(aggregate)


def _electrical_kwh(consumption: Any) -> Optional[float]:
    compressor = emon_part(consumption, "compressor")
    eheater = emon_part(consumption, "eheater")
    if compressor is None or eheater is None:
        return None
    return compressor + eheater


_DURATION_UNITS_S = {"s": 1.0, "sec": 1.0, "min": 60.0, "minutes": 60.0, "h": 3600.0, "hours": 3600.0}
_ENERGY_UNITS_KWH = {"wh": 0.001, "kwh": 1.0}
DEMAND_KINDS = ("dhw", "ch", "frost")
_RUNNING = ("on", "running", "active", "start", "started")
_STOPPED = ("off", "stopped", "stop", "inactive", "idle")


def _unit_of(raw: Any) -> Optional[str]:
    envelope = envelope_of(raw)
    unit = envelope.get("unitOfMeasure") if envelope is not None else None
    return unit.strip().lower() if isinstance(unit, str) else None


def working_time_seconds(raw: Any) -> Optional[float]:
    """The total working time in seconds. A unit the table does not know is unknown (D393)."""
    value = number_of(raw)
    factor = _DURATION_UNITS_S.get(_unit_of(raw) or "")
    return None if value is None or factor is None else value * factor


def energy_kwh(raw: Any) -> Optional[float]:
    """An energy reading in kWh: `Wh` and `kWh` are converted, any other unit is unknown."""
    value = number_of(raw)
    factor = _ENERGY_UNITS_KWH.get(_unit_of(raw) or "")
    return None if value is None or factor is None else value * factor


def heat_demand_of(raw: Any) -> Optional[str]:
    """`dhw` / `ch` / `frost`, `idle` for the empty answer, None when the read was refused."""
    envelope = envelope_of(raw)
    if envelope is None:
        return None
    listed = (
        _string_list(envelope.get("values"))
        if "values" in envelope
        else [envelope["value"]] if isinstance(envelope.get("value"), str) else []
    )
    for kind in DEMAND_KINDS:
        if kind in listed:
            return kind
    return "idle"


def compressor_running_of(raw: Any) -> Optional[bool]:
    """Whether the compressor runs: a word the gateway uses for on/off, or a number above 0."""
    envelope = envelope_of(raw)
    if envelope is None:
        return None
    value = envelope.get("value")
    if isinstance(value, str):
        word = value.strip().lower()
        return True if word in _RUNNING else False if word in _STOPPED else None
    number = number_of(raw)
    return None if number is None else number > 0


def normalize_heat_source(
    heat_sources: Any, outdoor: Any, aggregate_starts: Any = None
) -> Dict[str, Any]:
    hs = heat_sources if isinstance(heat_sources, dict) else {}
    consumption = _first(hs, "consumption", "totalConsumption")
    return {
        "heatPumpType": text_of(_first(hs, "pumpType", "type")),
        "supplyTemp": number_of(_first(hs, "actualSupplyTemperature", "supplyTemperature")),
        "returnTemp": number_of(hs.get("returnTemperature")),
        "modulationPct": number_of(_first(hs, "actualModulation", "modulation")),
        "pressureBar": number_of(hs.get("systemPressure")),
        "starts": _starts(hs, aggregate_starts),
        "outdoorTemp": number_of(outdoor if outdoor not in (None, {}) else hs.get("outdoorTemp")),
        "thermalKwh": emon_part(consumption, "outputProduced"),
        "electricalKwh": _electrical_kwh(consumption),
        "workingTimeS": working_time_seconds(hs.get("totalWorkingTime")),
        "heatDemand": heat_demand_of(hs.get("actualHeatDemand")),
        "compressorRunning": compressor_running_of(hs.get("compressorStatus")),
    }


PROBE_OUTCOMES = ("answered", "refused", "absent", "transient")


def probe_outcome(status: int) -> str:
    """One GET of a heat-pump-only resource, by HTTP status.

    The library reads a 403 and a 404 alike as an empty answer, so the identity resources
    are probed on their own: 200 answers; 403 and 500 mean the resource exists but is
    refused (a heat pump the gateway will not let us read); 404 means it is absent (a
    boiler); anything else (429, 502, 503, 504 …) is transient and proves nothing.
    """
    if status == 200:
        return "answered"
    if status in (403, 500):
        return "refused"
    if status == 404:
        return "absent"
    return "transient"


def notifications_from_response(status: int, body: Any) -> Optional[List[Any]]:
    """The notification list of one direct GET, or None when it was not answered.

    The library collapses a refused or failed read to `[]`, which reads as "no fault"; here
    anything but a 200 carrying a list (bare, or under `values`) is unknown.
    """
    if status != 200:
        return None
    if isinstance(body, dict):
        body = body.get("values")
    return body if isinstance(body, list) else None


def normalize_notifications(raw: Any) -> Optional[List[Dict[str, Any]]]:
    """Gateway notifications as faults: code `dcd-ccd`, active unless `act` is `H` (history),
    severity `error` when `dlv` is `8`, else `warning`. None stays None (unknown)."""
    if not isinstance(raw, list):
        return None
    faults: List[Dict[str, Any]] = []
    for item in raw:
        dcd = item.get("dcd") if isinstance(item, dict) else None
        ccd = item.get("ccd") if isinstance(item, dict) else None
        if not isinstance(dcd, str) or not isinstance(ccd, str):
            print(
                f"[homecom_worker] dropped a malformed notification: {type(item).__name__}",
                file=sys.stderr,
            )
            continue
        faults.append(
            {
                "code": f"{dcd}-{ccd}",
                "active": item.get("act") != "H",
                "severity": "error" if str(item.get("dlv")) == "8" else "warning",
            }
        )
    if len(raw) > 0 and len(faults) == 0:
        # A non-empty answer none of whose entries parse proves nothing: unknown, not "no fault".
        return None
    return faults


def _probe_map(raw: Any) -> Dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    return {
        path: outcome
        for path, outcome in raw.items()
        if isinstance(path, str) and outcome in PROBE_OUTCOMES
    }


def normalize_heating_circuit(ref: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    circuit_id = _ref_id(ref)
    if circuit_id is None:
        return None
    name = ref.get("name")
    return {
        "id": circuit_id,
        "name": name if isinstance(name, str) and name.strip() else None,
        "operationMode": setting_of(ref.get("operationMode")),
        "heatCoolMode": setting_of(ref.get("heatCoolMode")),
        "currentSuWiMode": setting_of(ref.get("currentSuWiMode")),
        "suWiSwitchMode": setting_of(ref.get("suWiSwitchMode")),
        "roomTemp": number_of(_first(ref, "roomTemp", "roomtemperature"), ROOM_TEMP_RANGE),
        "humidity": number_of(ref.get("actualHumidity"), HUMIDITY_RANGE),
        "currentRoomSetpoint": setting_of(ref.get("currentRoomSetpoint")),
        "manualRoomSetpoint": setting_of(ref.get("manualRoomSetpoint")),
        "coolingRoomSetpoint": setting_of(ref.get("coolingRoomTempSetpoint")),
        "comfortSetpoint": setting_of(ref.get("temperatureLevelComfort2")),
        "ecoSetpoint": setting_of(ref.get("temperatureLevelEco")),
        "maxFlowTemp": setting_of(ref.get("maxFlowTemp")),
        "controlType": setting_of(ref.get("controlType")),
    }


def normalize_dhw_circuit(
    ref: Dict[str, Any], charge_duration: Any = None, charge: Any = None
) -> Optional[Dict[str, Any]]:
    circuit_id = _ref_id(ref)
    if circuit_id is None:
        return None
    levels: Dict[str, Any] = {}
    raw_levels = ref.get("tempLevel")
    if isinstance(raw_levels, dict):
        for level, payload in raw_levels.items():
            setting = setting_of(payload)
            if isinstance(level, str) and setting is not None:
                levels[level] = setting
    duration = ref.get("chargeDuration")
    own_charge = ref.get("charge")
    return {
        "id": circuit_id,
        "operationMode": setting_of(ref.get("operationMode")),
        "actualTemp": number_of(ref.get("actualTemp")),
        "currentTemperatureLevel": setting_of(ref.get("currentTemperatureLevel")),
        "charge": setting_of(own_charge if own_charge not in (None, {}) else charge),
        "chargeDuration": setting_of(duration if duration not in (None, {}) else charge_duration),
        "singleChargeSetpoint": setting_of(ref.get("singleChargeSetpoint")),
        "currentSetpoint": setting_of(ref.get("currentSetpoint")),
        "temperatureLevels": levels,
    }


def normalize_solar_circuit(ref: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    circuit_id = _ref_id(ref)
    if circuit_id is None:
        return None
    return {
        "id": circuit_id,
        "collectorTemp": number_of(ref.get("collectorTemperature")),
        "tankTemp": number_of(ref.get("dhwTankTemperature")),
        "tankBottomTemp": number_of(ref.get("dhwTankBottomTemperature")),
        "maxCylinderTemp": number_of(ref.get("maxCylinderTemperature")),
        "yieldKwh": energy_kwh(ref.get("solarYield")),
    }


def normalize_zone(ref: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """A zone; None when the gateway refused every one of its resources (nothing to show)."""
    zone_id = _ref_id(ref)
    if zone_id is None:
        return None
    zone = {
        "id": zone_id,
        "userMode": setting_of(ref.get("userMode")),
        "setpointTemp": number_of(ref.get("tempSetpoint")),
        "currentTemp": number_of(ref.get("temperatureActual"), ROOM_TEMP_RANGE),
        "manualTemp": setting_of(ref.get("manualTemperatureHeating")),
    }
    answered = any(value is not None for key, value in zone.items() if key != "id")
    return zone if answered else None


def _refs(raw: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    return [ref for ref in raw if isinstance(ref, dict)]


def normalize_reading(
    device: Dict[str, Any], extras: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """`device` is the library's update dataclass as a dict; `extras` the separate reads.

    extras keys: `silentMode`, `additionalHeaterMode`, `aggregateStarts`,
    `chargeDuration` and `charge` ({ dhw id: payload }), `heatSourceProbe` ({ path: probe outcome }),
    `notifications` (the list of the direct read, or None when it was not answered).
    """
    more = extras or {}
    durations = more.get("chargeDuration") if isinstance(more.get("chargeDuration"), dict) else {}
    heating = [normalize_heating_circuit(ref) for ref in _refs(device.get("heating_circuits"))]
    charges = more.get("charge") if isinstance(more.get("charge"), dict) else {}
    dhw = [
        normalize_dhw_circuit(ref, durations.get(_ref_id(ref) or ""), charges.get(_ref_id(ref) or ""))
        for ref in _refs(device.get("dhw_circuits"))
    ]
    solar = [normalize_solar_circuit(ref) for ref in _refs(device.get("solar_circuits"))]
    zones = [normalize_zone(ref) for ref in _refs(device.get("zones"))]
    return {
        "heatSource": normalize_heat_source(
            device.get("heat_sources"), device.get("outdoor_temp"), more.get("aggregateStarts")
        ),
        "system": {
            "away": setting_of(device.get("away_mode")),
            "silent": setting_of(more.get("silentMode")),
            "additionalHeater": setting_of(more.get("additionalHeaterMode")),
            "holiday": setting_of(device.get("holiday_mode")),
        },
        "heatingCircuits": [c for c in heating if c is not None],
        "dhwCircuits": [c for c in dhw if c is not None],
        "solarCircuits": [c for c in solar if c is not None],
        "zones": [z for z in zones if z is not None],
        "heatSourceProbe": _probe_map(more.get("heatSourceProbe")),
        "faults": normalize_notifications(more.get("notifications")),
    }
