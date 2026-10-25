"""Shared model converter: ONNX -> OpenVINO IR (fp16/int8/CoreML) + validation.

Used by both the runtime model-convert cap (convert.py) and the offline
scripts/build-camstack-models.py. Conversion ALWAYS starts from ONNX via
ov.convert_model (never the Ultralytics OV exporter, which emits unnamed
tensors that break the runtime's named-output postprocess)."""
from __future__ import annotations
import os
import re
from pathlib import Path
from typing import Iterable, Optional

# OpenVINO sizes the pool that COMPILES a model to the machine's core count and
# TBB never gives those workers back. A container cgroup counts THREADS, and
# this one has been measured refusing forks against `pids.max=2048` — so a
# conversion running beside the live pools must not spend `nproc` of the budget
# just to validate an IR. Same knob, same env var and same default (4) as
# OV_COMPILATION_NUM_THREADS in
# packages/addon-pipeline/python/inference_pool.py, which carries the
# measurement; this process is short-lived, so the saving here is a spike, not
# the 214-thread accumulation that motivated the bound. 0 disables it.
_OV_COMPILATION_NUM_THREADS: int = 4
try:
    _OV_COMPILATION_NUM_THREADS = int(
        os.environ.get("CAMSTACK_OV_COMPILATION_THREADS", "4")
    )
except ValueError:
    _OV_COMPILATION_NUM_THREADS = 4


def export_openvino(onnx_path: str, out_xml: str, *, fp16: bool) -> None:
    import openvino as ov
    ov_model = ov.convert_model(onnx_path)
    Path(out_xml).parent.mkdir(parents=True, exist_ok=True)
    ov.save_model(ov_model, out_xml, compress_to_fp16=fp16)


def validate_openvino_ir(xml_path: str) -> None:
    """Compile the IR and assert every input/output tensor carries a name.
    This is the exact defect (unnamed tensors) that broke 14/26 catalog IRs."""
    import openvino as ov
    core = ov.Core()
    model = core.read_model(xml_path)
    # Bound the compilation pool (see _OV_COMPILATION_NUM_THREADS). A plugin
    # REJECTS a property it does not know, and this compile is the VALIDATION —
    # it must never fail for a reason that has nothing to do with the IR, so a
    # refused property falls back to the unbounded compile rather than
    # reporting a bad model.
    if _OV_COMPILATION_NUM_THREADS > 0:
        try:
            compiled = core.compile_model(
                model,
                "CPU",
                {"COMPILATION_NUM_THREADS": _OV_COMPILATION_NUM_THREADS},
            )
        except Exception:
            compiled = core.compile_model(model, "CPU")
    else:
        compiled = core.compile_model(model, "CPU")
    for port in list(compiled.inputs) + list(compiled.outputs):
        try:
            name = port.get_any_name()
        except Exception as exc:  # ov raises when a tensor has no names
            raise ValueError(f"IR {xml_path} has an unnamed tensor: {exc}") from exc
        if not name:
            raise ValueError(f"IR {xml_path} has an empty-named tensor")


CALIBRATION_SUFFIXES = {".jpg", ".jpeg", ".png"}


def calibration_images(calib_dir: str, max_samples: int) -> "list[Path]":
    """The first ``max_samples`` calibration images of ``calib_dir``, in path order.

    A flat folder (COCO val2017) is read exactly as before: file-name order. A
    folder is walked recursively, so the operator's own frames work as they
    come. The hub's annotated export (a folder holding ``annotations.json``)
    calibrates on its ``frames/`` only: its ``crops/`` are classifier inputs,
    not what a root detector is fed.
    """
    root = Path(calib_dir)
    if not root.is_dir():
        raise ValueError(f"calibration folder {calib_dir} does not exist")
    base = root / "frames" if (root / "annotations.json").is_file() else root
    images = sorted(
        (p for p in base.rglob("*") if p.is_file() and p.suffix.lower() in CALIBRATION_SUFFIXES),
        key=lambda p: p.relative_to(base).as_posix(),
    )[:max_samples]
    if not images:
        raise ValueError(f"no calibration images in {calib_dir}")
    return images


