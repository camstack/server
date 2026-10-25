#!/usr/bin/env python3
"""YAMNet audio classification subprocess.

Runs YAMNet ONNX inference via the embedded portable Python's onnxruntime,
replacing the former Node `onnxruntime-node` path. Persistent process: reads
length-prefixed float32 waveforms (16 kHz mono) from stdin, writes
length-prefixed JSON results to stdout. Mirrors the Apple SoundAnalysis Swift
CLI wire protocol so the Node side (YamnetPythonPipeline) reuses one receive
loop.

Wire protocol (both directions): [4B little-endian length][payload]
  stdin payload  = raw float32 waveform bytes (16 kHz mono)
  stdout payload = JSON {"classifications":[{"className","score"}], "inferenceMs"}
Startup: emits {"status":"ready"} once the model is loaded. Diagnostics go to
stderr (stdout is the binary framing channel only).
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
import time

import numpy as np
import onnxruntime as ort

# Match the former Node YamnetOnnxPipeline thresholds.
MIN_SCORE = 0.05
TOP_K = 10


def write_msg(obj: dict) -> None:
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def read_exact(n: int) -> bytes | None:
    buf = bytearray()
    while len(buf) < n:
        chunk = sys.stdin.buffer.read(n - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--labels", default="")
    # YAMNet is a tiny model — ONNX Runtime otherwise defaults intra_op threads to the CPU core
    # count, so every short inference spins up N threads whose coordination overhead dwarfs the
    # actual compute (observed: ~1000% CPU across a handful of always-on audio streams). Cap to a
    # single op thread; overridable via --threads for large hosts.
    ap.add_argument("--threads", type=int, default=1)
    args = ap.parse_args()

    labels: list[str] = []
    if args.labels:
        try:
            with open(args.labels, "r", encoding="utf-8") as f:
                labels = json.load(f)
        except Exception as exc:  # noqa: BLE001 — labels are best-effort
            print(f"yamnet_audio: failed to read labels: {exc}", file=sys.stderr)
            labels = []

    sess_options = ort.SessionOptions()
    sess_options.intra_op_num_threads = max(1, args.threads)
    sess_options.inter_op_num_threads = 1
    session = ort.InferenceSession(
        args.model, sess_options=sess_options, providers=["CPUExecutionProvider"]
    )
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name

    write_msg({"status": "ready", "labels": len(labels)})

    while True:
        header = read_exact(4)
        if header is None:
            break
        (length,) = struct.unpack("<I", header)
        payload = read_exact(length)
        if payload is None:
            break

        start = time.time()
        try:
            waveform = np.frombuffer(payload, dtype=np.float32)
            outputs = session.run([output_name], {input_name: waveform})
            scores = np.asarray(outputs[0], dtype=np.float32)
            if scores.ndim == 1:
                scores = scores.reshape(1, -1)
            # Average across frames → [num_classes]
            avg = np.mean(scores, axis=0)
            results = []
            for c in range(avg.shape[0]):
                s = float(avg[c])
                if s >= MIN_SCORE:
                    label = labels[c] if c < len(labels) else str(c)
                    results.append({"className": label, "score": round(s, 3)})
            results.sort(key=lambda x: x["score"], reverse=True)
            write_msg(
                {
                    "classifications": results[:TOP_K],
                    "inferenceMs": int((time.time() - start) * 1000),
                }
            )
        except Exception as exc:  # noqa: BLE001 — never kill the loop on one chunk
            write_msg(
                {
                    "classifications": [],
                    "inferenceMs": int((time.time() - start) * 1000),
                    "error": str(exc),
                }
            )


if __name__ == "__main__":
    main()
