"""The Alexa push channel (alexapy's HTTP/2 client), forwarded as protocol lines.

One channel per signed-in account, opened with the session the gateway already
holds. Every event leaves as one unsolicited stdout line (no ``id``):

    {"push": "channel", "state": "up" | "down", "reason": str, "retryInMs": int}
    {"push": "event", "command": str, "serial": str | null}

Only the event name and the Echo's serial are forwarded: the addon re-reads the
Echo it names, so no payload (and nothing Amazon sent in it) crosses the pipe.
A channel that closes is reopened with a bounded, doubling delay; the addon keeps
polling as the fallback in the meantime.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any, Awaitable, Callable

RECONNECT_BASE_S = 5
RECONNECT_MAX_S = 300

Emit = Callable[[dict], None]
ClientFactory = Callable[..., Any]
Sleep = Callable[[float], Awaitable[None]]


def _loads(text: object) -> object:
    if not isinstance(text, str):
        return None
    try:
        return json.loads(text)
    except ValueError:
        return None


def _serial_of(payload: dict) -> str | None:
    doppler = payload.get("dopplerId")
    if isinstance(doppler, dict) and isinstance(doppler.get("deviceSerialNumber"), str):
        return doppler["deviceSerialNumber"]
    key = payload.get("key")
    if isinstance(key, dict) and isinstance(key.get("entryId"), str):
        parts = key["entryId"].split("#")
        if len(parts) > 2 and parts[2] != "":
            return parts[2]
    return None


def parse_push_message(message: object) -> list[dict]:
    """The events of one HTTP/2 push message; a malformed item is skipped, never raised."""
    if not isinstance(message, dict):
        return []
    directive = message.get("directive")
    payload = directive.get("payload") if isinstance(directive, dict) else None
    updates = payload.get("renderingUpdates") if isinstance(payload, dict) else None
    if not isinstance(updates, list):
        return []
    events: list[dict] = []
    for item in updates:
        if not isinstance(item, dict):
            continue
        resource = _loads(item.get("resourceMetadata"))
        if not isinstance(resource, dict):
            continue
        command = resource.get("command")
        if not isinstance(command, str) or command == "":
            continue
        body = _loads(resource.get("payload"))
        serial = _serial_of(body) if isinstance(body, dict) else None
        events.append({"push": "event", "command": command, "serial": serial})
    return events


def reconnect_delay_s(attempt: int) -> int:
    return min(RECONNECT_BASE_S * 2 ** min(attempt, 10), RECONNECT_MAX_S)


def default_client_factory(login, msg_cb, open_cb, close_cb, error_cb):
    from alexapy import HTTP2EchoClient

    return HTTP2EchoClient(login, msg_cb, open_cb, close_cb, error_cb)


class PushChannel:
    def __init__(
        self,
        login: object,
        emit: Emit,
        client_factory: ClientFactory | None = None,
        sleep: Sleep = asyncio.sleep,
    ) -> None:
        self._login = login
        self._emit = emit
        self._factory = client_factory
        self._sleep = sleep
        self._stopped = False
        self._up = False
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.get_running_loop().create_task(self.run())

    def stop(self) -> None:
        self._stopped = True
        if self._task is not None:
            self._task.cancel()
            self._task = None

    def _down(self, reason: str, retry_s: int) -> None:
        if not self._up:
            return
        self._up = False
        self._emit(
            {"push": "channel", "state": "down", "reason": reason[:200], "retryInMs": retry_s * 1000}
        )

    async def run(self) -> None:
        attempt = 0
        while not self._stopped:
            closed = asyncio.Event()
            reason = "closed"

            async def on_message(message: object) -> None:
                for event in parse_push_message(message):
                    self._emit(event)

            async def on_open() -> None:
                nonlocal attempt
                attempt = 0
                self._up = True
                self._emit({"push": "channel", "state": "up", "reason": "connected", "retryInMs": 0})

            async def on_close() -> None:
                closed.set()

            async def on_error(error: str) -> None:
                nonlocal reason
                reason = f"error: {error}"

            client = None
            try:
                client = (self._factory or default_client_factory)(self._login, on_message, on_open, on_close, on_error)
                await client.async_run()
                await closed.wait()
            except asyncio.CancelledError:
                raise
            except Exception as err:  # noqa: BLE001 — a failed connect is a retry, never a crash
                reason = f"{type(err).__name__}: {err}"
            finally:
                if client is not None:
                    with contextlib.suppress(Exception):
                        client.on_close("channel ended")
            delay = reconnect_delay_s(attempt)
            attempt += 1
            if not self._up:
                # Never opened: the attempt itself failed; tell the addon once per failed attempt.
                self._emit(
                    {"push": "channel", "state": "down", "reason": reason[:200], "retryInMs": delay * 1000}
                )
            else:
                self._down(reason, delay)
            await self._sleep(delay)
