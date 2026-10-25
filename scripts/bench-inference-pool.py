#!/usr/bin/env python3
"""Standalone throughput benchmark for the refactored inference_pool.

Spawns `inference_pool.py` as a subprocess, loads the CoreML yolov9s
model, and drives `simulatedCameras` concurrent asyncio tasks that each
issue `iterations` inference calls. Reports wall-clock throughput in
detections per second (dps).

Run:
  python3 scripts/bench-inference-pool.py \
    --runtime coreml \
    --cameras 4 \
    --iterations 500 \
    --model /.../camstack-yolov9s.mlpackage \
    --image /.../3-persons.jpg
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import struct
import sys
import time
from pathlib import Path

MSG_COMMAND = 0x00
MSG_INFER_JPEG = 0x01
MSG_INFER_RAW = 0x02

RAW_FMT_RGB = 0x00

HEADER_LEN = 4
PREFIX_LEN = HEADER_LEN + 4 + 1  # total_len + req_id + msg_type


class Client:
    def __init__(self, proc: asyncio.subprocess.Process) -> None:
        self._proc = proc
        self._reader_task: asyncio.Task[None] | None = None
        self._pending: dict[int, asyncio.Future[dict]] = {}
        self._next_id = 1
        self._write_lock = asyncio.Lock()

    async def start_reader(self) -> None:
        self._reader_task = asyncio.create_task(self._reader())

    async def _reader(self) -> None:
        assert self._proc.stdout is not None
        while True:
            header = await self._read_exact(self._proc.stdout, 4)
            if not header:
                return
            (total_len,) = struct.unpack("<I", header)
            body = await self._read_exact(self._proc.stdout, total_len)
            if len(body) < 4:
                return
            (req_id,) = struct.unpack("<I", body[:4])
            payload = json.loads(body[4:])
            fut = self._pending.pop(req_id, None)
            if fut is not None and not fut.done():
                fut.set_result(payload)

    @staticmethod
    async def _read_exact(stream: asyncio.StreamReader, n: int) -> bytes:
        buf = b""
        while len(buf) < n:
            chunk = await stream.read(n - len(buf))
            if not chunk:
                return b""
            buf += chunk
        return buf

    async def send(self, req_id: int, msg_type: int, payload: bytes) -> None:
        assert self._proc.stdin is not None
        total_len = 4 + 1 + len(payload)
        header = struct.pack("<II", total_len, req_id) + bytes([msg_type])
        async with self._write_lock:
            self._proc.stdin.write(header + payload)
            await self._proc.stdin.drain()

    async def command(self, cmd: dict) -> dict:
        req_id = self._next_id
        self._next_id += 1
        fut: asyncio.Future[dict] = asyncio.get_event_loop().create_future()
        self._pending[req_id] = fut
        await self.send(req_id, MSG_COMMAND, json.dumps(cmd).encode("utf-8"))
        return await fut

    async def infer_jpeg(self, model_idx: int, jpeg: bytes) -> dict:
        req_id = self._next_id
        self._next_id += 1
        fut: asyncio.Future[dict] = asyncio.get_event_loop().create_future()
        self._pending[req_id] = fut
        payload = bytes([model_idx]) + jpeg
        await self.send(req_id, MSG_INFER_JPEG, payload)
        return await fut

    async def infer_raw(self, model_idx: int, raw: bytes, width: int, height: int, fmt: int = RAW_FMT_RGB) -> dict:
        req_id = self._next_id
        self._next_id += 1
        fut: asyncio.Future[dict] = asyncio.get_event_loop().create_future()
        self._pending[req_id] = fut
        payload = bytes([model_idx]) + struct.pack("<II", width, height) + bytes([fmt]) + raw
        await self.send(req_id, MSG_INFER_RAW, payload)
        return await fut


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", default="coreml", choices=["coreml", "openvino", "onnxruntime"])
    parser.add_argument("--cameras", type=int, default=4)
    parser.add_argument("--iterations", type=int, default=500, help="inferences per camera")
    parser.add_argument("--warmup", type=int, default=10, help="warmup iterations per camera (not counted)")
    parser.add_argument("--concurrency", type=int, default=1, help="Python worker threads (onnx only)")
    parser.add_argument("--model", required=True, help="path to mlpackage / xml / onnx")
    parser.add_argument("--image", required=True, help="JPEG image path")
    parser.add_argument("--input-size", type=int, default=640)
    parser.add_argument("--raw", action="store_true", help="use MSG_INFER_RAW path (pre-decoded RGB); skips Python-side JPEG decode")
    args = parser.parse_args()

    script = Path(__file__).resolve().parent.parent / "packages" / "addon-detection-pipeline" / "python" / "inference_pool.py"

    proc = await asyncio.create_subprocess_exec(
        sys.executable, str(script),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=None,
        cwd=str(script.parent),
    )
    client = Client(proc)

    # Startup — send config with req_id=0 using same framing.
    config = {
        "runtime": args.runtime,
        "concurrency": args.concurrency,
        "models": [{
            "path": args.model,
            "inputSize": args.input_size,
            "preprocessMode": "letterbox",
            "postprocessor": "yolo",
            "confidence": 0.25,
        }],
    }
    # Manually send startup frame (req_id=0, msg_type=command) and await response.
    fut0 = asyncio.get_event_loop().create_future()
    client._pending[0] = fut0
    await client.send(0, MSG_COMMAND, json.dumps(config).encode("utf-8"))
    await client.start_reader()
    ready = await fut0
    print(f"[ready] {ready}")
    if ready.get("status") != "ready" or ready.get("models", 0) == 0:
        print("model failed to load; aborting", file=sys.stderr)
        proc.kill()
        await proc.wait()
        sys.exit(1)

    jpeg = Path(args.image).read_bytes()
    raw_payload: tuple[bytes, int, int] | None = None
    if args.raw:
        from PIL import Image
        import io as _io
        img = Image.open(_io.BytesIO(jpeg)).convert("RGB")
        # Pre-resize to model input size — mirrors the runtime where
        # the decoder/crop stage produces a buffer of the same size.
        img = img.resize((args.input_size, args.input_size), Image.BILINEAR)
        raw_payload = (img.tobytes(), img.width, img.height)
        print(f"[bench] RAW mode — resized to {img.width}x{img.height} RGB ({len(raw_payload[0])} bytes)")

    print(f"[bench] runtime={args.runtime} cameras={args.cameras} iterations={args.iterations} "
          f"warmup={args.warmup} concurrency={args.concurrency} image={args.image} ({len(jpeg)} bytes, "
          f"mode={'raw' if args.raw else 'jpeg'})")

    async def run_camera(cam_id: int, total: int) -> tuple[int, float, int]:
        count = 0
        detections = 0
        t0 = time.perf_counter()
        for _ in range(total):
            if raw_payload is not None:
                result = await client.infer_raw(0, raw_payload[0], raw_payload[1], raw_payload[2])
            else:
                result = await client.infer_jpeg(0, jpeg)
            count += 1
            detections += len(result.get("detections", []))
        return count, time.perf_counter() - t0, detections

    # Warmup
    if args.warmup > 0:
        print(f"[warmup] {args.warmup} iterations × {args.cameras} cameras")
        await asyncio.gather(*[run_camera(i, args.warmup) for i in range(args.cameras)])

    print("[bench] starting measurement...")
    wall_start = time.perf_counter()
    results = await asyncio.gather(*[run_camera(i, args.iterations) for i in range(args.cameras)])
    wall_sec = time.perf_counter() - wall_start

    total_calls = sum(c for c, _, _ in results)
    total_detections = sum(d for _, _, d in results)
    fps = total_calls / wall_sec
    dps = total_detections / wall_sec
    avg_det = total_detections / total_calls if total_calls else 0
    print(f"\n[bench] complete:")
    print(f"  wall:         {wall_sec:.2f} s")
    print(f"  total calls:  {total_calls}")
    print(f"  detections:   {total_detections}")
    print(f"  fps:          {fps:.1f}")
    print(f"  dps:          {dps:.1f}")
    print(f"  avg det/call: {avg_det:.2f}")

    proc.stdin.close()
    try:
        await asyncio.wait_for(proc.wait(), timeout=5)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()


if __name__ == "__main__":
    asyncio.run(main())
