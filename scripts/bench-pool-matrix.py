#!/usr/bin/env python3
"""Sweep matrix wrapper around bench-inference-pool.py.

Runs the same single-process throughput benchmark across a grid of
(model × input_size × cameras × concurrency) and prints a sorted summary.

Goal: find the (model, input_size, parallel, concurrency) tuple that
maximises sustained fps on the local CoreML pool, then identify whether
the bottleneck is single-frame predict time or queue serialization.
"""
from __future__ import annotations

import argparse
import asyncio
import dataclasses
import io
import json
import struct
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

REPO = Path(__file__).resolve().parent.parent
POOL_SCRIPT = REPO / "packages" / "addon-detection-pipeline" / "python" / "inference_pool.py"

MODELS_DIR = REPO / "camstack-data" / "models"
DEFAULT_IMAGE = REPO / "test-output" / "annotated_3-persons.jpg"

MSG_COMMAND = 0x00
MSG_INFER_RAW = 0x02
RAW_FMT_RGB = 0x00


@dataclasses.dataclass(frozen=True)
class Combo:
    model_path: Path
    model_label: str
    input_size: int
    cameras: int
    concurrency: int


@dataclasses.dataclass
class ComboResult:
    combo: Combo
    fps: float
    p95_ms: float
    mean_ms: float
    n: int


class Client:
    def __init__(self, proc: asyncio.subprocess.Process) -> None:
        self._proc = proc
        self._pending: dict[int, asyncio.Future[dict]] = {}
        self._next_id = 1
        self._write_lock = asyncio.Lock()
        self._reader_task: Optional[asyncio.Task[None]] = None

    async def start_reader(self) -> None:
        self._reader_task = asyncio.create_task(self._reader())

    async def _reader(self) -> None:
        assert self._proc.stdout is not None
        while True:
            header = await self._read_exact(4)
            if not header:
                return
            (total_len,) = struct.unpack("<I", header)
            body = await self._read_exact(total_len)
            if len(body) < 4:
                return
            (req_id,) = struct.unpack("<I", body[:4])
            payload = json.loads(body[4:])
            fut = self._pending.pop(req_id, None)
            if fut is not None and not fut.done():
                fut.set_result(payload)

    async def _read_exact(self, n: int) -> bytes:
        assert self._proc.stdout is not None
        buf = b""
        while len(buf) < n:
            chunk = await self._proc.stdout.read(n - len(buf))
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

    async def infer_raw(self, model_idx: int, raw: bytes, w: int, h: int) -> dict:
        req_id = self._next_id
        self._next_id += 1
        fut: asyncio.Future[dict] = asyncio.get_event_loop().create_future()
        self._pending[req_id] = fut
        payload = bytes([model_idx]) + struct.pack("<II", w, h) + bytes([RAW_FMT_RGB]) + raw
        await self.send(req_id, MSG_INFER_RAW, payload)
        return await fut


