#!/usr/bin/env python3
"""Direct CoreML predict bench — isolates the model dispatch pattern from
IPC / asyncio / tRPC overhead.

Compares four ways to feed N concurrent "cameras" through one CoreML
model on the local ANE:

  1. sequential   — for img: model.predict(img)   (single thread)
  2. thread-pool  — N parallel calls dispatched to ThreadPoolExecutor(N)
                    (matches current camstack inference_pool with concurrency=N)
  3. list-of-dicts — model.predict([{input: img1}, {input: img2}, ...])
                    (single API call, CoreML iterates internally)
  4. multi-proc   — N python procs each holding its own MLModel,
                    run in parallel (true multi-context ANE)

Goal: see whether (3) or (4) actually reduces wall time vs (2) when
4 cameras try to detect simultaneously.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import io
import json
import multiprocessing as mp
import sys
import time
from pathlib import Path
from typing import List, Tuple

import coremltools as ct
import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
DEFAULT_MODEL = REPO / "camstack-data" / "models" / "camstack-yolov9s.mlpackage"
DEFAULT_IMAGE = REPO / "test-output" / "annotated_3-persons.jpg"


def load_image(path: Path, size: int) -> Image.Image:
    return Image.open(path).convert("RGB").resize((size, size), Image.BILINEAR)


def warmup(model: ct.models.MLModel, input_name: str, img: Image.Image, n: int = 10) -> None:
    for _ in range(n):
        model.predict({input_name: img})


# ── Pattern 1: sequential ───────────────────────────────────────────────

def run_sequential(model, input_name, img, n_per_iter, iters):
    timings = []
    for _ in range(iters):
        t0 = time.perf_counter()
        for _ in range(n_per_iter):
            model.predict({input_name: img})
        timings.append((time.perf_counter() - t0) * 1000)
    return timings


# ── Pattern 2: thread-pool ──────────────────────────────────────────────

def run_thread_pool(model, input_name, img, n_per_iter, iters, workers):
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=workers)
    timings = []
    try:
        def predict_one():
            return model.predict({input_name: img})
        for _ in range(iters):
            t0 = time.perf_counter()
            futs = [pool.submit(predict_one) for _ in range(n_per_iter)]
            for f in futs:
                f.result()
            timings.append((time.perf_counter() - t0) * 1000)
    finally:
        pool.shutdown()
    return timings


# ── Pattern 3: list-of-dicts ────────────────────────────────────────────

def run_list_of_dicts(model, input_name, img, n_per_iter, iters):
    """list[dict] pattern. coremltools accepts list[dict] and iterates
    internally — may amortize CoreML session setup."""
    timings = []
    inputs = [{input_name: img} for _ in range(n_per_iter)]
    for _ in range(iters):
        t0 = time.perf_counter()
        out = model.predict(inputs)
        # ensure consumed
        if not isinstance(out, list) or len(out) != n_per_iter:
            raise RuntimeError(f"unexpected output: {type(out)} len={len(out) if hasattr(out, '__len__') else '?'}")
        timings.append((time.perf_counter() - t0) * 1000)
    return timings


# ── Pattern 4: multi-process ────────────────────────────────────────────

def _proc_worker(model_path, input_name, img_bytes, size, n_calls, ready_q, go_evt, done_q):
    """Each process loads its own MLModel and waits for `go_evt`. On signal
    it runs `n_calls` predicts as fast as possible, reports wall time."""
    m = ct.models.MLModel(model_path)
    img = Image.frombytes("RGB", (size, size), img_bytes)
    # warmup
    for _ in range(5):
        m.predict({input_name: img})
    ready_q.put(True)
    go_evt.wait()
    t0 = time.perf_counter()
    for _ in range(n_calls):
        m.predict({input_name: img})
    done_q.put((time.perf_counter() - t0) * 1000)


def run_multi_proc(model_path, input_name, img: Image.Image, size, n_per_iter, iters):
    """Spawn n_per_iter procs each running iters predicts. Wall time =
    max across procs (true parallel)."""
    img_bytes = img.tobytes()
    timings = []
    for _ in range(iters):
        ctx = mp.get_context("spawn")
        ready_q = ctx.Queue()
        done_q = ctx.Queue()
        go_evt = ctx.Event()
        procs = []
        for _ in range(n_per_iter):
            p = ctx.Process(target=_proc_worker, args=(
                str(model_path), input_name, img_bytes, size, 1, ready_q, go_evt, done_q,
            ))
            p.start()
            procs.append(p)
        # wait for all ready
        for _ in range(n_per_iter):
            ready_q.get()
        t0 = time.perf_counter()
        go_evt.set()
        # collect each proc's local wall (they ran 1 predict each)
        per_proc = [done_q.get() for _ in range(n_per_iter)]
        wall = (time.perf_counter() - t0) * 1000
        for p in procs:
            p.join()
        timings.append(wall)
    return timings


# ── Driver ──────────────────────────────────────────────────────────────

def fps(timings_ms: List[float], n_per_iter: int) -> float:
    total_calls = sum(n_per_iter for _ in timings_ms)
    total_sec = sum(timings_ms) / 1000.0
    return total_calls / total_sec if total_sec > 0 else 0.0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default=str(DEFAULT_MODEL))
    parser.add_argument("--image", default=str(DEFAULT_IMAGE))
    parser.add_argument("--size", type=int, default=640)
    parser.add_argument("--cameras", default="1,2,4", help="comma list of N concurrent cameras to simulate")
    parser.add_argument("--iters", type=int, default=30)
    parser.add_argument("--patterns", default="sequential,thread,list,multiproc",
                        help="comma list of patterns: sequential, thread, list, multiproc")
    parser.add_argument("--out", default="bench-results/coreml-patterns.json")
    args = parser.parse_args()

    model_path = Path(args.model)
    if not model_path.exists():
        raise SystemExit(f"model not found: {model_path}")
    img_path = Path(args.image)
    if not img_path.exists():
        raise SystemExit(f"image not found: {img_path}")

    print(f"[load] {model_path.name}")
    model = ct.models.MLModel(str(model_path))
    spec = model.get_spec()
    input_name = spec.description.input[0].name
    img_size = args.size

    # If model declares fixed image input size, override --size to match
    inp_type = spec.description.input[0].type
    if inp_type.WhichOneof("Type") == "imageType":
        w = int(inp_type.imageType.width)
        h = int(inp_type.imageType.height)
        if w == h and w > 0:
            img_size = w
            if w != args.size:
                print(f"[note] model fixed input size {w}x{h} — overriding --size {args.size} → {w}")

    img = load_image(img_path, img_size)
    print(f"[warmup] 10 iter")
    warmup(model, input_name, img, n=10)

    cams_list = [int(x) for x in args.cameras.split(",")]
    patterns = [p.strip() for p in args.patterns.split(",")]
    results: List[dict] = []

    for cams in cams_list:
        for pattern in patterns:
            label = f"cams={cams:>2} pattern={pattern}"
            sys.stdout.write(f"  {label} ...")
            sys.stdout.flush()
            try:
                if pattern == "sequential":
                    timings = run_sequential(model, input_name, img, cams, args.iters)
                elif pattern == "thread":
                    timings = run_thread_pool(model, input_name, img, cams, args.iters, workers=cams)
                elif pattern == "list":
                    timings = run_list_of_dicts(model, input_name, img, cams, args.iters)
                elif pattern == "multiproc":
                    timings = run_multi_proc(model_path, input_name, img, img_size, cams, args.iters)
                else:
                    print(f" skip (unknown pattern: {pattern})")
                    continue
            except Exception as exc:
                print(f" FAIL ({exc})")
                continue

            mean = sum(timings) / len(timings)
            timings_sorted = sorted(timings)
            p95 = timings_sorted[min(len(timings_sorted) - 1, int(0.95 * len(timings_sorted)))]
            f = fps(timings, cams)
            print(f" wall={mean:.1f}ms p95={p95:.1f}ms fps={f:.1f}")
            results.append({
                "pattern": pattern,
                "cameras": cams,
                "wallMeanMs": mean,
                "wallP95Ms": p95,
                "fps": f,
                "iters": len(timings),
            })

    print()
    print("─" * 80)
    print(f"{'cams':>5}  {'pattern':<12}  {'wall_mean':>10}  {'wall_p95':>10}  {'fps':>8}")
    print("─" * 80)
    for r in sorted(results, key=lambda x: (-x['fps'], x['cameras'])):
        print(f"{r['cameras']:>5}  {r['pattern']:<12}  "
              f"{r['wallMeanMs']:>10.1f}  {r['wallP95Ms']:>10.1f}  {r['fps']:>8.1f}")

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w") as fh:
        json.dump(results, fh, indent=2)
    print(f"\n[saved] {out_path}")


if __name__ == "__main__":
    main()
