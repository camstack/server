"""Long-lived Echo worker. One process, line-delimited JSON on stdin/stdout.

Spawned once by the addon and restarted by it with a bound. Never one
process per message. Logs go to stderr so stdout stays a protocol.
"""

from __future__ import annotations

import asyncio
import json
import sys
import traceback


async def serve() -> None:
    # Imported here so `python -m unittest` of the protocol does not need alexapy.
    from alexa_gateway import AlexaPyGateway
    from alexa_protocol import Session

    session = Session(AlexaPyGateway())
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin.buffer)
    while True:
        line = await reader.readline()
        if not line:
            return
        text = line.decode("utf-8", errors="replace").strip()
        if text == "":
            continue
        try:
            message = json.loads(text)
            if not isinstance(message, dict):
                response = {"id": "", "ok": False, "error": "request must be an object"}
            else:
                response = await session.handle(message)
        except Exception as err:  # noqa: BLE001 — one bad line must not kill the process
            traceback.print_exc(file=sys.stderr)
            response = {"id": "", "ok": False, "error": str(err)}
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


def main() -> None:
    asyncio.run(serve())


if __name__ == "__main__":
    main()
