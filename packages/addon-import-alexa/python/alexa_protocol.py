"""Line-delimited JSON session for the long-lived Echo worker.

One request object per stdin line, one response object per stdout line,
matched by ``id``. The broker's refresh token is read from a file the request
names; it is never taken from the JSON body.
"""

from __future__ import annotations

from pathlib import Path
from typing import Protocol

from alexa_sequences import EchoTarget, build_announcement, build_speak_sequence

REGION_LOCALE = {"NA": "en-US", "EU": "en-GB", "FE": "ja-JP"}


class Gateway(Protocol):
    region: str

    async def login_broker(
        self,
        label: str,
        refresh_token: str,
        device_app_name: str,
        domain: str,
        region: str,
        session_path: str,
    ) -> dict: ...

    async def devices(self) -> dict: ...

    async def speak(self, sequence: dict, customer_id: str) -> None: ...

    async def announce(self, announcement: dict, customer_id: str) -> None: ...

    async def session_status(self) -> dict: ...

    async def player_state(self, serial: str, device_type: str) -> dict: ...

    async def np_command(self, serial: str, command: str) -> None: ...

    async def set_volume(self, serial: str, level: int) -> None: ...

    async def dnd_state(self) -> dict: ...

    async def device_volumes(self) -> dict: ...

    async def set_dnd(self, serial: str, enabled: bool) -> None: ...

    def target_for(self, serial: str) -> EchoTarget | None: ...


def _read_secret(path: str) -> str:
    """A secret handed over as an owner-only file. An empty path means there is none."""
    if path == "":
        return ""
    return Path(path).read_text(encoding="utf-8").strip()


def _serial(message: dict) -> str:
    serial = message.get("serial")
    if not isinstance(serial, str) or serial == "":
        raise ValueError("serial required")
    return serial


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
            failure: dict = {"id": request_id, "ok": False, "error": str(err)}
            code = getattr(err, "code", None)
            if isinstance(code, str):
                failure["code"] = code
            return failure
        return {"id": request_id, "ok": True, "result": result}

    async def _dispatch(self, op: object, message: dict) -> dict:
        if op == "login_broker":
            refresh_token = _read_secret(str(message.get("refreshTokenPath", "")))
            return await self._gateway.login_broker(
                str(message.get("label", "")),
                refresh_token,
                str(message.get("deviceAppName", "")),
                str(message.get("domain", "")),
                str(message.get("region", "EU")),
                str(message.get("sessionPath", "")),
            )
        if op == "devices":
            return await self._gateway.devices()
        if op == "speak":
            return await self._utter("speak", message)
        if op == "announce":
            return await self._utter("announce", message)
        if op == "session_status":
            return await self._gateway.session_status()
        if op == "player_state":
            return await self._gateway.player_state(
                _serial(message), str(message.get("deviceType", ""))
            )
        if op == "np_command":
            await self._gateway.np_command(_serial(message), str(message.get("command", "")))
            return {}
        if op == "set_volume":
            level = message.get("level")
            if isinstance(level, bool) or not isinstance(level, (int, float)):
                raise ValueError("level required")
            await self._gateway.set_volume(_serial(message), int(level))
            return {}
        if op == "dnd_state":
            return await self._gateway.dnd_state()
        if op == "device_volumes":
            return await self._gateway.device_volumes()
        if op == "set_dnd":
            enabled = message.get("enabled")
            if not isinstance(enabled, bool):
                raise ValueError("enabled required")
            await self._gateway.set_dnd(_serial(message), enabled)
            return {}
        raise ValueError(f"unknown op {op!r}")

    async def _utter(self, op: str, message: dict) -> dict:
        targets = message.get("targets")
        if not isinstance(targets, list) or not targets:
            raise ValueError("targets required")
        text = message.get("text")
        if not isinstance(text, str) or text == "":
            raise ValueError("text required")
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
                    sequence = build_speak_sequence(target, text, locale)
                    await self._gateway.speak(sequence, target["customerId"])
                else:
                    announcement = build_announcement(target, text, locale)
                    await self._gateway.announce(announcement, target["customerId"])
                outcomes.append({"targetId": serial, "ok": True})
            except Exception as err:  # noqa: BLE001 — one Echo failing must not drop the others
                outcomes.append({"targetId": serial, "ok": False, "error": str(err)})
        return {"outcomes": outcomes}