def letterbox_for_calibration(rgb, imgsz: int):
    """``rgb`` (HxWx3 uint8) → ``[1,3,imgsz,imgsz]`` float32 in [0,1], letterboxed
    as the inference pool does (``inference_pool.letterbox_image``): scale by the
    long side, truncate, CENTRE with grey 114 padding."""
    import cv2
    import numpy as np

    h, w = rgb.shape[:2]
    scale = imgsz / max(h, w)
    nw, nh = int(w * scale), int(h * scale)
    pad_x, pad_y = (imgsz - nw) // 2, (imgsz - nh) // 2
    resized = rgb if (nw, nh) == (w, h) else cv2.resize(rgb, (nw, nh), interpolation=cv2.INTER_LINEAR)
    canvas = np.full((imgsz, imgsz, 3), 114, dtype=np.uint8)
    canvas[pad_y : pad_y + nh, pad_x : pad_x + nw] = resized
    chw = canvas.transpose(2, 0, 1).astype(np.float32) / 255.0
    return chw[np.newaxis, ...]


_HEAD_MODULE = re.compile(r"^(/model\.\d+)/")


def detect_head_prefix(ops: "Iterable[tuple[str, str]]") -> "Optional[str]":
    """The Ultralytics Detect module (``/model.22`` for YOLOv9, ``/model.23``
    for YOLO26): the module holding the graph's LAST Sigmoid, which is the
    class-score sigmoid (the Ultralytics exporter finds its head the same way),
    provided that module holds the box branch (``cv2.*`` / ``one2one_cv2.*``).
    ``ops`` is ``(friendly_name, type_name)`` in graph order. None when the
    model is not an Ultralytics detector — it then keeps NNCF's defaults."""
    ops = list(ops)
    last = None
    for name, kind in ops:
        if kind == "Sigmoid":
            last = name
    match = _HEAD_MODULE.match(last) if last else None
    if not match:
        return None
    head = match.group(1)
    # `/model.N/` is also PyTorch's naming for any `self.model = nn.Sequential`:
    # only a module that holds the box branch is a Detect head.
    box_branch = (f"{head}/cv2.", f"{head}/one2one_cv2.")
    return head if any(name.startswith(box_branch) for name, _ in ops) else None


def is_end_to_end_head(names: "Iterable[str]", head: str) -> bool:
    """An NMS-free (end-to-end) head — YOLO26's — runs its ``one2one_*`` branches."""
    return any(n.startswith(f"{head}/one2one") for n in names)


def int8_ignored_patterns(head: str, end_to_end: bool) -> "list[str]":
    """NNCF ignored-scope patterns for the Detect head ``head``.

    - DFL head (YOLOv9): the head's OWN ops stay float — the DFL and the box
      decode (concat/split, anchor ± distance, ×stride, the class sigmoid). The
      conv branches (``cv2.*``/``cv3.*``) stay INT8.
    - End-to-end head (YOLO26): the whole head stays float, its ``one2one``
      convs included, as NNCF's YOLO26 example keeps it; measured better than
      the decode alone on YOLO26 (docs/benchmarks/2026-10-09-int8-recipe.md).

    NNCF matches with ``re.match`` — a prefix match — so the own-op pattern is
    anchored with ``$`` and every pattern ends at a module boundary."""
    h = re.escape(head)
    if end_to_end:
        return [rf"{h}/"]
    return [rf"{h}/[^/]+$", rf"{h}/dfl/"]


