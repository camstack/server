#!/usr/bin/env python3
"""Build the `auraface-r100` catalog artefacts from fal.ai's AuraFace v1.

    python3 scripts/build-auraface-model.py <work-dir> [--skip-verify]
    hf upload camstack/camstack-models <work-dir>/stage/faceRecognition/auraface \
        faceRecognition/auraface

Produces, under ``<work-dir>/stage/faceRecognition/auraface``, the three formats
the catalog entry points at:

    onnx/camstack-auraface-r100.onnx           (fp32, ~261 MB)
    openvino/camstack-auraface-r100.{xml,bin}  (fp16, ~131 MB)
    coreml/camstack-auraface-r100.mlpackage    (fp16, ~131 MB)

SOURCE — only one file of the pack is ours to use
-------------------------------------------------
``fal/AuraFace-v1`` is tagged Apache-2.0, but only ``glintr100.onnx`` (the
recogniser fal actually trained) is genuinely theirs to relicense. The other
four files in that repo (``scrfd_10g_bnkps``, ``1k3d68``, ``2d106det``,
``genderage``) are verbatim InsightFace weights and carry InsightFace's
non-commercial terms. This script downloads glintr100.onnx and nothing else, and
pins its sha256.

THE BAKED NORMALISATION — do not drop it
----------------------------------------
Upstream is a stock InsightFace ArcFace recogniser: ``ArcFaceONNX`` feeds
``(RGB_uint8 - 127.5) / 127.5`` → [-1,1]. The CamStack inference pool feeds every
float model ``/255`` → [0,1] (``inference_pool._preprocess``; the OpenVINO PPP
fast path scales by 255 to the same range) and has no ``inputNormalization``
value for the difference.

That difference is ``y = 2x - 1`` — a scale AND a shift. The scale alone would
survive (Conv and PReLU are positively homogeneous), but the SHIFT cannot: this
graph opens with a ``Conv`` and its first ``BatchNormalization`` sits after a
``PReLU``, so no leading affine op absorbs the offset. (Contrast ``arcface-r100``,
whose BatchNorms do absorb it — hence that entry deliberately does nothing.)
Measured, feeding [0,1] to the raw graph yields cosine 0.70-0.77 against the
correctly-fed embedding: a broken recogniser, quietly.

So the ``Mul(2) → Sub(1)`` is baked into the ONNX ahead of the first Conv, and
all three formats are derived from that patched graph. The published artefacts
consume the pool's ``/255`` tensor and reproduce upstream exactly (cosine
1.000000, max abs diff 0.0). Never re-publish from the raw file without it.
"""
from __future__ import annotations

import subprocess
import sys
import urllib.request
from hashlib import sha256
from pathlib import Path

sys.path.insert(
    0, str(Path(__file__).resolve().parents[1] / "packages" / "addon-model-studio" / "python")
)

SRC_URL = "https://huggingface.co/fal/AuraFace-v1/resolve/main/glintr100.onnx"
SRC_SHA256 = "a7933ea5330113b01c9b60351d8f4c33003f145d8470ac5f0e52ee2effe25c60"
SRC_BYTES = 260_694_151
NAME = "camstack-auraface-r100"
IMGSZ = 112

# fp16 round-trip gates. OpenVINO fp16 is the looser of the two in practice
# (~0.9992); CoreML fp16 lands at ~0.99995.
OV_COSINE_MIN = 0.999
COREML_COSINE_MIN = 0.99


def _download(dest: Path) -> Path:
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"→ downloading {SRC_URL}")
        urllib.request.urlretrieve(SRC_URL, dest)
    digest = sha256(dest.read_bytes()).hexdigest()
    if digest != SRC_SHA256:
        raise SystemExit(f"glintr100.onnx sha256 {digest} != expected {SRC_SHA256}")
    if dest.stat().st_size != SRC_BYTES:
        raise SystemExit(f"glintr100.onnx is {dest.stat().st_size} B, expected {SRC_BYTES}")
    print(f"  ✓ sha256 {digest}")
    return dest


