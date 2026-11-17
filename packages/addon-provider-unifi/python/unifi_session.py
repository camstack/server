"""One UniFi Network controller, signed in with a LOCAL account, through aiounifi.

aiounifi (the library Home Assistant's UniFi integration is built on) speaks the
classic Network API on a UniFi OS console and on a legacy controller alike:
sign-in, devices, the port table, clients, PoE mode per port (it keeps every
other port's override), restart, port power-cycle, the LED, and the websocket
event stream. This module turns its objects into the plain JSON the addon reads
and its exceptions into a typed failure kind.

The password arrives as the path of an owner-only file (the addon writes it
0600 and deletes it once `connect` answered); it is held in memory for the
life of the session (re-sign-in after the websocket drops) and never logged.
"""

from __future__ import annotations

import asyncio
import ssl
from collections.abc import Awaitable, Callable
from typing import Any

import aiohttp
from aiounifi.controller import Controller
from aiounifi.errors import (
    AiounifiException,
    Forbidden,
    LoginRequired,
    NoPermission,
    RequestError,
    ResponseError,
    TwoFaTokenRequired,
    Unauthorized,
)
from aiounifi.interfaces.api_handlers import ItemEvent
from aiounifi.models.client import ClientListRequest
from aiounifi.models.configuration import Configuration
from aiounifi.models.device import (
    Device,
    DevicePowerCyclePortRequest,
    DeviceRestartRequest,
    DeviceSetLedStatus,
    DeviceSetPoePortModeRequest,
)
from aiounifi.models.event import Event, EventKey
from aiounifi.models.site import SiteListRequest

Emit = Callable[[dict], None]

#: The websocket reconnects with this backoff (seconds), then gives up and says so;
#: the addon's reconcile poll keeps reading the controller either way.
WS_BACKOFF_S = (2, 5, 10, 30, 60, 60, 60, 60)
#: Changes arriving together (one websocket frame updates many items) push ONE snapshot.
PUSH_COALESCE_S = 0.25

_DISCONNECT_EVENTS = (
    EventKey.WIRED_CLIENT_DISCONNECTED,
    EventKey.WIRELESS_CLIENT_DISCONNECTED,
    EventKey.WIRED_GUEST_DISCONNECTED,
    EventKey.WIRELESS_GUEST_DISCONNECTED,
)
_CONNECT_EVENTS = (
    EventKey.WIRED_CLIENT_CONNECTED,
    EventKey.WIRELESS_CLIENT_CONNECTED,
    EventKey.WIRED_GUEST_CONNECTED,
    EventKey.WIRELESS_GUEST_CONNECTED,
)


