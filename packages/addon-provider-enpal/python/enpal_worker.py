#!/usr/bin/env python3
"""One-shot reader of an Enpal box running firmware 8.5x (Blazor Server).

From firmware 8.51 the device tables of `/deviceMessages` are not in the HTML any more:
the box sends them once, as a RenderBatch, after a Blazor circuit starts. This script does
what the box's own web page does: load the page, negotiate SignalR, start a circuit, read
the RenderBatches that follow, and print the sensor rows. It is READ-ONLY: it never
dispatches a UI event (no checkbox, no button), it only acknowledges renders.

The protocol framing and the RenderBatch decoder are `enpal_blazor/` (derolli1976/enpal,
MIT); the connection sequence follows that component's websocket client.

stdin JSON:  { "host": "192.168.1.16", "port": 80, "windowMs": 12000, "settleMs": 2000,
               "captureBatches": false }
stdout JSON: { "ok": true,  "rows": [ { "key", "value", "unit", "timestamp" } ],
               "batches": [ "<base64 RenderBatch>" ]   # only with captureBatches
             }
          or { "ok": false, "kind": "unreachable|bad-response|empty|protocol", "error": "..." }
Diagnostics go to stderr. Never reads a credential: the box has none.
"""
from __future__ import annotations

import asyncio
import base64
import json
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import aiohttp  # noqa: E402

from enpal_blazor.protocol import (  # noqa: E402
    ComponentDescriptor,
    decode_messages,
    encode_message,
    extract_application_state,
    extract_blazor_components,
)
from enpal_blazor.render_batch import (  # noqa: E402
    extract_changed_rows,
    extract_initial_rows,
    parse_render_batch_strings,
)

# JS calls whose .NET caller dereferences the result: null would tear the circuit down.
JS_CALL_RESULTS = {
    "mudpopoverHelper.countProviders": "1",
    "Radzen.createChart": '{"left":0,"top":0,"width":800,"height":400}',
    "Radzen.createResizable": '{"left":0,"top":0,"width":800,"height":400}',
}

HTTP_TIMEOUT_S = 15

# Rows that mean the device tables arrived (Site Data alone is 4).
MIN_DEVICE_ROWS = 20


class ReadError(Exception):
    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


def log(message: str) -> None:
    print(f"[enpal_worker] {message}", file=sys.stderr, flush=True)


def merge_rows(batches: List[bytes]) -> List[Dict[str, Optional[str]]]:
    """Rows of every batch; a later reading of a key replaces an earlier one."""
    merged: Dict[str, Dict[str, Optional[str]]] = {}
    for raw in batches:
        strings = parse_render_batch_strings(raw)
        for row in extract_initial_rows(strings):
            merged[row["key"]] = row
        for row in extract_changed_rows(strings):
            merged[row["key"]] = row
    return list(merged.values())


class Session:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url
        self.application_state = ""
        self.components: List[ComponentDescriptor] = []
        self.batches: List[bytes] = []
        self.last_batch_at = 0.0
        self.started = time.monotonic()
        self.closed_reason: Optional[str] = None
        self.ws: Optional[aiohttp.ClientWebSocketResponse] = None

    async def send(self, msg: list) -> None:
        assert self.ws is not None
        await self.ws.send_bytes(encode_message(msg))

    async def handle(self, data: bytes) -> None:
        for msg in decode_messages(data):
            if not isinstance(msg, list) or not msg:
                continue
            kind = msg[0]
            if kind == 7:
                self.closed_reason = str(msg[1]) if len(msg) > 1 else "closed by the box"
                continue
            if kind != 1 or len(msg) < 4:
                continue
            target = msg[3]
            args = msg[4] if len(msg) > 4 else []
            if target == "JS.RenderBatch":
                if args:
                    await self.send([1, {}, None, "OnRenderCompleted", [args[0], None]])
                if len(args) > 1 and isinstance(args[1], (bytes, bytearray)):
                    self.batches.append(bytes(args[1]))
                    log(f"render batch {len(self.batches)}: {len(args[1])} bytes at {time.monotonic() - self.started:.1f}s")
                    self.last_batch_at = time.monotonic()
            elif target == "JS.BeginInvokeJS" and args:
                identifier = args[1] if len(args) > 1 else ""
                result = JS_CALL_RESULTS.get(identifier, "null")
                await self.send(
                    [1, {}, None, "EndInvokeJSFromDotNet", [args[0], True, f"[{args[0]},true,{result}]"]]
                )
            elif target == "JS.Error":
                log(f"circuit error reported by the box: {args[0] if args else None}")

    async def read_loop(self) -> None:
        assert self.ws is not None
        async for msg in self.ws:
            if msg.type == aiohttp.WSMsgType.BINARY:
                await self.handle(msg.data)
            elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.CLOSING):
                self.closed_reason = self.closed_reason or "socket closed"
                break

    async def open(self, http: aiohttp.ClientSession) -> None:
        async with http.get(f"{self.base_url}/deviceMessages") as resp:
            if resp.status != 200:
                raise ReadError("bad-response", f"HTTP {resp.status} loading /deviceMessages")
            html = await resp.text()
        self.components = extract_blazor_components(html)
        self.application_state = extract_application_state(html)
        if not self.components or not self.application_state:
            raise ReadError("protocol", "the page carries no Blazor components (not an energy-manager box?)")

        async with http.post(f"{self.base_url}/_blazor/negotiate?negotiateVersion=1", data="") as resp:
            if resp.status != 200:
                raise ReadError("bad-response", f"HTTP {resp.status} during negotiate")
            token = (await resp.json()).get("connectionToken")
        if not token:
            raise ReadError("protocol", "negotiate returned no connectionToken")

        host = self.base_url.split("://", 1)[1]
        self.ws = await http.ws_connect(f"ws://{host}/_blazor?id={token}")
        await self.ws.send_str('{"protocol":"blazorpack","version":1}\x1e')
        hs = await self.ws.receive()
        text = hs.data.decode("utf-8") if hs.type == aiohttp.WSMsgType.BINARY else str(hs.data)
        if '"error"' in text:
            raise ReadError("protocol", f"handshake refused: {text.strip()}")

    async def start_circuit(self) -> None:
        await self.send(
            [1, {}, "0", "StartCircuit",
             [self.base_url + "/", self.base_url + "/deviceMessages", "[]", self.application_state]]
        )
        await asyncio.sleep(0.3)
        operations = [
            {
                "type": "add",
                "ssrComponentId": i + 1,
                "marker": {
                    "type": c.type,
                    "prerenderId": c.prerender_id,
                    "key": c.key,
                    "sequence": c.sequence,
                    "descriptor": c.descriptor,
                    "uniqueId": i,
                },
            }
            for i, c in enumerate(self.components)
        ]
        batch = json.dumps({"batchId": 1, "operations": operations})
        await self.send([1, {}, None, "UpdateRootComponents", [batch, self.application_state]])


