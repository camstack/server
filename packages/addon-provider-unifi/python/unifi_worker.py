"""Long-lived UniFi worker. One process per controller, line-delimited JSON on stdin/stdout.

Spawned by the addon and restarted by it within a bound. A request is
`{"id", "op", ...}`; its answer is `{"id", "ok": true, "result"}` or
`{"id", "ok": false, "kind", "error"}`. Unsolicited lines carry `"push"`
(`snapshot` after a websocket change, `channel` for the event stream's state).
Requests run concurrently (the websocket keeps running between them); every
line is written from the event loop, so lines never interleave. Logs go to
stderr so stdout stays a protocol.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
import traceback
from typing import Any


def emit(line: dict) -> None:
    sys.stdout.write(json.dumps(line) + "\n")
    sys.stdout.flush()


def configure_logging() -> None:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(name)s %(levelname)s %(message)s"))
    root = logging.getLogger()
    root.addHandler(handler)
    # aiounifi logs request bodies (the sign-in password among them) at DEBUG: never below WARNING.
    root.setLevel(logging.WARNING)


async def handle(session: Any, message: dict) -> dict:
    from unifi_session import WorkerFailure, classify

    op = message.get("op")
    try:
        if op == "connect":
            result: Any = await session.connect(message)
        elif op == "list":
            result = await session.list(bool(message.get("refresh")))
        elif op == "set_poe":
            await session.set_poe(str(message["deviceId"]), int(message["portIdx"]), bool(message["on"]))
            result = None
        elif op == "set_led":
            await session.set_led(str(message["deviceId"]), bool(message["on"]))
            result = None
        elif op == "restart":
            await session.restart(str(message["deviceId"]))
            result = None
        elif op == "power_cycle":
            await session.power_cycle(str(message["deviceId"]), int(message["portIdx"]))
            result = None
        elif op == "disconnect":
            await session.close()
            result = None
        else:
            raise WorkerFailure("bad-request", f"unknown op {op!r}")
        return {"ok": True, "result": result}
    except (KeyError, ValueError, TypeError) as err:
        return WorkerFailure("bad-request", f"bad {op} request: {err}").to_answer()
    except Exception as err:  # noqa: BLE001 — every failure answers its caller
        failure = classify(err)
        if failure.kind == "api" and not isinstance(err, WorkerFailure):
            traceback.print_exc(file=sys.stderr)
        return failure.to_answer()


async def serve() -> None:
    from unifi_session import UnifiSession

    session = UnifiSession(emit)
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin.buffer)
    tasks: set[asyncio.Task] = set()

    async def answer(message: dict) -> None:
        response = await handle(session, message)
        emit({"id": str(message.get("id", "")), **response})

    while True:
        line = await reader.readline()
        if not line:
            break
        text = line.decode("utf-8", errors="replace").strip()
        if text == "":
            continue
        try:
            message = json.loads(text)
        except json.JSONDecodeError as err:
            emit({"id": "", "ok": False, "kind": "bad-request", "error": f"not JSON: {err}"})
            continue
        if not isinstance(message, dict):
            emit({"id": "", "ok": False, "kind": "bad-request", "error": "request must be an object"})
            continue
        task = asyncio.ensure_future(answer(message))
        tasks.add(task)
        task.add_done_callback(tasks.discard)
    await session.close()


def main() -> None:
    configure_logging()
    asyncio.run(serve())


if __name__ == "__main__":
    main()
