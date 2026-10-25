#!/usr/bin/env python3
"""Length-prefixed binary tensor framing shared by the embedding-encoder
Python inference scripts (`raw_tensor_inference.py`, `text_encoder_inference.py`).

Wire protocol (both directions): [4B little-endian payload_len][payload]
  ready    (stdout, once):  payload = b"\\x01"
  tensor   (either way):    payload = [1B ndims][ndims × 4B LE uint32 dims][float32 LE data]
  text     (stdin):         payload = UTF-8 encoded request text (text encoder only)

stdout is the binary framing channel ONLY — all diagnostics go to stderr.
"""
from __future__ import annotations

import struct
import sys

import numpy as np

READY_FRAME = b"\x01"


def write_frame(payload: bytes) -> None:
    """Write a single length-prefixed frame to stdout and flush."""
    sys.stdout.buffer.write(struct.pack("<I", len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def read_exact(n: int) -> bytes | None:
    """Read exactly n bytes from stdin, or None on EOF."""
    buf = bytearray()
    while len(buf) < n:
        chunk = sys.stdin.buffer.read(n - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def read_frame() -> bytes | None:
    """Read one length-prefixed frame payload from stdin, or None on EOF."""
    header = read_exact(4)
    if header is None:
        return None
    (plen,) = struct.unpack("<I", header)
    payload = read_exact(plen)
    return payload


def encode_tensor(arr: np.ndarray) -> bytes:
    """Encode a numpy array as a float32 tensor frame payload."""
    arr = np.ascontiguousarray(arr, dtype=np.float32)
    out = bytearray()
    out.append(arr.ndim)
    for d in arr.shape:
        out += struct.pack("<I", int(d))
    out += arr.tobytes()
    return bytes(out)


def decode_tensor(payload: bytes) -> np.ndarray:
    """Decode a float32 tensor frame payload into a numpy array."""
    ndims = payload[0]
    off = 1
    dims = []
    for _ in range(ndims):
        (d,) = struct.unpack_from("<I", payload, off)
        off += 4
        dims.append(d)
    return np.frombuffer(payload, dtype=np.float32, offset=off).reshape(dims)