async def read_box(host: str, port: int, window_s: float, settle_s: float) -> Session:
    session = Session(f"http://{host}:{port}")
    timeout = aiohttp.ClientTimeout(total=HTTP_TIMEOUT_S)
    async with aiohttp.ClientSession(
        cookie_jar=aiohttp.CookieJar(unsafe=True), timeout=timeout
    ) as http:
        try:
            await session.open(http)
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as err:
            raise ReadError("unreachable", f"cannot reach {host}:{port} ({type(err).__name__})") from err
        reader = asyncio.create_task(session.read_loop())
        try:
            await session.start_circuit()
            started = time.monotonic()
            counted = 0
            row_count = 0
            while time.monotonic() - started < window_s:
                await asyncio.sleep(0.25)
                if session.closed_reason is not None or reader.done():
                    break
                if len(session.batches) != counted:
                    counted = len(session.batches)
                    row_count = len(merge_rows(session.batches))
                # The box renders "Site Data" at once and the device tables ~3 s later, so a
                # quiet spell alone is not "done": wait for the device tables (many rows).
                # A box that never sends them is read at the end of the window.
                if row_count >= MIN_DEVICE_ROWS and time.monotonic() - session.last_batch_at >= settle_s:
                    break
        finally:
            reader.cancel()
            try:
                await reader
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            if session.ws is not None and not session.ws.closed:
                await session.ws.close()
    return session


def main() -> int:
    try:
        raw = sys.stdin.read()
        request = json.loads(raw) if raw.strip() else {}
        host = request["host"]
        port = int(request.get("port", 80))
        window_s = float(request.get("windowMs", 12000)) / 1000
        settle_s = float(request.get("settleMs", 2000)) / 1000
        capture = bool(request.get("captureBatches", False))
        if not isinstance(host, str) or not host:
            raise ValueError("host must be a non-empty string")
    except (json.JSONDecodeError, KeyError, ValueError, TypeError) as err:
        print(json.dumps({"ok": False, "kind": "protocol", "error": f"invalid request: {err}"}), flush=True)
        return 1

    try:
        session = asyncio.run(read_box(host, port, window_s, settle_s))
        rows = merge_rows(session.batches)
        if not rows:
            reason = session.closed_reason or "no render arrived"
            raise ReadError("empty", f"the box rendered no sensor rows ({reason})")
        out: dict = {"ok": True, "rows": rows}
        if capture:
            out["batches"] = [base64.b64encode(b).decode("ascii") for b in session.batches]
        print(json.dumps(out), flush=True)
        return 0
    except ReadError as err:
        print(json.dumps({"ok": False, "kind": err.kind, "error": str(err)}), flush=True)
        return 1
    except Exception as err:  # noqa: BLE001 - the bridge always answers JSON
        log(f"unexpected failure: {type(err).__name__}: {err}")
        print(json.dumps({"ok": False, "kind": "protocol", "error": f"{type(err).__name__}: {err}"}), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