async def run_combo(combo: Combo, image_bytes: bytes, iterations: int, warmup: int) -> Optional[ComboResult]:
    proc = await asyncio.create_subprocess_exec(
        sys.executable, str(POOL_SCRIPT),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        cwd=str(POOL_SCRIPT.parent),
    )
    client = Client(proc)
    config = {
        "runtime": "coreml",
        "concurrency": combo.concurrency,
        "models": [{
            "path": str(combo.model_path),
            "inputSize": combo.input_size,
            "preprocessMode": "letterbox",
            "postprocessor": "yolo",
            "confidence": 0.25,
        }],
    }
    fut0: asyncio.Future[dict] = asyncio.get_event_loop().create_future()
    client._pending[0] = fut0
    await client.send(0, MSG_COMMAND, json.dumps(config).encode("utf-8"))
    await client.start_reader()
    ready = await fut0
    if ready.get("status") != "ready" or ready.get("models", 0) == 0:
        proc.kill()
        await proc.wait()
        return None

    # Pre-decode + resize once for raw path
    from PIL import Image
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB").resize(
        (combo.input_size, combo.input_size), Image.BILINEAR
    )
    raw = img.tobytes()

    async def run_camera(total: int) -> list[float]:
        per_call: list[float] = []
        for _ in range(total):
            t0 = time.perf_counter()
            await client.infer_raw(0, raw, combo.input_size, combo.input_size)
            per_call.append((time.perf_counter() - t0) * 1000.0)
        return per_call

    if warmup > 0:
        await asyncio.gather(*[run_camera(warmup) for _ in range(combo.cameras)])

    wall_start = time.perf_counter()
    timings = await asyncio.gather(*[run_camera(iterations) for _ in range(combo.cameras)])
    wall_sec = time.perf_counter() - wall_start

    flat: list[float] = []
    for ts in timings:
        flat.extend(ts)
    flat.sort()
    n = len(flat)
    fps = n / wall_sec
    p95 = flat[min(n - 1, int(0.95 * n))] if n else 0.0
    mean_ms = sum(flat) / n if n else 0.0

    proc.stdin.close()
    try:
        await asyncio.wait_for(proc.wait(), timeout=5)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()

    return ComboResult(combo=combo, fps=fps, p95_ms=p95, mean_ms=mean_ms, n=n)


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", default=str(DEFAULT_IMAGE))
    parser.add_argument("--iterations", type=int, default=80, help="iterations per camera per combo")
    parser.add_argument("--warmup", type=int, default=8)
    parser.add_argument("--models", default="yolov9t,yolov9s",
                        help="comma-separated model labels to look up under camstack-data/models/camstack-<label>.mlpackage")
    parser.add_argument("--input-sizes", default="320,416,640")
    parser.add_argument("--cameras", default="1,2,4,8")
    parser.add_argument("--concurrency", default="1,2,4")
    parser.add_argument("--out", default="bench-results/pool-matrix.json")
    args = parser.parse_args()

    image_bytes = Path(args.image).read_bytes()

    combos: list[Combo] = []
    for label in args.models.split(","):
        path = MODELS_DIR / f"camstack-{label}.mlpackage"
        if not path.exists():
            print(f"[skip] model not found: {path}", file=sys.stderr)
            continue
        for size in args.input_sizes.split(","):
            for cams in args.cameras.split(","):
                for conc in args.concurrency.split(","):
                    combos.append(Combo(
                        model_path=path,
                        model_label=label,
                        input_size=int(size),
                        cameras=int(cams),
                        concurrency=int(conc),
                    ))

    print(f"[matrix] {len(combos)} combos × {args.iterations} iter × cameras")
    results: list[ComboResult] = []
    for i, combo in enumerate(combos):
        label = (
            f"{combo.model_label} size={combo.input_size} "
            f"cams={combo.cameras} conc={combo.concurrency}"
        )
        sys.stdout.write(f"  [{i+1}/{len(combos)}] {label} ...")
        sys.stdout.flush()
        try:
            result = await run_combo(combo, image_bytes, args.iterations, args.warmup)
        except Exception as exc:
            print(f" FAIL ({exc})")
            continue
        if result is None:
            print(" FAIL (model load)")
            continue
        print(f" fps={result.fps:.1f} p95={result.p95_ms:.1f}ms mean={result.mean_ms:.1f}ms")
        results.append(result)

    if not results:
        print("[matrix] no successful runs")
        return

    results.sort(key=lambda r: r.fps, reverse=True)
    print()
    print("─" * 80)
    print(f"{'rank':>4}  {'model':<10}{'size':>5}  {'cams':>5}  {'conc':>5}  {'fps':>7}  {'p95ms':>7}  {'mean':>7}")
    print("─" * 80)
    for i, r in enumerate(results):
        print(
            f"{i+1:>4}  "
            f"{r.combo.model_label:<10}{r.combo.input_size:>5}  "
            f"{r.combo.cameras:>5}  {r.combo.concurrency:>5}  "
            f"{r.fps:>7.1f}  {r.p95_ms:>7.1f}  {r.mean_ms:>7.1f}"
        )

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w") as fh:
        json.dump([{
            "model": r.combo.model_label,
            "inputSize": r.combo.input_size,
            "cameras": r.combo.cameras,
            "concurrency": r.combo.concurrency,
            "fps": r.fps,
            "p95Ms": r.p95_ms,
            "meanMs": r.mean_ms,
            "samples": r.n,
        } for r in results], fh, indent=2)
    print(f"\n[saved] {out_path}")


if __name__ == "__main__":
    asyncio.run(main())
