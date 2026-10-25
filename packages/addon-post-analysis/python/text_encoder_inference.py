#!/usr/bin/env python3
"""CLIP text-encoder inference subprocess for the embedding encoder.

Loads a CLIP text-encoder ONNX model plus its HuggingFace `tokenizers`-format
tokenizer file, then for each request: tokenizes UTF-8 text into the model's
fixed context window (exact-by-construction via the HF Rust tokenizer), feeds
the int64 token-id tensor through onnxruntime, and returns the output embedding
as a float32 tensor frame.

The window and the pad id are the MODEL's (`ClipModelMeta.contextLength` /
`.padId`, passed as `--context-length` / `--pad-id`): 77 / 0 for MobileCLIP's
CLIP BPE, 64 / 0 for SigLIP2's Gemma SentencePiece. The defaults are
MobileCLIP's, so an encoder that does not pass them tokenises exactly as before
(D649).

This replaces the hand-rolled TypeScript CLIP BPE — tokenization here is exact
by construction (same `tokenizers` library that produced the reference ids).

Wire protocol (both directions): [4B little-endian payload_len][payload]
  ready    (stdout, once):  payload = b"\\x01"
  request  (stdin):         payload = UTF-8 encoded text
  response (stdout):        payload = [1B ndims][ndims × 4B LE uint32 dims][float32 LE data]

Diagnostics go to stderr (stdout is the binary framing channel only).
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

from tensor_frames import READY_FRAME, encode_tensor, read_frame, write_frame
from session_threads import resolve_session_threads

# The CLIP BPE window — the defaults when the encoder names none.
DEFAULT_CONTEXT_LENGTH = 77
DEFAULT_PAD_ID = 0


def build_tokenizer(
    tokenizer_path: str,
    context_length: int = DEFAULT_CONTEXT_LENGTH,
    pad_id: int = DEFAULT_PAD_ID,
) -> Tokenizer:
    """Token ids truncated and padded to exactly ``context_length``."""
    tok = Tokenizer.from_file(tokenizer_path)
    tok.enable_truncation(max_length=context_length)
    tok.enable_padding(length=context_length, pad_id=pad_id)
    return tok


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("model")
    ap.add_argument("tokenizer")
    # A CLIP text encoder is one pass over a fixed 77-token window. There is
    # nothing here worth splitting across threads, and onnxruntime's default is
    # the HOST's core count held for the life of this process — 20 on this
    # cluster's hub. `yamnet_audio.py` measured what that costs (~1000% CPU on
    # a handful of streams) and landed on the same default.
    ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--context-length", type=int, default=DEFAULT_CONTEXT_LENGTH)
    ap.add_argument("--pad-id", type=int, default=DEFAULT_PAD_ID)
    args = ap.parse_args()
    if args.context_length <= 0 or args.pad_id < 0:
        raise SystemExit(
            f"invalid token window: context length {args.context_length}, pad id {args.pad_id}"
        )

    print(
        f"text_encoder_inference: loading model {args.model} "
        f"tokenizer {args.tokenizer} window {args.context_length} pad {args.pad_id}",
        file=sys.stderr,
    )
    intra, inter = resolve_session_threads(args.threads, os.cpu_count())
    sess_options = ort.SessionOptions()
    sess_options.intra_op_num_threads = intra
    sess_options.inter_op_num_threads = inter
    sess = ort.InferenceSession(
        args.model, sess_options=sess_options, providers=["CPUExecutionProvider"]
    )
    input_name = sess.get_inputs()[0].name
    output_name = sess.get_outputs()[0].name
    tokenizer = build_tokenizer(args.tokenizer, args.context_length, args.pad_id)

    write_frame(READY_FRAME)  # ready

    while True:
        payload = read_frame()
        if payload is None:
            break

        text = payload.decode("utf-8")
        encoded = tokenizer.encode(text)
        # `enable_truncation`/`enable_padding` already fixed the length.
        ids = np.asarray(encoded.ids, dtype=np.int64).reshape(1, args.context_length)

        out = sess.run([output_name], {input_name: ids})[0]
        write_frame(encode_tensor(np.asarray(out)))


if __name__ == "__main__":
    main()