def _bake_normalization(src: Path, dst: Path) -> None:
    """Prepend ``y = x*2 - 1``, name the output ``embedding``, dynamic batch.

    The dynamic batch axis stays: an export cannot know whether it will be loaded
    on a CPU, an iGPU, an NPU or the ANE, so the target-specific decision belongs
    to the loader — `_pin_batch_for_device` in `inference_pool.py` reshapes it
    static for the Intel NPU and leaves it alone everywhere else (D202).
    """
    import numpy as np
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    model = onnx.load(str(src))
    graph = model.graph
    inp, out = graph.input[0], graph.output[0]
    conv_input, old_out = inp.name, out.name

    RAW = "data_raw01"
    inp.name = RAW
    for dim, value in zip(inp.type.tensor_type.shape.dim, ("batch", 3, IMGSZ, IMGSZ)):
        dim.Clear()
        if isinstance(value, str):
            dim.dim_param = value
        else:
            dim.dim_value = value

    graph.initializer.extend([
        numpy_helper.from_array(np.array(2.0, dtype=np.float32), "arcface_norm_scale"),
        numpy_helper.from_array(np.array(1.0, dtype=np.float32), "arcface_norm_shift"),
    ])
    graph.node.insert(
        0,
        helper.make_node("Sub", ["data_scaled", "arcface_norm_shift"], [conv_input],
                         name="arcface_norm_sub"),
    )
    graph.node.insert(
        0,
        helper.make_node("Mul", [RAW, "arcface_norm_scale"], ["data_scaled"],
                         name="arcface_norm_mul"),
    )

    NEW_OUT = "embedding"
    for node in graph.node:
        for i, name in enumerate(node.output):
            if name == old_out:
                node.output[i] = NEW_OUT
    out.name = NEW_OUT
    out.type.tensor_type.elem_type = TensorProto.FLOAT
    dims = out.type.tensor_type.shape.dim
    dims[0].Clear()
    dims[0].dim_param = "batch"
    dims[1].Clear()
    dims[1].dim_value = 512

    keep = [v for v in graph.value_info if v.name not in (old_out, conv_input)]
    del graph.value_info[:]
    graph.value_info.extend(keep)

    model.producer_name = "camstack"
    model.doc_string = (
        # Byte-for-byte identical to the published artefact — do not reword.
        "AuraFace v1 (fal.ai) glintr100 R100 ArcFace recogniser, Apache-2.0. "
        "Input `data_raw01`: RGB NCHW float in [0,1] (the CamStack pool's /255 tensor); "
        "the upstream (x-127.5)/127.5 normalisation is baked in as Mul(2)-Sub(1). "
        "Output `embedding`: 512-d, L2-normalise downstream."
    )
    onnx.checker.check_model(model)
    dst.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(dst))
    print(f"  ✓ {dst.name} ({dst.stat().st_size / 1e6:.1f} MB)")


# --- stages, each in its own interpreter -------------------------------------
# EVERY stage that touches a runtime runs as `python build-auraface-model.py
# --stage <name> …` in a fresh process. Loading openvino and then the
# protobuf/absl stack coremltools pulls in — or onnxruntime and then openvino —
# deadlocks this Mac inside abseil (`[mutex.cc : 452] RAW: Lock blocking`), at
# ~19% CPU and no output. It looks EXACTLY like a slow conversion, which is how
# it survived a first read: the two stages had been run as separate commands by
# hand and only failed once the script ran them back to back.


def _run_stage(name: str, *args: str) -> None:
    run = subprocess.run([sys.executable, __file__, "--stage", name, *args])
    if run.returncode != 0:
        raise SystemExit(f"stage {name} failed (exit {run.returncode})")


def _stage_openvino(onnx_path: Path, xml: Path) -> None:
    from convert_lib import export_openvino, validate_openvino_ir

    export_openvino(str(onnx_path), str(xml), fp16=True)
    validate_openvino_ir(str(xml))
    print(f"  ✓ {xml.name} + .bin ({xml.with_suffix('.bin').stat().st_size / 1e6:.1f} MB)")


def _stage_coreml(onnx_path: Path, pkg: Path) -> None:
    from convert_lib import export_coreml_from_onnx, validate_coreml

    export_coreml_from_onnx(str(onnx_path), str(pkg), IMGSZ)
    validate_coreml(str(pkg))
    size = sum(f.stat().st_size for f in pkg.rglob("*") if f.is_file())
    print(f"  ✓ {pkg.name} ({size / 1e6:.1f} MB)")


def _synthetic_inputs():
    import numpy as np

    rng = np.random.default_rng(1234)
    yy, xx = np.mgrid[0:IMGSZ, 0:IMGSZ].astype(np.float32) / (IMGSZ - 1)
    blob = np.stack([
        np.exp(-(((xx - 0.5) ** 2 + (yy - 0.45) ** 2) / 0.08)),
        0.6 * np.sin(6 * xx) * np.cos(5 * yy) * 0.5 + 0.5,
        (xx + yy) / 2,
    ]).astype(np.float32)
    return np.stack([
        rng.random((3, IMGSZ, IMGSZ), dtype=np.float32),
        np.clip(blob, 0, 1),
        np.clip(0.5 + 0.25 * rng.standard_normal((3, IMGSZ, IMGSZ)).astype(np.float32), 0, 1),
    ])


