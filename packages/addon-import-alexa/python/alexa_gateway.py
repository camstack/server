"""alexapy adapter. Imported only when the worker starts, so unit tests can mock the gateway.

Never log the refresh token, the cookie blob, or the session file contents.
"""

from __future__ import annotations

import time
from pathlib import Path

from alexa_sequences import EchoTarget

REGIONS = ("NA", "EU", "FE")


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
        if refresh_token != "":
            exchanged = await _exchange_refresh_token(login, device_app_name)
            if not exchanged:
                return {"status": "failed", "error": "Amazon did not accept the broker's token"}
            await login.save_cookiefile()
        cookies = await login.load_cookie()
        if not cookies:
            return {"status": "failed", "error": "no Amazon session to start from"}
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
        await AlexaAPI.send_sequence(login, sequence, customer_id, None)
        self._touch_success()

    async def announce(self, announcement: dict, customer_id: str) -> None:
        login = self._require_login()
        _AlexaLogin, AlexaAPI = _import_alexapy()
        await AlexaAPI.send_announcement(login, announcement, customer_id, None)
        self._touch_success()

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
