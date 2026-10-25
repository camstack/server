"""Dequant of EdgeTPU / TFLite integer output tensors.

Kept free of numpy so the bare-interpreter CI path
(``scripts/test-python-pool.sh``) can pin the contract. The edgetpu predict
closure in ``inference_pool.py`` calls this for every output; float32 tensors
(SSD ``TFLite_Detection_PostProcess``) pass through unchanged.
"""
from __future__ import annotations

from typing import Any


def _is_integer_dtype(dtype_name: str) -> bool:
    name = dtype_name.lower()
    return name in ("uint8", "int8", "u8", "i8") or name.endswith("uint8") or name.endswith("int8")


def dequant_edgetpu_output(
    value: Any,
    *,
    dtype_name: str,
    scale: float,
    zero_point: int,
) -> Any:
    """Return ``value`` dequantised to float when it is an integer tensor.

    ``value`` is a scalar, a nested list (``ndarray.tolist()``), or anything
    that exposes ``tolist``. Float dtypes are returned unchanged. A zero or
    missing scale becomes a plain float cast — we never invent a scale.
    """
    is_array = hasattr(value, "tolist") and not isinstance(value, (list, tuple))
    if is_array and _is_integer_dtype(dtype_name) and scale is not None and float(scale) > 0.0:
        # A numpy / TFLite tensor is dequantised VECTORISED, through the
        # array's own methods (no numpy import here). The list walk below
        # costs ~0.3 us per value: YuNet at 640 emits 134 400 of them per
        # frame, tens of milliseconds the predict closure would spend in
        # Python. The result is a float32 array; every postprocessor reads
        # its inputs through `np.asarray`/`np.array`.
        return (value.astype("float32") - float(int(zero_point))) * float(scale)
    if is_array:
        # numpy / TFLite tensor — decide from dtype_name, then walk lists.
        value = value.tolist()

    if not _is_integer_dtype(dtype_name):
        return value

    if scale is None or float(scale) <= 0.0:
        return _cast_floats(value)

    s = float(scale)
    zp = int(zero_point)
    return _scale_tree(value, s, zp)


def _cast_floats(value: Any) -> Any:
    if isinstance(value, (list, tuple)):
        return [_cast_floats(v) for v in value]
    return float(value)


def _scale_tree(value: Any, scale: float, zero_point: int) -> Any:
    if isinstance(value, (list, tuple)):
        return [_scale_tree(v, scale, zero_point) for v in value]
    return (float(value) - zero_point) * scale


# Postprocessors that find their tensors by NAME. The edgetpu predict closure
# keys their outputs by the TFLite tensor name, exactly as the onnx, openvino
# and coreml runtimes key every model's; every other postprocessor keeps the
# positional "0".."n-1" keys (`ssd.py` reads "0".."3" of
# TFLite_Detection_PostProcess, whose names carry ":1", ":2", ":3").
# `yunet` matches its twelve outputs by name only (D645): `cls_*` and `obj_*`
# have identical shapes, so a position cannot say which is which. `yolo` finds
# the raw YOLOX head of the `yolox-tiny-plate` Coral build by name
# (`reg_8` … `score_32`); its other paths pick a tensor by shape, never by key.
NAME_KEYED_POSTPROCESSORS = frozenset({"yunet", "yolo"})


def edgetpu_output_keys(names: "list[str]", postprocessor: "str | None") -> "list[str]":
    """The key under which each output of an Edge TPU model reaches its postprocessor.

    Named only for a postprocessor in ``NAME_KEYED_POSTPROCESSORS``, and only
    when every name is non-empty and distinct; otherwise positional — and a
    name-keyed postprocessor then raises, naming the keys it got, instead of
    decoding tensors it cannot tell apart.
    """
    positional = [str(i) for i in range(len(names))]
    if postprocessor not in NAME_KEYED_POSTPROCESSORS:
        return positional
    if any(not n for n in names) or len(set(names)) != len(names):
        return positional
    return list(names)