class WorkerFailure(Exception):
    """A failure with the kind the addon maps onto its typed errors."""

    def __init__(self, kind: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.extra = extra

    def to_answer(self) -> dict:
        return {"ok": False, "kind": self.kind, "error": self.message, **self.extra}


def classify(err: BaseException, status: int | None = None) -> WorkerFailure:
    """Name the cause of a failed call. `status` is the last sign-in HTTP status, when known."""
    if isinstance(err, WorkerFailure):
        return err
    if isinstance(err, TwoFaTokenRequired) or status == 499:
        return WorkerFailure(
            "mfa",
            "unifi: this account requires two-factor sign-in — use a LOCAL account of the console "
            "(not a UI.com account) without two-factor sign-in",
        )
    if isinstance(err, (Unauthorized, LoginRequired)):
        return WorkerFailure(
            "auth",
            "unifi: the controller refused the username or password — use a LOCAL account of the "
            "console, not a UI.com account",
        )
    if isinstance(err, (Forbidden, NoPermission)):
        return WorkerFailure(
            "auth", "unifi: the account may not do this — it needs admin rights on the site"
        )
    if isinstance(err, RequestError):
        text = str(err)
        if "certificate" in text.lower():
            return WorkerFailure(
                "tls",
                "unifi: the console's certificate is not trusted — the console uses a self-signed "
                'certificate: turn on "Accept self-signed certificate"',
            )
        return WorkerFailure("unreachable", f"unifi: the controller could not be reached: {text}")
    if isinstance(err, (aiohttp.ClientError, asyncio.TimeoutError, OSError)):
        return WorkerFailure("unreachable", f"unifi: the controller could not be reached: {err}")
    if isinstance(err, ResponseError) and "429" in str(err):
        return WorkerFailure("api", "unifi: the controller is rate-limiting; try again later")
    if isinstance(err, AiounifiException):
        return WorkerFailure("api", f"unifi: the controller refused the call: {type(err).__name__}")
    return WorkerFailure("api", f"unifi: {type(err).__name__}: {err}")


def _number(value: Any) -> float | None:
    if value is None:
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if n == n and n not in (float("inf"), float("-inf")) else None


def _client_label(raw: dict) -> str | None:
    label = raw.get("name") or raw.get("hostname") or ""
    return label if label else None


def wired_index(clients: list[dict]) -> dict[str, dict]:
    """The wired client on each `<switch mac>:<port>` (`sw_mac` + `sw_port`)."""
    index: dict[str, dict] = {}
    for c in clients:
        sw_mac, sw_port = c.get("sw_mac"), c.get("sw_port")
        if not sw_mac or sw_port is None or c.get("is_wired") is False:
            continue
        index[f"{str(sw_mac).lower()}:{sw_port}"] = c
    return index


def normalize_port(device_mac: str, port: dict, wired: dict[str, dict]) -> dict:
    idx = port.get("port_idx")
    up = port.get("up")
    link_up = bool(up) if up is not None else None
    speed = port.get("speed")
    client = wired.get(f"{device_mac}:{idx}")
    m_a = _number(port.get("poe_current"))
    mode = port.get("poe_mode")
    return {
        "idx": idx,
        "poeCapable": port.get("port_poe") is True or (port.get("poe_caps") or 0) > 0,
        "poeOn": mode != "off" if mode is not None else port.get("poe_enable") is True,
        "poeMode": mode,
        "linkUp": link_up,
        "speedMbps": speed if link_up is True and isinstance(speed, (int, float)) and speed > 0 else None,
        "poePowerW": _number(port.get("poe_power")),
        "poeVoltageV": _number(port.get("poe_voltage")),
        "poeCurrentA": None if m_a is None else m_a / 1000,
        "clientMac": None if client is None else str(client.get("mac", "")).lower() or None,
        "clientName": None if client is None else _client_label(client),
    }


def _cpu_temperature(raw: dict) -> float | None:
    if raw.get("general_temperature") is not None:
        return _number(raw.get("general_temperature"))
    for t in raw.get("temperatures") or []:
        if "cpu" in str(t.get("name", "")).lower():
            return _number(t.get("value"))
    return None


def normalize_device(raw: dict, wired: dict[str, dict]) -> dict:
    mac = str(raw.get("mac", "")).lower()
    stats = raw.get("system-stats") or {}
    return {
        # `_id` (= `device_id`) is the id the classic API has always named the device by.
        "id": raw.get("_id") or raw.get("device_id") or mac,
        "mac": mac or None,
        "ip": raw.get("ip") or None,
        "serial": raw.get("serial") or None,
        "name": raw.get("name") or mac,
        "model": raw.get("model") or "",
        "type": raw.get("type"),
        "state": raw.get("state"),
        "uptimeSec": raw.get("uptime"),
        "cpuPercent": _number(stats.get("cpu")),
        "memoryPercent": _number(stats.get("mem")),
        "cpuTempC": _cpu_temperature(raw),
        "clients": raw.get("num_sta") or 0,
        "ledOverride": raw.get("led_override"),
        "ports": [normalize_port(mac, p, wired) for p in raw.get("port_table") or [] if "port_idx" in p],
    }


def normalize_client(raw: dict) -> dict:
    return {
        "mac": str(raw.get("mac", "")).lower(),
        "hostname": raw.get("name") or raw.get("hostname") or "",
        "ip": raw.get("ip") or None,
    }


ControllerFactory = Callable[[Configuration], Controller]


class UnifiSession:
    """The signed-in controller and its live tables. One per worker process."""

    def __init__(
        self,
        emit: Emit,
        make_controller: ControllerFactory = Controller,
        make_http: Callable[[], Awaitable[aiohttp.ClientSession]] | None = None,
    ) -> None:
        self._emit = emit
        self._make_controller = make_controller
        self._make_http = make_http
        self._http: aiohttp.ClientSession | None = None
        self.controller: Controller | None = None
        self._login_status: int | None = None
        #: MACs of the clients connected now: a full listing, then websocket sync/disconnect.
        self._connected: set[str] = set()
        self._ws_task: asyncio.Task | None = None
        self._push_handle: asyncio.TimerHandle | None = None
        self._unsubscribe: list[Callable[[], None]] = []

    # ---- sign-in -------------------------------------------------------------------------

    async def _new_http(self) -> aiohttp.ClientSession:
        if self._make_http is not None:
            return await self._make_http()

        async def on_end(_s: Any, _c: Any, params: aiohttp.TraceRequestEndParams) -> None:
            if str(params.url).endswith(("/api/auth/login", "/api/login")):
                self._login_status = params.response.status

        trace = aiohttp.TraceConfig()
        trace.on_request_end.append(on_end)
        return aiohttp.ClientSession(
            cookie_jar=aiohttp.CookieJar(unsafe=True),
            trace_configs=[trace],
            timeout=aiohttp.ClientTimeout(total=15),
        )

    async def _login(self) -> None:
        controller = self._require()
        self._login_status = None
        try:
            await controller.login()
        except Exception as err:  # noqa: BLE001 — classified, never swallowed
            raise classify(err, self._login_status) from None
        status = self._login_status
        # aiounifi treats a JSON answer without an error envelope as success; a UniFi OS console
        # answers a second-factor account 499 with exactly that.
        if status is not None and not 200 <= status < 300:
            if status == 499:
                raise classify(TwoFaTokenRequired(), status)
            if status in (400, 401, 403):
                raise classify(Unauthorized(), status)
            if status == 429:
                raise WorkerFailure("api", "unifi: the controller is rate-limiting sign-in; try again later")
            raise WorkerFailure("api", f"unifi: sign-in answered HTTP {status}")

    async def connect(self, request: dict) -> dict:
        await self.close()
        with open(request["passwordFile"], encoding="utf-8") as fh:
            password = fh.read()
        self._http = await self._new_http()
        ssl_context: ssl.SSLContext | bool = (
            False if request.get("allowSelfSigned") else ssl.create_default_context()
        )
        config = Configuration(
            self._http,
            request["host"],
            username=request["username"],
            password=password,
            port=int(request["port"]),
            site="default",
            ssl_context=ssl_context,
        )
        self.controller = self._make_controller(config)
        await self._login()
        site = await self._find_site(str(request.get("site") or "default"))
        self.controller.connectivity.config.site = site
        await self._refresh()
        self._subscribe()
        self._ws_task = asyncio.ensure_future(self._run_websocket())
        return {"site": site}

    async def _find_site(self, wanted: str) -> str:
        try:
            raw = await self._require().request(SiteListRequest.create())
        except Exception as err:  # noqa: BLE001
            raise classify(err) from None
        sites = [s for s in raw.get("data", []) if isinstance(s, dict) and "name" in s]
        ref = wanted.lower()
        for s in sites:
            if s["name"].lower() == ref or str(s.get("desc", "")).lower() == ref:
                return s["name"]
        raise WorkerFailure(
            "site-not-found",
            f'unifi: site "{wanted}" not found on the console',
            site=wanted,
            available=[s["name"] for s in sites],
        )

    async def close(self) -> None:
        for unsubscribe in self._unsubscribe:
            unsubscribe()
        self._unsubscribe = []
        if self._ws_task is not None:
            self._ws_task.cancel()
            self._ws_task = None
        if self._push_handle is not None:
            self._push_handle.cancel()
            self._push_handle = None
        if self._http is not None:
            await self._http.close()
            self._http = None
        self.controller = None
        self._connected = set()

    def _require(self) -> Controller:
        if self.controller is None:
            raise WorkerFailure("not-connected", "unifi: the worker is not signed in")
        return self.controller

    # ---- tables --------------------------------------------------------------------------

    async def _refresh(self) -> None:
        controller = self._require()
        try:
            await controller.devices.update()
            raw = await controller.request(ClientListRequest.create())
        except WorkerFailure:
            raise
        except Exception as err:  # noqa: BLE001
            raise classify(err) from None
        listed = [c for c in raw.get("data", []) if isinstance(c, dict) and "mac" in c]
        controller.clients.process_raw(listed)
        self._connected = {str(c["mac"]) for c in listed}

    def snapshot(self) -> dict:
        controller = self._require()
        clients = [
            controller.clients[mac].raw for mac in self._connected if mac in controller.clients
        ]
        wired = wired_index(clients)
        return {
            "devices": [normalize_device(d.raw, wired) for d in controller.devices.values()],
            "clients": [normalize_client(c) for c in clients],
        }

    async def list(self, refresh: bool) -> dict:
        if refresh:
            await self._refresh()
        return self.snapshot()

    def _device(self, device_id: str) -> Device:
        for device in self._require().devices.values():
            if device.raw.get("_id") == device_id or device.raw.get("device_id") == device_id:
                return device
        raise WorkerFailure("not-found", f"unifi: device {device_id} is not on the site")

    # ---- commands ------------------------------------------------------------------------

    async def _call(self, request: Any) -> None:
        try:
            await self._require().request(request)
        except WorkerFailure:
            raise
        except Exception as err:  # noqa: BLE001
            raise classify(err) from None

    async def set_poe(self, device_id: str, port_idx: int, on: bool) -> None:
        """Switch ONE port's PoE. The device is read FRESH first, so the PUT carries the
        controller's current overrides; aiounifi sends every other port's override back whole."""
        try:
            await self._require().devices.update()
        except WorkerFailure:
            raise
        except Exception as err:  # noqa: BLE001
            raise classify(err) from None
        device = self._device(device_id)
        if not any(p.get("port_idx") == port_idx for p in device.port_table):
            raise WorkerFailure("bad-request", f"unifi: device {device_id} has no port {port_idx}")
        await self._call(
            DeviceSetPoePortModeRequest.create(device, port_idx=port_idx, mode="auto" if on else "off")
        )

    async def set_led(self, device_id: str, on: bool) -> None:
        await self._call(DeviceSetLedStatus.create(self._device(device_id), status="on" if on else "off"))

    async def restart(self, device_id: str) -> None:
        await self._call(DeviceRestartRequest.create(self._device(device_id).mac))

    async def power_cycle(self, device_id: str, port_idx: int) -> None:
        await self._call(DevicePowerCyclePortRequest.create(self._device(device_id).mac, port_idx))

    # ---- websocket -----------------------------------------------------------------------

    def _subscribe(self) -> None:
        controller = self._require()

        def changed(_event: ItemEvent, _obj_id: str) -> None:
            self._schedule_push()

        def client_changed(event: ItemEvent, mac: str) -> None:
            if event is ItemEvent.DELETED:
                self._connected.discard(mac)
            else:
                self._connected.add(mac)
            self._schedule_push()

        def client_event(event: Event) -> None:
            mac = event.client
            if not mac:
                return
            if event.key in _DISCONNECT_EVENTS:
                self._connected.discard(mac)
            elif mac in controller.clients:
                self._connected.add(mac)
            self._schedule_push()

        self._unsubscribe = [
            controller.devices.subscribe(changed),
            controller.clients.subscribe(client_changed),
            controller.events.subscribe(client_event, _DISCONNECT_EVENTS + _CONNECT_EVENTS),
        ]

    def _schedule_push(self) -> None:
        if self._push_handle is not None or self.controller is None:
            return
        loop = asyncio.get_running_loop()
        self._push_handle = loop.call_later(PUSH_COALESCE_S, self._push_now)

    def _push_now(self) -> None:
        self._push_handle = None
        if self.controller is None:
            return
        self._emit({"push": "snapshot", **self.snapshot()})

    async def _run_websocket(self) -> None:
        """The event stream, reconnected with a bounded backoff. A refused re-sign-in stops it:
        retrying a refused password on a timer only locks the account."""
        failures = 0
        while self.controller is not None:
            self._emit({"push": "channel", "state": "up"})
            try:
                await self.controller.start_websocket()
                reason = "the controller closed the event stream"
            except asyncio.CancelledError:
                raise
            except Exception as err:  # noqa: BLE001
                reason = classify(err).message
            failures += 1
            if failures > len(WS_BACKOFF_S):
                self._emit({"push": "channel", "state": "failed", "reason": reason})
                return
            delay = WS_BACKOFF_S[failures - 1]
            self._emit({"push": "channel", "state": "down", "reason": reason, "retryInMs": delay * 1000})
            await asyncio.sleep(delay)
            try:
                await self._login()
                await self._refresh()
                self._schedule_push()
                failures = 0
            except WorkerFailure as failure:
                if failure.kind in ("auth", "mfa"):
                    self._emit({"push": "channel", "state": "failed", "reason": failure.message})
                    return
