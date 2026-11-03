"""alexapy adapter. Imported only when the worker starts, so unit tests can mock the gateway.

Never log the refresh token, the cookie blob, or the session file contents.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from types import SimpleNamespace

from alexa_sequences import EchoTarget, build_volume_node

REGIONS = ("NA", "EU", "FE")
REGION_LOCALE = {"NA": "en-US", "EU": "en-GB", "FE": "ja-JP"}

# The `/api/np/command` bodies. Only these four are offered.
NP_COMMANDS = {
    "play": "PlayCommand",
    "pause": "PauseCommand",
    "next": "NextCommand",
    "previous": "PreviousCommand",
}
RATE_LIMITED = "rate-limited"


class RateLimitedError(Exception):
    """Amazon answered 429. It is a refusal to retry later, never an empty answer."""

    code = RATE_LIMITED


def is_rate_limited(err: BaseException) -> bool:
    """alexapy raises AlexapyTooManyRequestsError; matched by name so this module needs no import of it."""
    return any(kind.__name__ == "AlexapyTooManyRequestsError" for kind in type(err).__mro__)


def classify_login(status: dict) -> str:
    """The worker signs in with the broker's token, so a sign-in either works or it does not."""
    return "ok" if status.get("login_successful") is True else "failed"


def bare_domain(domain: str) -> str:
    """alexapy wants the registrable Amazon domain: no scheme, no `www.` or `alexa.` host."""
    text = domain.strip().lower()
    for prefix in ("https://", "http://"):
        if text.startswith(prefix):
            text = text[len(prefix) :]
    text = text.split("/", 1)[0]
    for host in ("www.", "alexa."):
        if text.startswith(host):
            text = text[len(host) :]
    return text or "amazon.com"


def session_output(session_path: str):
    """alexapy asks a callable where each of its files goes. Its primary cookie jar
    is ours: the file the addon keeps (in the keychain) between runs."""
    session = Path(session_path)

    def output(name: str) -> str:
        if name.startswith(".storage/") and name.endswith(".pickle"):
            return str(session)
        return str(session.parent / name.replace("/", "_"))

    return output


def normalize_device(raw: dict) -> dict | None:
    serial = raw.get("serialNumber") or raw.get("deviceSerialNumber")
    if not isinstance(serial, str) or serial == "":
        return None
    family = str(raw.get("deviceFamily") or "")
    name = str(raw.get("accountName") or raw.get("deviceOwnerCustomerId") or serial)
    online = bool(raw.get("online", True))
    dnd = bool(raw.get("dnd") or raw.get("dndEnabled"))
    kind = "group" if family.upper() == "WHA" else "device"
    room = str(raw.get("roomName") or raw.get("room") or "")
    result = {
        "id": serial,
        "name": name,
        "family": family,
        "online": online,
        "kind": kind,
        "dnd": dnd,
        "deviceType": str(raw.get("deviceType") or raw.get("deviceTypeId") or ""),
        "customerId": str(raw.get("deviceOwnerCustomerId") or raw.get("customerId") or ""),
    }
    if room != "":
        result["room"] = room
    return result


# The skill alexapy itself names for an AlexaAnnouncement node.
ANNOUNCEMENT_SKILL_ID = "amzn1.ask.1p.routines.messaging"

VOLUMES_PATH = "/api/devices/deviceType/dsn/audio/v1/allDeviceVolumes"


