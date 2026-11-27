#!/usr/bin/env python3
"""Long-lived Dreo worker: one process per Dreo account, line-delimited JSON on stdin/stdout.

Runs the MIT `pydreo-community` library (the one Home Assistant's Dreo integration uses).
The protocol and the session logic are in `dreo_protocol.py`; this file wires the real
library into it. Logs go to stderr so stdout stays a protocol; the password is never
logged or echoed.
"""
from __future__ import annotations

import json
import logging
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Dict

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dreo_protocol import Session, WorkerError  # noqa: E402

REGION_CODES = {"us": "NA", "eu": "EU"}
POWER_ATTRS = ("is_on", "poweron")
COMMAND_ATTRS = {
    "speed": "fan_speed",
    "oscillating": "oscillating",
    "preset": "preset_mode",
    "horizontalOscillating": "horizontally_oscillating",
    "verticalOscillating": "vertically_oscillating",
}
PINNED_VERSION = "1.11.11"


def private_attribute(owner: Any, name: str, where: str) -> Any:
    """A library internal this worker relies on; its absence names the attribute and the pin."""
    try:
        return getattr(owner, name)
    except AttributeError:
        raise WorkerError(
            "api",
            f"pydreo-community {PINNED_VERSION} is pinned, but {where}.{name} is missing: "
            "the installed library is a different version",
        ) from None


class PyDreoLibrary:
    """The adapter `Session` drives: it maps the library's failures onto typed codes."""

    def __init__(self, email: str, password: str, region: str) -> None:
        from pydreo import PyDreo

        self._last_call: Any = (None, None)
        self._client = PyDreo(email, password, redact=True, region=REGION_CODES[region])
        original = self._client.call_dreo_api

        def observed(api: str, json_object: Any = None) -> Any:
            self._last_call = original(api, json_object)
            return self._last_call

        # The library's login answers a bare bool; the last HTTP answer tells a refusal from
        # an unreachable cloud.
        self._client.call_dreo_api = observed

    def login(self) -> None:
        if self._client.login():
            return
        response, _status = self._last_call
        if response is None:
            raise WorkerError("unreachable", "the Dreo cloud did not answer the sign-in")
        raise WorkerError("auth", "Dreo refused the account, the password or the region")

    def load_devices(self) -> list:
        from pydreo.helpers import Helpers

        loaded = self._client.load_devices()
        raw = self._client.raw_response
        if not loaded and not (isinstance(raw, dict) and Helpers.code_check(raw)):
            raise WorkerError("unreachable", "the Dreo device list could not be loaded")
        from pydreo.commandoutbox import OutboxTiming

        for device in self._client.devices:
            # Send inline: the setter then blocks until the cloud acknowledged and raises a
            # rejection to the caller, instead of dropping it from a timer thread.
            private_attribute(device, "_outbox", "a device").timing = OutboxTiming.IMMEDIATE
        return list(self._client.devices)

    def start_push(self, on_channel: Callable[[str], None]) -> None:
        transport = private_attribute(self._client, "_transport", "PyDreo")
        original = private_attribute(transport, "_ws_handler", "the transport")

        async def handler(ws: Any) -> None:
            on_channel("up")
            try:
                await original(ws)
            finally:
                on_channel("down")

        # The library reconnects on its own; this is the only place that sees it happen.
        transport._ws_handler = handler
        self._client.start_transport()

    def reload_state(self, device: Any) -> None:
        if not self._client.load_device_state(device):
            raise WorkerError("unreachable", "the Dreo device state could not be read")

    def apply(self, device: Any, command: str, value: Any) -> None:
        from pydreo import DreoCommandRejectedError

        attr = self._attribute(device, command)
        try:
            setattr(device, attr, value)
        except DreoCommandRejectedError as err:
            raise WorkerError("rejected", str(err)) from None
        except ValueError as err:
            raise WorkerError("bad-request", str(err)) from None
        except RuntimeError as err:
            raise WorkerError("unreachable", str(err)) from None

    @staticmethod
    def _attribute(device: Any, command: str) -> str:
        names = POWER_ATTRS if command == "power" else (COMMAND_ATTRS[command],)
        for name in names:
            if isinstance(getattr(type(device), name, None), property):
                return name
        raise WorkerError("unsupported", f"this model has no {command} control")

    def stop(self) -> None:
        self._client.stop_transport()


class Emitter:
    """Every line to stdout goes through one lock, so responses and pushes never interleave."""

    def __init__(self) -> None:
        self._lock = threading.Lock()

    def __call__(self, line: Dict[str, Any]) -> None:
        with self._lock:
            sys.stdout.write(json.dumps(line) + "\n")
            sys.stdout.flush()


def answer(session: Session, emit: Emitter, message: Dict[str, Any]) -> None:
    request_id = str(message.get("id", ""))
    try:
        emit({"id": request_id, "ok": True, "result": session.handle(message)})
    except WorkerError as err:
        emit({"id": request_id, "ok": False, "code": err.code, "error": str(err)})
    except Exception as err:  # noqa: BLE001 - one bad request must not kill the account's worker
        # The class name only: a library message may carry a URL or a token.
        emit({"id": request_id, "ok": False, "code": "api", "error": type(err).__name__})


def main() -> int:
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    emit = Emitter()
    session = Session(PyDreoLibrary, emit)
    # Commands keep their order on one thread; reads and the login never queue behind them.
    commands = ThreadPoolExecutor(max_workers=1)
    others = ThreadPoolExecutor(max_workers=1)
    for raw in sys.stdin:
        text = raw.strip()
        if text == "":
            continue
        try:
            message = json.loads(text)
        except json.JSONDecodeError:
            emit({"id": "", "ok": False, "code": "bad-request", "error": "not JSON"})
            continue
        if not isinstance(message, dict):
            emit({"id": "", "ok": False, "code": "bad-request", "error": "not an object"})
            continue
        pool = commands if message.get("op") == "command" else others
        pool.submit(answer, session, emit, message)
    try:
        session.handle({"op": "close"})
    finally:
        commands.shutdown(wait=False, cancel_futures=True)
        others.shutdown(wait=False, cancel_futures=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
