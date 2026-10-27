"""alexapy adapter. Imported only when the worker starts, so unit tests can mock the gateway.

Never log the password, the cookie blob, or the session file contents.
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

from alexa_sequences import EchoTarget

REGION_URL = {
    "NA": "https://alexa.amazon.com",
    "EU": "https://alexa.amazon.co.uk",
    "FE": "https://alexa.amazon.co.jp",
}


def classify_login(status: dict) -> str:
    if status.get("login_successful") is True:
        return "ok"
    failed = str(status.get("login_failed") or status.get("error_message") or "").lower()
    if "captcha" in failed:
        return "captcha"
    if any(word in failed for word in ("otp", "2fa", "mfa", "verification code", "one-time")):
        return "otp_needed"
    if failed == "" and status.get("login_successful") is not True:
        return "failed"
    return "failed"


def normalize_device(raw: dict) -> dict | None:
    serial = raw.get("serialNumber") or raw.get("deviceSerialNumber")
    if not isinstance(serial, str) or serial == "":
        return None
    family = str(raw.get("deviceFamily") or "")
    name = str(raw.get("accountName") or raw.get("deviceOwnerCustomerId") or serial)
    online = bool(raw.get("online", True))
    dnd = bool(raw.get("dnd") or raw.get("dndEnabled"))
    kind = "group" if family.upper() == "WHA" else "device"
    return {
        "id": serial,
        "name": name,
        "family": family,
        "online": online,
        "kind": kind,
        "dnd": dnd,
        "deviceType": str(raw.get("deviceType") or raw.get("deviceTypeId") or ""),
        "customerId": str(raw.get("deviceOwnerCustomerId") or raw.get("customerId") or ""),
    }


class AlexaPyGateway:
    """Holds one AlexaLogin for the life of the process."""

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

    async def login_start(self, email: str, password: str, region: str, session_path: str) -> dict:
        self._region = region if region in REGION_URL else "EU"
        self._session_path = session_path
        url = REGION_URL[self._region]
        AlexaLogin, _AlexaAPI = _import_alexapy()
        output = str(Path(session_path).parent)
        self._login = AlexaLogin(url, email, password, output, False)
        cookies = await _load_session(self._login, session_path)
        await self._login.login(cookies=cookies)
        await self._persist_session()
        return self._status_result()

    async def login_otp(self, code: str, session_path: str = "") -> dict:
        if session_path != "":
            self._session_path = session_path
        login = self._require_login()
        submit = getattr(login, "submit_otp", None)
        if callable(submit):
            await submit(code)
        else:
            await login.login(data={"otpCode": code})
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
            {key: device[key] for key in ("id", "name", "family", "online", "kind", "dnd", "deviceType")}
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
            # The library's message can echo the account. Never include the password:
            # the caller already scrubbed it before it reached us, and we do not attach it.
            failed = str(status.get("login_failed") or status.get("error_message") or "login failed")
            result["error"] = failed[:300]
        return result

    def _touch_success(self) -> None:
        self._last_success_at = time.time()

    async def _persist_session(self) -> None:
        login = self._login
        if login is None or self._session_path == "":
            return
        save = getattr(login, "save_cookie", None)
        if not callable(save):
            return
        result = save(self._session_path)
        if asyncio.iscoroutine(result):
            await result


def _import_alexapy():
    from alexapy import AlexaAPI, AlexaLogin

    return AlexaLogin, AlexaAPI


async def _load_session(login, session_path: str):
    path = Path(session_path)
    if not path.is_file() or path.stat().st_size == 0:
        return None
    load = getattr(login, "load_cookie", None)
    if not callable(load):
        return None
    loaded = load(session_path)
    if asyncio.iscoroutine(loaded):
        return await loaded
    return loaded
