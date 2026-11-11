#!/usr/bin/env python3
"""One-shot HomeCom Easy reader/writer for a heat-pump gateway (k40, k30, icom).

Runs the MIT `homecom_alt` library (its device classes' own bulk read and write methods),
one spawn per poll. The OAuth login, the keychain and the token refresh stay in
TypeScript: this script receives a short-lived access token on stdin and nothing else. The
library is built with `auth_provider=False`, so it never refreshes, never logs in, and never
writes a token anywhere; nothing here touches the disk.

stdin JSON:  { "token": "<access token>", "gatewayId": "101…", "deviceType": "k40",
               "action": "read" }
          or { …, "action": "write", "write": { "op": "<op>", "circuitId"?: "hc1",
               "level"?: "eco", "value": <string | number> } }
stdout JSON: { "ok": true, "reading": { … } }          (read; shape in homecom_normalize.py)
          or { "ok": true, "written": "<op>" }          (write)
          or { "ok": false, "kind": "auth|unreachable|refused|api|protocol|bad-request",
               "error": "…" }
Diagnostics go to stderr. The token is never printed, on either stream.
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

from homecom_normalize import normalize_reading, probe_outcome  # noqa: E402

DEVICE_TYPES = ("k40", "k30", "icom")


class WorkerError(Exception):
    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


def _text(request: Dict[str, Any], key: str) -> str:
    value = request.get(key)
    if not isinstance(value, str) or len(value) == 0:
        raise WorkerError("bad-request", f"{key} must be a non-empty string")
    return value


def _scalar(write: Dict[str, Any]) -> Any:
    value = write.get("value")
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise WorkerError("bad-request", "write.value must be a string or a number")
    return value


WriteCall = Callable[[Any, str, Dict[str, Any]], Awaitable[None]]


def _circuit(write: Dict[str, Any]) -> str:
    return _text(write, "circuitId")


WRITES: Dict[str, WriteCall] = {
    "hcOperationMode": lambda c, d, w: c.async_put_hc_operation_mode(d, _circuit(w), _scalar(w)),
    "hcHeatCoolMode": lambda c, d, w: c.async_put_hc_heatcool_mode(d, _circuit(w), _scalar(w)),
    "hcSuWiSwitchMode": lambda c, d, w: c.async_put_hc_suwi_switch_mode(
        d, _circuit(w), _scalar(w)
    ),
    "hcManualRoomSetpoint": lambda c, d, w: c.async_set_hc_manual_room_setpoint(
        d, _circuit(w), _scalar(w)
    ),
    "hcCoolingRoomSetpoint": lambda c, d, w: c.async_set_hc_cooling_room_temp_setpoint(
        d, _circuit(w), _scalar(w)
    ),
    "hcComfortSetpoint": lambda c, d, w: c.async_set_hc_temp_level_comfort2(
        d, _circuit(w), _scalar(w)
    ),
    "hcEcoSetpoint": lambda c, d, w: c.async_set_hc_temp_level_eco(d, _circuit(w), _scalar(w)),
    "hcMaxFlowTemp": lambda c, d, w: c.async_set_hc_max_flow_temp(d, _circuit(w), _scalar(w)),
    "dhwOperationMode": lambda c, d, w: c.async_put_dhw_operation_mode(
        d, _circuit(w), _scalar(w)
    ),
    "dhwTemperatureLevel": lambda c, d, w: c.async_put_dhw_current_temp_level(
        d, _circuit(w), _scalar(w)
    ),
    "dhwLevelTemp": lambda c, d, w: c.async_set_dhw_temp_level(
        d, _circuit(w), _text(w, "level"), _scalar(w)
    ),
    "dhwCharge": lambda c, d, w: c.async_set_dhw_charge(d, _circuit(w), _scalar(w)),
    "dhwChargeDuration": lambda c, d, w: c.async_set_dhw_charge_duration(
        d, _circuit(w), _scalar(w)
    ),
    "awayMode": lambda c, d, w: c.async_put_away_mode(d, _scalar(w)),
    "silentMode": lambda c, d, w: c.async_put_silent_mode(d, _scalar(w)),
    "additionalHeaterMode": lambda c, d, w: c.async_put_additional_heater_mode(d, _scalar(w)),
    "holidayMode": lambda c, d, w: c.async_put_holiday_mode(d, _scalar(w)),
}


def parse_request(raw: str) -> Dict[str, Any]:
    """Validate stdin before any library import. Raises WorkerError('bad-request')."""
    try:
        request = json.loads(raw)
    except json.JSONDecodeError as err:
        raise WorkerError("bad-request", f"stdin is not JSON: {err.msg}") from None
    if not isinstance(request, dict):
        raise WorkerError("bad-request", "stdin must be a JSON object")
    _text(request, "token")
    _text(request, "gatewayId")
    if request.get("deviceType") not in DEVICE_TYPES:
        raise WorkerError("bad-request", f"deviceType must be one of {', '.join(DEVICE_TYPES)}")
    action = request.get("action")
    if action == "write":
        write = request.get("write")
        if not isinstance(write, dict) or write.get("op") not in WRITES:
            raise WorkerError("bad-request", "write.op is not a known write")
    elif action != "read":
        raise WorkerError("bad-request", "action must be read or write")
    return request


def _as_dict(value: Any) -> Dict[str, Any]:
    if is_dataclass(value) and not isinstance(value, type):
        return asdict(value)
    return value if isinstance(value, dict) else {}


async def _optional(call: Awaitable[Any]) -> Any:
    """An extra read the device may not have: its failure is an unknown value, never fatal."""
    from homecom_alt import AuthFailedError

    try:
        return await call
    except AuthFailedError:
        raise
    except Exception as err:  # noqa: BLE001 - one unanswered extra must not sink the poll
        print(f"[homecom_worker] optional read failed: {type(err).__name__}", file=sys.stderr)
        return None


HEAT_SOURCE_IDENTITY = ("/heatSources/hs1/heatPumpType", "/heatSources/hs1/heatPumpPower")
PROBE_TIMEOUT_S = 15


async def _probe_heat_source(session: Any, token: str, gateway_id: str) -> Dict[str, str]:
    """GET each heat-pump-only resource and keep its outcome (see `probe_outcome`).

    Only asked when the bulk read left the heat-pump type unknown: a gateway that refuses
    its heat source still has a heat pump, and the library cannot tell that from a 404.
    """
    import aiohttp
    from homecom_alt.const import BOSCHCOM_DOMAIN, BOSCHCOM_ENDPOINT_GATEWAYS

    outcomes: Dict[str, str] = {}
    for path in HEAT_SOURCE_IDENTITY:
        url = f"{BOSCHCOM_DOMAIN}{BOSCHCOM_ENDPOINT_GATEWAYS}{gateway_id}/resource{path}"
        try:
            async with session.get(
                url,
                headers={"Authorization": f"Bearer {token}"},
                timeout=aiohttp.ClientTimeout(total=PROBE_TIMEOUT_S),
            ) as resp:
                outcomes[path] = probe_outcome(resp.status)
        except (aiohttp.ClientError, asyncio.TimeoutError) as err:
            print(f"[homecom_worker] probe failed: {type(err).__name__}", file=sys.stderr)
            outcomes[path] = "transient"
    return outcomes


async def _read(
    client: Any, session: Any, token: str, gateway_id: str, device_type: str
) -> Dict[str, Any]:
    device = _as_dict(await client.async_update(gateway_id))
    extras: Dict[str, Any] = {
        "aggregateStarts": await _optional(client.async_get_hs_total_number_of_starts(gateway_id)),
    }
    if device_type != "icom":
        extras["silentMode"] = await _optional(client.async_get_silent_mode(gateway_id))
        extras["additionalHeaterMode"] = await _optional(
            client.async_get_additional_heater_mode(gateway_id)
        )
        durations: Dict[str, Any] = {}
        for ref in device.get("dhw_circuits") or []:
            dhw_id = str(ref.get("id", "")).split("/")[-1] if isinstance(ref, dict) else ""
            if dhw_id:
                durations[dhw_id] = await _optional(
                    client.async_get_dhw_charge_duration(gateway_id, dhw_id)
                )
        extras["chargeDuration"] = durations
    if normalize_reading(device)["heatSource"]["heatPumpType"] is None:
        extras["heatSourceProbe"] = await _probe_heat_source(session, token, gateway_id)
    return normalize_reading(device, extras)


async def run(request: Dict[str, Any]) -> Dict[str, Any]:
    import aiohttp
    from homecom_alt import (
        ApiError,
        AuthFailedError,
        ConnectionOptions,
        HomeComIcom,
        HomeComK40,
        NotRespondingError,
    )

    gateway_id = request["gatewayId"]
    device_type = request["deviceType"]
    options = ConnectionOptions(token=request["token"], auth_provider=False)
    cls = HomeComIcom if device_type == "icom" else HomeComK40
    try:
        async with aiohttp.ClientSession() as session:
            client = cls(session, options, gateway_id, False)
            if request["action"] == "read":
                reading = await _read(client, session, request["token"], gateway_id, device_type)
                return {"ok": True, "reading": reading}
            write = request["write"]
            await WRITES[write["op"]](client, gateway_id, write)
            return {"ok": True, "written": write["op"]}
    except AuthFailedError:
        raise WorkerError("auth", "HomeCom refused the access token") from None
    except NotRespondingError as err:
        raise WorkerError("unreachable", f"HomeCom did not respond: {err}") from None
    except ApiError as err:
        raise WorkerError("refused", f"HomeCom refused the request: {err}") from None
    except aiohttp.ClientError as err:
        raise WorkerError("unreachable", f"{type(err).__name__}: {err}") from None


def _emit(answer: Dict[str, Any]) -> None:
    print(json.dumps(answer), flush=True)


def main() -> int:
    # The library logs request URLs at DEBUG; WARNING on stderr carries no token.
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    try:
        request = parse_request(sys.stdin.read())
        _emit(asyncio.run(run(request)))
        return 0
    except WorkerError as err:
        _emit({"ok": False, "kind": err.kind, "error": str(err)})
        return 1
    except Exception as err:  # noqa: BLE001 - the bridge needs one JSON answer, always
        _emit({"ok": False, "kind": "api", "error": f"{type(err).__name__}: {err}"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