def _embed(engine: str, base: Path, upstream: Path, tmp: Path) -> None:
    import numpy as np

    xs = _synthetic_inputs()
    if engine == "onnx":
        import onnxruntime as ort

        sess = ort.InferenceSession(str(base / f"onnx/{NAME}.onnx"),
                                    providers=["CPUExecutionProvider"])
        name = sess.get_inputs()[0].name
        np.save(tmp / "onnx.npy",
                np.stack([sess.run(None, {name: x[None]})[0].ravel() for x in xs]))
        up = ort.InferenceSession(str(upstream), providers=["CPUExecutionProvider"])
        np.save(tmp / "upstream.npy",
                np.stack([up.run(None, {"data": x[None] * 2 - 1})[0].ravel() for x in xs]))
        np.save(tmp / "unbaked.npy",
                np.stack([up.run(None, {"data": x[None]})[0].ravel() for x in xs]))
    elif engine == "openvino":
        import openvino as ov

        compiled = ov.Core().compile_model(str(base / f"openvino/{NAME}.xml"), "CPU")
        port = compiled.output(0)
        np.save(tmp / "openvino.npy",
                np.stack([np.array(compiled(x[None])[port]).ravel() for x in xs]))
    elif engine == "coreml":
        import coremltools as ct

        ml = ct.models.MLModel(str(base / f"coreml/{NAME}.mlpackage"))
        spec = ml.get_spec()
        i, o = spec.description.input[0].name, spec.description.output[0].name
        np.save(tmp / "coreml.npy",
                np.stack([np.array(ml.predict({i: x[None]})[o]).ravel() for x in xs]))


def _verify(base: Path, upstream: Path, tmp: Path, want_coreml: bool) -> None:
    import numpy as np

    tmp.mkdir(parents=True, exist_ok=True)
    for engine in ["onnx", "openvino"] + (["coreml"] if want_coreml else []):
        _run_stage(f"embed-{engine}", str(base), str(upstream), str(tmp))

    emb = {k: np.load(tmp / f"{k}.npy") for k in
           ["onnx", "upstream", "unbaked", "openvino"] + (["coreml"] if want_coreml else [])}

    def report(label, a, b):
        cs = [float(x @ y / (np.linalg.norm(x) * np.linalg.norm(y))) for x, y in zip(a, b)]
        print(f"  {label:34s} {[round(c, 6) for c in cs]}  min={min(cs):.6f}")
        return min(cs)

    print(f"  embedding dim: {emb['onnx'].shape[1]}")
    baked = report("baked ONNX vs upstream", emb["onnx"], emb["upstream"])
    report("  (upstream fed /255, no bake)", emb["upstream"], emb["unbaked"])
    ov_min = report("ONNX fp32 vs OpenVINO fp16", emb["onnx"], emb["openvino"])
    ml_min = report("ONNX fp32 vs CoreML fp16", emb["onnx"], emb["coreml"]) if want_coreml else 1.0

    failures = []
    if baked < 0.99999:
        failures.append(f"bake is not exact ({baked:.6f}) — the Mul/Sub prepend is wrong")
    if ov_min < OV_COSINE_MIN:
        failures.append(f"OpenVINO fp16 cosine {ov_min:.6f} < {OV_COSINE_MIN}")
    if want_coreml and ml_min < COREML_COSINE_MIN:
        failures.append(f"CoreML fp16 cosine {ml_min:.6f} < {COREML_COSINE_MIN}")
    if failures:
        raise SystemExit("  ✗ " + "\n  ✗ ".join(failures))
    print("  ✓ all engines agree")


def main() -> None:
    if len(sys.argv) > 2 and sys.argv[1] == "--stage":
        stage, rest = sys.argv[2], [Path(a) for a in sys.argv[3:]]
        if stage.startswith("embed-"):
            _embed(stage.removeprefix("embed-"), *rest)
        elif stage == "openvino":
            _stage_openvino(*rest)
        elif stage == "coreml":
            _stage_coreml(*rest)
        else:
            raise SystemExit(f"unknown stage {stage}")
        return

    work = Path(sys.argv[1] if len(sys.argv) > 1 else "auraface-build").resolve()
    base = work / "stage" / "faceRecognition" / "auraface"
    upstream = _download(work / "src" / "glintr100.onnx")

    print("→ baking the ArcFace input normalisation into the ONNX")
    onnx_path = base / "onnx" / f"{NAME}.onnx"
    _bake_normalization(upstream, onnx_path)

    print("→ OpenVINO IR (fp16)")
    _run_stage("openvino", str(onnx_path), str(base / "openvino" / f"{NAME}.xml"))

    want_coreml = sys.platform == "darwin"
    if want_coreml:
        print("→ CoreML mlpackage (onnxsim → onnx2torch → trace → coremltools)")
        _run_stage("coreml", str(onnx_path), str(base / "coreml" / f"{NAME}.mlpackage"))
    else:
        print("⊘ CoreML skipped — darwin only")

    if "--skip-verify" not in sys.argv:
        print("→ cross-engine verification")
        _verify(base, upstream, work / "verify-tmp", want_coreml)

    print(f"\nReady to publish: {base}")
    print("  hf upload camstack/camstack-models "
          f"{base} faceRecognition/auraface")


if __name__ == "__main__":
    main()
