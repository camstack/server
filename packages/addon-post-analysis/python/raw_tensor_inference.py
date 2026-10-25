#!/usr/bin/env python3
"""Raw-tensor ONNX inference subprocess for the embedding encoder.

Loads an ONNX model and runs raw, already-preprocessed tensors through
onnxruntime in the embedded portable Python — replacing the former Node
`onnxruntime-node` raw-tensor engine so the platform ships no Node ONNX
runtime. The caller (PythonRawTensorEngine) handles all preprocessing; this
script is a thin tensor in → tensor out bridge.

Wire protocol (both directions): [4B little-endian payload_len][payload]
  ready    (stdout, once):  payload = b"\\x01"
  request  (stdin):         payload = [1B ndims][ndims × 4B LE uint32 dims][float32 LE data]
  response (stdout):        payload = [1B ndims][ndims × 4B LE uint32 dims][float32 LE data]

The Node side always sends float32; this script casts to the model's declared
input dtype (e.g. int64 for CLIP text token ids) before running. Diagnostics go
to stderr (stdout is the binary framing channel only).
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np
import onnxruntime as ort

from tensor_frames import (
    READY_FRAME,
    decode_tensor,
    encode_tensor,
    read_frame,
    write_frame,
)
from session_threads import resolve_session_threads


def numpy_dtype_for(onnx_type: str):
    if "int64" in onnx_type:
        return np.int64
    if "int32" in onnx_type:
        return np.int32
    if "float16" in onnx_type:
        return np.float16
    return np.float32


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("model")
    # A CEILING, not a tuning. This engine serves arbitrary vision models, so
    # unlike the text encoder it keeps some parallelism — but onnxruntime's
    # default is the HOST's core count, held for the life of the process, and
    # that is a fact about the machine rather than about the work. Nobody has
    # measured the right number here because this path runs on no node of the
    # current cluster; an operator who measures raises it with --threads.
    ap.add_argument("--threads", type=int, default=4)
    args = ap.parse_args()

    print(f"raw_tensor_inference: loading model {args.model}", file=sys.stderr)
    intra, inter = resolve_session_threads(args.threads, os.cpu_count())
    sess_options = ort.SessionOptions()
    sess_options.intra_op_num_threads = intra
    sess_options.inter_op_num_threads = inter
    sess = ort.InferenceSession(
        args.model, sess_options=sess_options, providers=["CPUExecutionProvider"]
    )
    inp = sess.get_inputs()[0]
    input_name = inp.name
    input_dtype = numpy_dtype_for(inp.type)
    output_name = sess.get_outputs()[0].name

    write_frame(READY_FRAME)  # ready

    while True:
        payload = read_frame()
        if payload is None:
            break

        data = decode_tensor(payload)
        feed = data.astype(input_dtype, copy=False)

        out = sess.run([output_name], {input_name: feed})[0]
        write_frame(encode_tensor(np.asarray(out)))


if __name__ == "__main__":
    main()
