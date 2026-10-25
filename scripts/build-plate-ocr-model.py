#!/usr/bin/env python3
"""Build the `cct-s-v2-global` catalog artefacts from ankandrew/fast-plate-ocr.

    python3 scripts/build-plate-ocr-model.py <work-dir> [--skip-verify]
    hf upload camstack/camstack-models <work-dir>/stage/plateRecognition/cct-s-v2-global \
        plateRecognition/cct-s-v2-global

Produces, under ``<work-dir>/stage/plateRecognition/cct-s-v2-global``:

    onnx/camstack-cct-s-v2-global.onnx           (fp32, ~5 MB)
    openvino/camstack-cct-s-v2-global.{xml,bin}  (fp32, ~5 MB)
    coreml/camstack-cct-s-v2-global.mlpackage    (fp32, ~5 MB)

SOURCE — MIT code, weights published as that repo's own release assets
---------------------------------------------------------------------
``ankandrew/fast-plate-ocr`` is MIT (LICENSE, Copyright 2024 ankandrew) and the
ONNX lives in ITS OWN release (tag ``arg-plates``, "HUB"), not a third-party
mirror — ``ankandrew/cnn-ocr-lp`` (the URL ``hub.py`` still uses) 301s to the
same repo. There is no separate weights licence and no model card, and the
maintainer states the v2 training corpus is a PRIVATE dataset he will not
release, so the DATA provenance is unauditable. The catalog entry says exactly
that; it does not claim more than the LICENSE file supports.

THE UNBAKED RESCALE — why the graph is patched
----------------------------------------------
Upstream takes ``uint8`` NHWC and opens with ``Cast(uint8→float) →
Mul(1/255)``. The CamStack inference pool feeds every float model an RGB tensor
ALREADY in [0,1] (``inference_pool.resize_image`` divides by 255) and has no
"feed me uint8 instead" switch — a uint8 input would need a second preprocess
branch in the pool for one model.

Those two leading nodes compute EXACTLY what the pool already hands over, so
this script DELETES them and re-types the graph input as float32. Nothing is
approximated: the tensor that used to arrive at the Transpose is the tensor the
pool produces, bit for bit (verified below at max-abs-diff 0.0 against upstream
fed uint8). The reverse — prepending a ``Mul(255) → Cast(uint8)`` — would round
away the pool's fractional pixels for no gain.

fp32 EVERYWHERE — the one thing fp16 must not touch
---------------------------------------------------
Every other model in this catalog ships fp16 OpenVINO/CoreML: a detector's box
moves a fraction of a pixel, an embedder's cosine moves 5e-5. A RECOGNIZER has
no such budget. Its answer is an argmax plus a confidence THRESHOLD, and fp16
moved the weakest-character probability of these crops by up to 0.16 — enough to
flip a glyph on a junk ROI and, on `full-d20e8bab-keyFrame-134`, to silence a
ground-truthed plate that fp32 reads. The gate below caught exactly that. The
saving fp16 would have bought is 2.5 MB on a 5 MB model.

THE EQUIVALENCE GATE IS A STRING GATE
-------------------------------------
This is an OCR, not an embedder: a cosine on the logits would pass while the
argmax flipped a glyph. The gate compares the DECODED PLATE STRINGS across
upstream / patched-onnx / openvino / coreml on the 39 real cam-102 crops of
``scratchpad/plate-audit/102``, and requires them to be identical. The logit
max-abs-diff is reported alongside as diagnosis, never as the pass condition.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request
from hashlib import sha256
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "packages" / "addon-model-studio" / "python"))

BASE = "https://github.com/ankandrew/fast-plate-ocr/releases/download/arg-plates"
SRC_URL = f"{BASE}/cct_s_v2_global.onnx"
SRC_SHA256 = "384bbbd2cea3ef54761d3df70822ef3a349ee1a112aeafddbe0e3ba06bc6e47b"
SRC_BYTES = 5_262_230
CONFIG_URL = f"{BASE}/cct_s_v2_global_plate_config.yaml"
NAME = "camstack-cct-s-v2-global"
IN_H, IN_W = 64, 128
# Batch is exported static at 1. NOT because this model is special — the defence
# that matters lives at the LOAD, not here: `_static_batch_required` /
# `_pin_batch_for_device` in `packages/addon-pipeline/python/inference_pool.py`
# reshape ANY dynamic-batch graph to a static 1 before it reaches a compiler that
# refuses dynamic dims (the Intel NPU), for every model, converted here or by an
# operator in model-studio (D202). A per-model pin in a conversion script cannot
# generalise and is not the rule.
#
# It stays because it is free and it makes the three exported formats agree: the
# pool's `max_batch_size` defaults to 1 and this catalog entry does not raise it
# (a plate-OCR leaf reads one crop per request), and the CoreML export is already
# static at (1, 64, 128, 3).
#
# The failure this came from, live on the hub 2026-08-20: an operator-pinned NPU
# node compiled nothing ("Got negative shape dim bound: '-1'", then
# ZE_RESULT_ERROR_INVALID_ARGUMENT) and retried the load forever, with no error
# the caller could see.
BATCH = 1
SLOTS, VOCAB = 10, 37
ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_"
# The 39 ground-truthed cam-102 crops the string gate runs on (2026-08-20 set).
BENCH_SET = REPO / "scratchpad" / "plate-audit" / "102" / "set.json"
BENCH_PAD = 0.15
BENCH_KF = REPO / "scratchpad" / "plate-audit" / "102" / "kf"


def _download(dest: Path) -> Path:
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"→ downloading {SRC_URL}")
        urllib.request.urlretrieve(SRC_URL, dest)
    digest = sha256(dest.read_bytes()).hexdigest()
    if digest != SRC_SHA256:
        raise SystemExit(f"cct_s_v2_global.onnx sha256 {digest} != expected {SRC_SHA256}")
    if dest.stat().st_size != SRC_BYTES:
        raise SystemExit(f"cct_s_v2_global.onnx is {dest.stat().st_size} B, expected {SRC_BYTES}")
    print(f"  ✓ sha256 {digest}")
    return dest


def _strip_rescale(src: Path, dst: Path) -> None:
    """Drop the leading ``Cast → Mul(1/255)`` and re-type the input as float32.

    Asserts the constant really is 1/255 before removing anything: if upstream
    ever retrains with a different rescale, this must FAIL rather than silently
    publish a model fed the wrong range.
    """
    import numpy as np
    import onnx
    from onnx import TensorProto, numpy_helper

    model = onnx.load(str(src))
    graph = model.graph
    cast, mul = graph.node[0], graph.node[1]
    if cast.op_type != "Cast" or mul.op_type != "Mul":
        raise SystemExit(f"expected Cast→Mul at the graph head, got {cast.op_type}→{mul.op_type}")
    if cast.input[0] != graph.input[0].name or mul.input[0] != cast.output[0]:
        raise SystemExit("the head nodes are not wired input→Cast→Mul")

    initializers = {i.name: numpy_helper.to_array(i) for i in graph.initializer}
    scale_name = next((n for n in mul.input if n in initializers), None)
    if scale_name is None:
        raise SystemExit("the rescale Mul has no constant operand")
    scale = float(np.asarray(initializers[scale_name]).reshape(-1)[0])
    if abs(scale - 1.0 / 255.0) > 1e-9:
        raise SystemExit(f"rescale constant is {scale}, expected 1/255 — upstream changed")
    print(f"  ✓ rescale constant {scale} == 1/255, removing Cast+Mul")

    rescaled = mul.output[0]
    inp = graph.input[0]
    inp.type.tensor_type.elem_type = TensorProto.FLOAT
    for dim, value in zip(inp.type.tensor_type.shape.dim, (BATCH, IN_H, IN_W, 3)):
        dim.Clear()
        dim.dim_value = value

    for node in graph.node:
        for i, name in enumerate(node.input):
            if name == rescaled:
                node.input[i] = inp.name
    del graph.node[0:2]
    graph.initializer.remove(next(i for i in graph.initializer if i.name == scale_name))

    for out, dims in (("plate", (SLOTS, VOCAB)), ("region", None)):
        spec = next((o for o in graph.output if o.name == out), None)
        if spec is None:
            raise SystemExit(f"upstream graph has no `{out}` output")
        shape = spec.type.tensor_type.shape.dim
        shape[0].Clear()
        shape[0].dim_value = BATCH
        if dims is not None and [d.dim_value for d in shape[1:]] != list(dims):
            raise SystemExit(f"`{out}` is not [{BATCH},{dims[0]},{dims[1]}]")

    stale = {rescaled, cast.output[0]}
    keep = [v for v in graph.value_info if v.name not in stale]
    del graph.value_info[:]
    graph.value_info.extend(keep)

    model.producer_name = "camstack"
    model.doc_string = (
        "fast-plate-ocr cct-s-v2-global (ankandrew, MIT). Input `input`: RGB NHWC "
        "float32 in [0,1] (the CamStack pool's /255 tensor); upstream's uint8 Cast + "
        "Mul(1/255) head is REMOVED because it computes exactly that tensor. "
        "Batch is pinned to 1 (the Intel NPU compiler rejects a dynamic dim). "
        "Outputs: `plate` [1,10,37] per-slot softmax over "
        "'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_' (pad '_'), `region` [batch,66]."
    )
    onnx.checker.check_model(model)
    dst.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(dst))
    print(f"  ✓ {dst.name} ({dst.stat().st_size / 1e6:.1f} MB)")


# --- stages, each in its own interpreter --------------------------------------
# Same rule as build-auraface-model.py: openvino and the protobuf/absl stack
# coremltools drags in deadlock inside abseil when loaded in one process.


def _run_stage(name: str, *args: str) -> None:
    run = subprocess.run([sys.executable, __file__, "--stage", name, *args])
    if run.returncode != 0:
        raise SystemExit(f"stage {name} failed (exit {run.returncode})")


def _stage_openvino(onnx_path: Path, xml: Path) -> None:
    from convert_lib import export_openvino, validate_openvino_ir

    # fp32, not fp16 — see the module docstring: this is a recognizer.
    export_openvino(str(onnx_path), str(xml), fp16=False)
    validate_openvino_ir(str(xml))
    print(f"  ✓ {xml.name} + .bin ({xml.with_suffix('.bin').stat().st_size / 1e6:.1f} MB)")


def _stage_coreml(onnx_path: Path, pkg: Path) -> None:
    """Export, then RESTORE the output names the ONNX→torch trace threw away.

    ``torch.jit.trace`` keeps no tensor names, so coremltools emits
    ``var_1877`` / ``var_2077`` where the ONNX has ``plate`` / ``region``. The
    postprocessor selects the plate head BY NAME (the graph has two outputs and
    dict order is not a contract), so a package shipped with the traced names
    would fall back to shape-matching on every Mac agent — working by accident.
    This is the same defect ``validate_openvino_ir`` was written for.
    """
    import coremltools as ct
    from convert_lib import export_coreml_from_onnx, validate_coreml

    export_coreml_from_onnx(
        str(onnx_path), str(pkg), IN_W, input_shape=(1, IN_H, IN_W, 3), fp32=True
    )

    model = ct.models.MLModel(str(pkg))
    spec = model.get_spec()
    wanted = {(1, SLOTS, VOCAB): "plate", (1, 66): "region"}
    for out in list(spec.description.output):
        name = wanted.get(tuple(out.type.multiArrayType.shape))
        if name is None:
            raise SystemExit(f"unexpected CoreML output {out.name} {out.type.multiArrayType.shape}")
        if out.name != name:
            ct.utils.rename_feature(spec, out.name, name)
    got = [o.name for o in spec.description.output]
    if sorted(got) != ["plate", "region"]:
        raise SystemExit(f"CoreML outputs are {got}, expected plate + region")
    ct.models.MLModel(spec, weights_dir=model.weights_dir).save(str(pkg))

    validate_coreml(str(pkg))
    size = sum(f.stat().st_size for f in pkg.rglob("*") if f.is_file())
    print(f"  ✓ {pkg.name} ({size / 1e6:.1f} MB)  outputs {got}")


# --- the string equivalence gate ---------------------------------------------


def _bench_inputs() -> "list[tuple[str, object]]":
    """The real cam-102 crops, cut exactly as the executor cuts them (+15%)."""
    import numpy as np
    from PIL import Image

    entries = json.load(open(BENCH_SET))
    out = []
    for e in entries:
        img = Image.open(BENCH_KF / f"{e['track']}.{e['kind']}.jpg")
        w, h = e["w"], e["h"]
        box = (
            int(max(0, round(e["x"] - w * BENCH_PAD))),
            int(max(0, round(e["y"] - h * BENCH_PAD))),
            int(min(img.width, round(e["x"] + w * (1 + BENCH_PAD)))),
            int(min(img.height, round(e["y"] + h * (1 + BENCH_PAD)))),
        )
        crop = img.crop(box).convert("RGB").resize((IN_W, IN_H), Image.BILINEAR)
        out.append((e["id"], np.asarray(crop, dtype=np.uint8)))
    return out


def _decode(plate: "object") -> str:
    import numpy as np

    probs = np.asarray(plate, dtype=np.float32).reshape(SLOTS, VOCAB)
    return "".join(ALPHABET[i] for i in np.argmax(probs, axis=-1)).rstrip("_")


def _emit(engine: str, base: Path, upstream: Path, tmp: Path) -> None:
    import numpy as np

    ids_arrays = _bench_inputs()
    texts: list[str] = []
    logits: list["np.ndarray"] = []
    if engine == "upstream":
        import onnxruntime as ort

        sess = ort.InferenceSession(str(upstream), providers=["CPUExecutionProvider"])
        name = sess.get_inputs()[0].name
        for _id, arr in ids_arrays:
            out = sess.run(["plate"], {name: arr[None]})[0]
            texts.append(_decode(out))
            logits.append(np.asarray(out).ravel())
    elif engine == "onnx":
        import onnxruntime as ort

        sess = ort.InferenceSession(
            str(base / f"onnx/{NAME}.onnx"), providers=["CPUExecutionProvider"]
        )
        name = sess.get_inputs()[0].name
        for _id, arr in ids_arrays:
            out = sess.run(["plate"], {name: (arr[None].astype(np.float32) / 255.0)})[0]
            texts.append(_decode(out))
            logits.append(np.asarray(out).ravel())
    elif engine == "openvino":
        import openvino as ov

        compiled = ov.Core().compile_model(str(base / f"openvino/{NAME}.xml"), "CPU")
        port = next(p for p in compiled.outputs if "plate" in p.get_names())
        for _id, arr in ids_arrays:
            out = np.array(compiled(arr[None].astype(np.float32) / 255.0)[port])
            texts.append(_decode(out))
            logits.append(out.ravel())
    elif engine == "coreml":
        import coremltools as ct

        ml = ct.models.MLModel(str(base / f"coreml/{NAME}.mlpackage"))
        spec = ml.get_spec()
        iname = spec.description.input[0].name
        oname = next(o.name for o in spec.description.output if "plate" in o.name)
        for _id, arr in ids_arrays:
            out = np.array(ml.predict({iname: arr[None].astype(np.float32) / 255.0})[oname])
            texts.append(_decode(out))
            logits.append(out.ravel())
    else:
        raise SystemExit(f"unknown engine {engine}")
    (tmp / f"{engine}.json").write_text(json.dumps(texts))
    np.save(tmp / f"{engine}.npy", np.stack(logits))


def _gated(logits_row: "object") -> str:
    """The text the SHIPPED postprocessor would store for this crop.

    The gate compares what can actually become a plate label, not the raw
    argmax: fp16 rounding is allowed to flip a glyph of a read that the
    confidence floor or the grammar throws away anyway (an OSD weather band
    decodes to garbage on every engine, differently), and is NOT allowed to
    change one character of anything that survives to a label.
    """
    import numpy as np

    sys.path.insert(0, str(REPO / "packages" / "addon-pipeline" / "python"))
    from postprocessors.plate_slots import postprocess_plate_slots

    row = np.asarray(logits_row, dtype=np.float32).reshape(1, SLOTS, VOCAB)
    return postprocess_plate_slots({"plate": row}, {"plateRegion": "DE"}, IN_W, IN_H, 1.0, (0, 0))[
        "text"
    ]


def _verify(base: Path, upstream: Path, tmp: Path, want_coreml: bool) -> None:
    import numpy as np

    tmp.mkdir(parents=True, exist_ok=True)
    engines = ["upstream", "onnx", "openvino"] + (["coreml"] if want_coreml else [])
    for engine in engines:
        _run_stage(f"emit-{engine}", str(base), str(upstream), str(tmp))

    texts = {e: json.loads((tmp / f"{e}.json").read_text()) for e in engines}
    logits = {e: np.load(tmp / f"{e}.npy") for e in engines}
    entries = json.load(open(BENCH_SET))
    ids = [e["id"] for e in entries]
    # A crop with a human-verified plate: its RAW decode must not move either,
    # even if today's gate would have silenced a flip.
    truthed = {e["id"] for e in entries if e["truth"]}
    gated = {e: [_gated(row) for row in logits[e]] for e in engines}

    failures: list[str] = []
    for engine in engines[1:]:
        raw_diff = [
            (i, a, b) for i, a, b in zip(ids, texts["upstream"], texts[engine]) if a != b
        ]
        # The invariant, and the reason it is not "identical labels": OpenVINO's
        # CPU default inference precision is fp16 (float32 weights do not change
        # that) and an Intel NPU has no other option, so a marginal crop's
        # weakest-character probability moves by up to 0.16 between engines. No
        # threshold survives that on every crop — `full-8e8dce33-keyFrame-52`
        # alone reads 0.609 on fp16 and 0.770 on fp32.
        #
        # What MUST hold is that the disagreement is only ever EMIT vs SILENCE.
        # Two engines emitting two DIFFERENT plates is a wrong stored label and
        # nothing downstream can undo it; an engine falling silent on a marginal
        # crop is absorbed — the step runs up to `maxPerTrack` times per track
        # and the reads are voted (D186).
        contradictions = [
            (i, a, b)
            for i, a, b in zip(ids, gated["upstream"], gated[engine])
            if a and b and a != b
        ]
        silences = [
            (i, a, b)
            for i, a, b in zip(ids, gated["upstream"], gated[engine])
            if bool(a) != bool(b)
        ]
        plate_diff = [(i, a, b) for i, a, b in raw_diff if i in truthed]
        diff = float(np.max(np.abs(logits["upstream"] - logits[engine])))
        print(
            f"  {engine:10s} contradictions {len(contradictions)}"
            f"   emit/silence splits {len(silences)}"
            f"   raw {len(ids) - len(raw_diff)}/{len(ids)}"
            f"   max|Δlogit| {diff:.6f}"
        )
        for i, a, b in raw_diff:
            tag = "PLATE" if i in truthed else "junk"
            print(f"      raw {tag}: {i}: upstream {a!r} != {engine} {b!r}")
        for i, a, b in silences:
            print(f"      split: {i}: upstream {a or '(silent)'} / {engine} {b or '(silent)'}")
        for i, a, b in contradictions:
            print(f"      CONTRADICTION: {i}: upstream {a!r} != {engine} {b!r}")
        if contradictions:
            failures.append(
                f"{engine} would store a DIFFERENT plate on {len(contradictions)} crop(s)"
            )
        if plate_diff:
            failures.append(
                f"{engine} decodes {len(plate_diff)} ground-truthed plate(s) differently"
            )
    if failures:
        raise SystemExit("  ✗ " + "\n  ✗ ".join(failures))
    print("  ✓ no engine contradicts another on any crop, and every ground-truthed")
    print("    plate decodes identically to upstream on every engine")


def main() -> None:
    if len(sys.argv) > 2 and sys.argv[1] == "--stage":
        stage, rest = sys.argv[2], [Path(a) for a in sys.argv[3:]]
        if stage.startswith("emit-"):
            _emit(stage.removeprefix("emit-"), *rest)
        elif stage == "openvino":
            _stage_openvino(*rest)
        elif stage == "coreml":
            _stage_coreml(*rest)
            # coremltools' protobuf/abseil stack SIGABRTs during interpreter
            # teardown on this toolchain — after the package is written and
            # validated. The parent only sees exit -6 and calls a finished
            # conversion a failure. Leave via _exit so the exit code reports
            # what the stage actually did; everything it produced is already
            # flushed to disk by MLModel.save().
            sys.stdout.flush()
            sys.stderr.flush()
            os._exit(0)
        else:
            raise SystemExit(f"unknown stage {stage}")
        return

    work = Path(sys.argv[1] if len(sys.argv) > 1 else "plate-ocr-build").resolve()
    base = work / "stage" / "plateRecognition" / "cct-s-v2-global"
    upstream = _download(work / "src" / "cct_s_v2_global.onnx")

    print("→ removing upstream's uint8 Cast + Mul(1/255) head")
    onnx_path = base / "onnx" / f"{NAME}.onnx"
    _strip_rescale(upstream, onnx_path)

    print("→ OpenVINO IR (fp16)")
    _run_stage("openvino", str(onnx_path), str(base / "openvino" / f"{NAME}.xml"))

    want_coreml = sys.platform == "darwin"
    if want_coreml:
        print("→ CoreML mlpackage (onnxsim → onnx2torch → trace → coremltools)")
        _run_stage("coreml", str(onnx_path), str(base / "coreml" / f"{NAME}.mlpackage"))
    else:
        print("⊘ CoreML skipped — darwin only")

    if "--skip-verify" not in sys.argv:
        print("→ cross-engine string equivalence on the cam-102 set")
        _verify(base, upstream, work / "verify-tmp", want_coreml)

    print(f"\nReady to publish: {base}")
    print(
        "  hf upload camstack/camstack-models "
        f"{base} plateRecognition/cct-s-v2-global"
    )


if __name__ == "__main__":
    main()