def quantize_openvino_int8(
    onnx_path: str, out_xml: str, calib_dir: str, imgsz: int, max_samples: int = 300
) -> None:
    """NNCF post-training INT8. For an Ultralytics detector (D818): preset MIXED
    (asymmetric activations), full bias correction, and the Detect head in
    float — its own ops for a DFL head, all of it for an end-to-end one
    (`int8_ignored_patterns`). Any other model keeps NNCF's defaults. Measured in
    docs/benchmarks/2026-10-09-int8-recipe.md: the decode in INT8 was where
    the hosted IRs lost their box precision."""
    import cv2
    import openvino as ov
    import nncf

    images = calibration_images(calib_dir, max_samples)

    def preprocess(path: Path):
        img = cv2.imread(str(path))
        return letterbox_for_calibration(cv2.cvtColor(img, cv2.COLOR_BGR2RGB), imgsz)

    dataset = nncf.Dataset(images, lambda p: preprocess(p))
    ov_model = ov.convert_model(onnx_path)
    ops = [(op.get_friendly_name(), op.get_type_name()) for op in ov_model.get_ordered_ops()]
    head = detect_head_prefix(ops)
    options: dict = {}
    if head:
        end_to_end = is_end_to_end_head((name for name, _ in ops), head)
        options = {
            "preset": nncf.QuantizationPreset.MIXED,
            "fast_bias_correction": False,
            "ignored_scope": nncf.IgnoredScope(patterns=int8_ignored_patterns(head, end_to_end), validate=False),
        }
    # Not an Ultralytics detector: NNCF defaults, as before D818 (unmeasured otherwise).
    quantized = nncf.quantize(ov_model, dataset, subset_size=len(images), **options)
    Path(out_xml).parent.mkdir(parents=True, exist_ok=True)
    ov.save_model(quantized, out_xml)


def export_coreml_from_onnx(
    onnx_path: str,
    out_pkg: str,
    imgsz: int,
    *,
    input_shape: "tuple[int, ...] | None" = None,
    fp32: bool = False,
) -> None:
    """ONNX -> CoreML mlpackage (darwin only).

    Modern coremltools (>=6) dropped the ONNX frontend entirely — ``ct.convert``
    only accepts TensorFlow / PyTorch / MIL sources, so feeding it an ``.onnx``
    raises "Unable to determine the type of the model". We bridge through
    PyTorch: ``onnx2torch`` rebuilds the ONNX graph as an ``nn.Module``, we trace
    it with a representative image input, then coremltools converts the
    TorchScript. Image models are NCHW ``(1, 3, imgsz, imgsz)``.

    ``input_shape`` overrides that square-NCHW assumption for models whose input
    is neither square nor channels-first — the plate recognizer is NHWC
    ``(1, 64, 128, 3)``. Without it the trace runs on a wrongly-shaped tensor and
    either throws deep inside the graph or, worse, produces a package whose
    declared input silently disagrees with the real one. ``imgsz`` stays the
    positional contract for every existing caller.

    ``fp32`` keeps full precision instead of coremltools' default fp16 weights.
    Detectors and embedders absorb fp16 — a box moves a fraction of a pixel, a
    cosine moves 5e-5 — but a RECOGNIZER cannot: its output is an argmax plus a
    confidence threshold, so a small shift in one softmax flips a stored
    character or silences a real read. Measured on the plate recognizer, fp16
    moved the weakest-character probability by up to 0.16 and changed the label
    on a ground-truthed plate. The default stays fp16 so nothing already
    published moves.

    Dynamic-shape models (e.g. YOLO) emit ``Shape`` ops that coremltools' Torch
    converter cannot lower ("Converter is not implemented … 'Shape'"). We first
    run onnx-simplifier with the input shape pinned, which constant-folds those
    Shape ops away, so the traced graph is static and convertible.
    """
    import coremltools as ct
    import onnx
    import torch
    from onnx2torch import convert as onnx_to_torch
    from onnxsim import simplify

    shape = list(input_shape) if input_shape is not None else [1, 3, imgsz, imgsz]
    onnx_model = onnx.load(onnx_path)
    input_name = onnx_model.graph.input[0].name
    simplified, ok = simplify(onnx_model, overwrite_input_shapes={input_name: shape})
    if not ok:
        simplified = onnx_model  # fall back to the original if simplify bailed

    model = onnx_to_torch(simplified).eval()
    example = torch.rand(*shape)
    with torch.no_grad():
        traced = torch.jit.trace(model, example, strict=False)

    mlmodel = ct.convert(
        traced,
        source="pytorch",
        inputs=[ct.TensorType(name="input", shape=example.shape)],
        minimum_deployment_target=ct.target.iOS16,
        **({"compute_precision": ct.precision.FLOAT32} if fp32 else {}),
    )
    Path(out_pkg).parent.mkdir(parents=True, exist_ok=True)
    mlmodel.save(out_pkg)


def validate_coreml(pkg_path: str) -> None:
    import coremltools as ct
    ct.models.MLModel(pkg_path)  # load; raises if malformed