class AlexaPyGateway:
    """Holds one AlexaLogin for the life of the process (one process per broker)."""

    def __init__(self) -> None:
        self._login = None
        self._devices: list[dict] = []
        self._logged_in = False
        self._signed_in_at: float | None = None
        self._last_success_at: float | None = None
        self._session_path = ""
        self._region = "EU"
        self._serial_locks: dict[str, asyncio.Lock] = {}

    def _lock(self, serial: str) -> asyncio.Lock:
        """One request at a time per Echo: Amazon throttles an account that hammers one device."""
        lock = self._serial_locks.get(serial)
        if lock is None:
            lock = asyncio.Lock()
            self._serial_locks[serial] = lock
        return lock

    def _api_for(self, serial: str, device_type: str):
        login = self._require_login()
        _AlexaLogin, AlexaAPI = _import_alexapy()
        shim = SimpleNamespace(device_serial_number=serial, _device_type=device_type, _locale=None)
        return AlexaAPI(shim, login)

    @property
    def region(self) -> str:
        return self._region

    def target_for(self, serial: str) -> EchoTarget | None:
        for device in self._devices:
            if device["id"] == serial:
                return {
                    "id": device["id"],
                    "deviceType": device["deviceType"],
                    "customerId": device["customerId"],
                }
        return None

    async def login_broker(
        self,
        label: str,
        refresh_token: str,
        device_app_name: str,
        domain: str,
        region: str,
        session_path: str,
    ) -> dict:
        """Sign in as the account an import broker already signed in as.

        The broker's refresh token is exchanged for this session's cookies; with
        no token, the jar stored from an earlier run is tried. `label` is not an
        e-mail address, so alexapy takes it as a mobile account and does not
        compare it with the account's address.
        """
        self._region = region if region in REGIONS else "EU"
        self._session_path = session_path
        AlexaLogin, _AlexaAPI = _import_alexapy()
        oauth = {"refresh_token": refresh_token} if refresh_token != "" else {}
        login = AlexaLogin(
            bare_domain(domain), label, "", session_output(session_path), False, oauth=oauth
        )
        self._login = login
        cookies: dict = {}
        if refresh_token != "":
            exchanged = await _exchange_refresh_token(login, device_app_name)
            if not exchanged:
                return {
                    "status": "failed",
                    "error": "step 1 of 3, token exchange: Amazon refused the broker's token",
                }
            await login.save_cookiefile()
            # The exchange put its cookies in the live session; use them as they are. Reading
            # them back through the cookie file filters them by host and can come back empty.
            cookies = _session_cookies(login)
            if not cookies:
                cookies = await login.load_cookie() or {}
            if not cookies:
                return {
                    "status": "failed",
                    "error": "step 2 of 3, cookies: the token exchange was accepted but returned no cookies",
                }
        else:
            cookies = await login.load_cookie() or {}
            if not cookies:
                return {
                    "status": "failed",
                    "error": "step 2 of 3, cookies: no stored Amazon session and no broker token to start from",
                }
        await login.login(cookies=cookies)
        await self._persist_session()
        return self._status_result()

    async def devices(self) -> dict:
        login = self._require_login()
        _AlexaLogin, AlexaAPI = _import_alexapy()
        raw = await AlexaAPI.get_devices(login)
        rows = raw.get("devices") if isinstance(raw, dict) else raw
        if not isinstance(rows, list):
            rows = []
        devices = []
        for row in rows:
            if isinstance(row, dict):
                normalized = normalize_device(row)
                if normalized is not None:
                    devices.append(normalized)
        self._devices = devices
        self._touch_success()
        public = [
            {
                key: device[key]
                for key in ("id", "name", "family", "online", "kind", "dnd", "deviceType", "room")
                if key in device
            }
            for device in devices
        ]
        return {"devices": public}

    async def speak(self, sequence: dict, customer_id: str) -> None:
        login = self._require_login()
        _AlexaLogin, AlexaAPI = _import_alexapy()
        # alexapy 1.29.20: send_sequence/send_announcement are INSTANCE methods that read the
        # device behind the API object (type, serial, locale). Our payloads already carry the
        # target, so run the prebuilt node through run_behavior, which needs only the login.
        # queue_delay=0 posts at once instead of batching with other queued nodes.
        await AlexaAPI(None, login).run_behavior(sequence["startNode"], queue_delay=0)
        self._touch_success()

    async def announce(self, announcement: dict, customer_id: str) -> None:
        login = self._require_login()
        _AlexaLogin, AlexaAPI = _import_alexapy()
        node = {
            "@type": "com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode",
            "type": "AlexaAnnouncement",
            "operationPayload": {
                "expireAfter": announcement["expireAfter"],
                "content": announcement["content"],
                "target": announcement["target"],
                "customerId": customer_id,
                "skillId": ANNOUNCEMENT_SKILL_ID,
            },
        }
        await AlexaAPI(None, login).run_behavior(node, queue_delay=0)
        self._touch_success()

    async def player_state(self, serial: str, device_type: str) -> dict:
        """The raw `playerInfo` of one Echo. A missing body is an error, not an idle player."""
        async with self._lock(serial):
            try:
                body = await self._api_for(serial, device_type).get_state()
            except Exception as err:  # noqa: BLE001 — typed below
                if is_rate_limited(err):
                    raise RateLimitedError("amazon rate limit (429) on the player state") from err
                raise
        if not isinstance(body, dict):
            raise RuntimeError("amazon returned no player state")
        info = body.get("playerInfo")
        self._touch_success()
        return {"playerInfo": info if isinstance(info, dict) else {}}

    async def np_command(self, serial: str, command: str) -> None:
        body = NP_COMMANDS.get(command)
        if body is None:
            raise ValueError(f"unknown media command {command!r}")
        device_type = self._device_type_of(serial)
        async with self._lock(serial):
            try:
                await self._api_for(serial, device_type).set_media({"type": body})
            except Exception as err:  # noqa: BLE001 — typed below
                if is_rate_limited(err):
                    raise RateLimitedError("amazon rate limit (429) on a media command") from err
                raise
        self._touch_success()

    async def set_volume(self, serial: str, level: int) -> None:
        target = self.target_for(serial)
        if target is None:
            raise ValueError("unknown echo")
        node = build_volume_node(target, max(0, min(100, int(level))), REGION_LOCALE.get(self._region, "en-GB"))
        login = self._require_login()
        _AlexaLogin, AlexaAPI = _import_alexapy()
        async with self._lock(serial):
            try:
                await AlexaAPI(None, login).run_behavior(node, queue_delay=0)
            except Exception as err:  # noqa: BLE001 — typed below
                if is_rate_limited(err):
                    raise RateLimitedError("amazon rate limit (429) on the volume") from err
                raise
        self._touch_success()

    async def dnd_state(self) -> dict:
        """Do Not Disturb of every device, in one call."""
        login = self._require_login()
        _AlexaLogin, AlexaAPI = _import_alexapy()
        try:
            body = await AlexaAPI.get_dnd_state(login)
        except Exception as err:  # noqa: BLE001 — typed below
            if is_rate_limited(err):
                raise RateLimitedError("amazon rate limit (429) on Do Not Disturb") from err
            raise
        if not isinstance(body, dict):
            raise RuntimeError("amazon returned no Do Not Disturb list")
        rows = body.get("doNotDisturbDeviceStatusList")
        devices = []
        for row in rows if isinstance(rows, list) else []:
            serial = row.get("deviceSerialNumber") if isinstance(row, dict) else None
            enabled = row.get("enabled") if isinstance(row, dict) else None
            if isinstance(serial, str) and serial != "" and isinstance(enabled, bool):
                devices.append({"serial": serial, "enabled": enabled})
        self._touch_success()
        return {"devices": devices}

    async def device_volumes(self) -> dict:
        """Speaker volume and mute of every device, in one call (idle Echos included)."""
        login = self._require_login()
        _AlexaLogin, AlexaAPI = _import_alexapy()
        try:
            body = await AlexaAPI._static_request("get", login, VOLUMES_PATH)
        except Exception as err:  # noqa: BLE001 — typed below
            if is_rate_limited(err):
                raise RateLimitedError("amazon rate limit (429) on the device volumes") from err
            raise
        # `_static_request` hands back the raw response (None on status >= 400): parse it here.
        if body is None:
            raise RuntimeError("amazon returned no response for the device volume list (HTTP >= 400)")
        status = getattr(body, "status", None)
        try:
            body = await body.json(content_type=None)
        except Exception as err:  # noqa: BLE001 — typed below
            raise RuntimeError(
                f"amazon returned an unexpected body for the device volume list (HTTP {status}, unparseable)"
            ) from err
        if not isinstance(body, dict):
            raise RuntimeError(
                f"amazon returned an unexpected body for the device volume list (HTTP {status}, not an object)"
            )
        rows = body.get("volumes")
        devices = []
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            serial = row.get("dsn")
            volume = row.get("speakerVolume")
            muted = row.get("speakerMuted")
            if not isinstance(serial, str) or serial == "":
                continue
            entry = {"serial": serial}
            if isinstance(volume, (int, float)) and not isinstance(volume, bool):
                entry["volume"] = volume
            if isinstance(muted, bool):
                entry["muted"] = muted
            devices.append(entry)
        self._touch_success()
        return {"devices": devices}

    async def set_dnd(self, serial: str, enabled: bool) -> None:
        device_type = self._device_type_of(serial)
        async with self._lock(serial):
            try:
                await self._api_for(serial, device_type).set_dnd_state(enabled)
            except Exception as err:  # noqa: BLE001 — typed below
                if is_rate_limited(err):
                    raise RateLimitedError("amazon rate limit (429) on Do Not Disturb") from err
                raise
        self._touch_success()

    def _device_type_of(self, serial: str) -> str:
        target = self.target_for(serial)
        if target is None:
            raise ValueError("unknown echo")
        return target["deviceType"]

    async def session_status(self) -> dict:
        age = 0
        if self._signed_in_at is not None:
            age = int(time.time() - self._signed_in_at)
        last = int(self._last_success_at) if self._last_success_at is not None else None
        return {"loggedIn": self._logged_in, "ageSec": age, "lastSuccessAt": last}

    def _require_login(self):
        if self._login is None:
            raise RuntimeError("not signed in")
        return self._login

    def _status_result(self) -> dict:
        login = self._require_login()
        status = getattr(login, "status", {}) or {}
        if not isinstance(status, dict):
            status = {}
        kind = classify_login(status)
        self._logged_in = kind == "ok"
        if self._logged_in and self._signed_in_at is None:
            self._signed_in_at = time.time()
            self._touch_success()
        result: dict = {"status": kind}
        if kind == "failed":
            # Never attach the token: the library's message can echo the account, not our secret.
            failed = str(status.get("login_failed") or status.get("error_message") or "login failed")
            result["error"] = failed[:300]
        return result

    def _touch_success(self) -> None:
        self._last_success_at = time.time()

    async def _persist_session(self) -> None:
        login = self._login
        if login is None or self._session_path == "":
            return
        await login.save_cookiefile()


def _import_alexapy():
    from alexapy import AlexaAPI, AlexaLogin

    return AlexaLogin, AlexaAPI


def _session_cookies(login) -> dict:
    """Every cookie the login's live session holds, by name. Values only leave this process
    inside the library; nothing here logs them."""
    session = getattr(login, "_session", None)
    jar = getattr(session, "cookie_jar", None)
    found: dict = {}
    if jar is None:
        return found
    for morsel in jar:
        name = getattr(morsel, "key", None)
        value = getattr(morsel, "value", None)
        if isinstance(name, str) and isinstance(value, str) and name != "":
            found[name] = value.strip('"')
    return found


async def _exchange_refresh_token(login, device_app_name: str) -> bool:
    """Trade the broker's refresh token for cookies, under the name that token was registered with."""
    import alexapy.alexalogin as module

    previous = module.APP_NAME
    if device_app_name != "":
        module.APP_NAME = device_app_name
    try:
        return bool(await login.exchange_token_for_cookies())
    finally:
        module.APP_NAME = previous
