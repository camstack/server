"""Line-delimited JSON session for the long-lived Echo worker.

One request object per stdin line, one response object per stdout line,
matched by ``id``. The password is read from a file the request names;
it is never taken from the JSON body.
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol

from alexa_sequences import EchoTarget, build_announcement, build_speak_sequence

REGION_LOCALE = {"NA": "en-US", "EU": "en-GB", "FE": "ja-JP"}


class Gateway(Protocol):
    region: str

    async def login_start(
        self, email: str, password: str, region: str, session_path: str
    ) -> dict: ...

    async def login_otp(self, code: str, session_path: str) -> dict: ...

    async def devices(self) -> dict: ...

    async def speak(self, sequence: dict, customer_id: str) -> None: ...

    async def announce(self, announcement: dict, customer_id: str) -> None: ...

    async def session_status(self) -> dict: ...

    def target_for(self, serial: str) -> EchoTarget | None: ...


def _read_password(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


class Session:
    def __init__(self, gateway: Gateway) -> None:
        self._gateway = gateway

    async def handle(self, message: dict) -> dict:
        op = message.get("op")
        request_id = message.get("id")
        if not isinstance(request_id, str) or request_id == "":
            return {"id": "", "ok": False, "error": "missing id"}
        try:
            result = await self._dispatch(op, message)
        except Exception as err:  # noqa: BLE001 — the line must answer; the message is the error
            return {"id": request_id, "ok": False, "error": str(err)}
        return {"id": request_id, "ok": True, "result": result}

    async def _dispatch(self, op: object, message: dict) -> dict:
        if op == "login_start":
            password = _read_password(str(message.get("passwordPath", "")))
            return await self._gateway.login_start(
                str(message.get("email", "")),
                password,
                str(message.get("region", "EU")),
                str(message.get("sessionPath", "")),
            )
        if op == "login_otp":
            return await self._gateway.login_otp(
                str(message.get("code", "")), str(message.get("sessionPath", ""))
            )
        if op == "devices":
            return await self._gateway.devices()
        if op == "speak":
            return await self._utter("speak", message)
        if op == "announce":
            return await self._utter("announce", message)
        if op == "session_status":
            return await self._gateway.session_status()
        raise ValueError(f"unknown op {op!r}")

    async def _utter(self, op: str, message: dict) -> dict:
        targets = message.get("targets")
        if not isinstance(targets, list) or not targets:
            raise ValueError("targets required")
        text = message.get("text")
        if not isinstance(text, str) or text == "":
            raise ValueError("text required")
        volume = message.get("volume")
        if not isinstance(volume, int):
            volume = 40
        locale = REGION_LOCALE.get(self._gateway.region, "en-GB")
        outcomes: list[dict] = []
        for serial in targets:
            if not isinstance(serial, str):
                outcomes.append({"targetId": "", "ok": False, "error": "bad target"})
                continue
            target = self._gateway.target_for(serial)
            if target is None:
                outcomes.append({"targetId": serial, "ok": False, "error": "unknown echo"})
                continue
            try:
                if op == "speak":
                    sequence = build_speak_sequence(target, text, volume, locale)
                    await self._gateway.speak(sequence, target["customerId"])
                else:
                    announcement = build_announcement(target, text, locale)
                    await self._gateway.announce(announcement, target["customerId"])
                outcomes.append({"targetId": serial, "ok": True})
            except Exception as err:  # noqa: BLE001 — one Echo failing must not drop the others
                outcomes.append({"targetId": serial, "ok": False, "error": str(err)})
        return {"outcomes": outcomes}
