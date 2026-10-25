#!/usr/bin/env python3
"""Build the `yunet-2023mar` catalog artefacts from OpenCV Zoo's YuNet.

    python3 scripts/build-yunet-model.py <work-dir> [--skip-verify]
    hf upload camstack/camstack-models <work-dir>/stage/faceDetection/yunet \
        faceDetection/yunet

Produces, under ``<work-dir>/stage/faceDetection/yunet``, the three formats the
catalog entry points at, plus the model card:

    onnx/camstack-yunet-2023mar.onnx             (fp32, ~0.23 MB)
    openvino/camstack-yunet-2023mar.{xml,bin}    (fp32, ~0.23 MB)
    coreml/camstack-yunet-2023mar.mlpackage      (fp16, ~0.2 MB)
    README.md                                    (licence + provenance)

SOURCE
------
``face_detection_yunet_2023mar.onnx`` from ``opencv/face_detection_yunet`` on
HuggingFace — the OpenCV Zoo model folder, weights MIT ("Copyright (c) 2020
Shiqi Yu"). sha256 pinned below; it equals the HF LFS oid and the opencv_zoo
file. The fp32 file, not the 100 KB int8 one plus catalog ships: every number the
2026-09-26 replacement spike measured (196/204 COCO faces, 6-7 ms) was measured
on fp32, int8 changed nothing measurable, and a QLinear graph is one more thing
the OpenVINO/CoreML conversions and the ORT execution providers would have to
agree on — for 130 KB.

THE BAKED INPUT CONTRACT — do not drop it
-----------------------------------------
Upstream YuNet expects **BGR, 0..255**. The CamStack pool feeds every float
model **RGB, /255** (``inference_pool._preprocess``; the OpenVINO PPP fast path
scales by 255 to the same range; the CoreML ``multiArrayType`` path letterboxes
to the same ``/255`` array). Fed that, YuNet finds 0 faces on 413 person crops.

The fix is baked into the graph ahead of the first Conv — ``Mul(255)`` then
``Gather([2,1,0], axis=1)`` — and all three formats are derived from that
patched ONNX, so the contract is applied exactly ONCE on every backend and the
catalog entry declares no ``inputNormalization`` (a pool normalisation on top
would apply it twice). Same technique as ``build-auraface-model.py``. The
verify pass proves the bake exact against upstream fed ``BGR*255``.

The CoreML outputs are NAMED explicitly (``cls_8`` … ``kps_32``): ``cls_*`` and
``obj_*`` have identical shapes, so the decoder (``postprocessors/yunet.py``)
matches by name only and refuses a model that does not carry them.
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

SRC_URL = (
    "https://huggingface.co/opencv/face_detection_yunet/resolve/main/"
    "face_detection_yunet_2023mar.onnx"
)
SRC_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
SRC_BYTES = 232_589
NAME = "camstack-yunet-2023mar"
IMGSZ = 640
INPUT_NAME = "image"
OUTPUT_NAMES = [f"{kind}_{s}" for kind in ("cls", "obj", "bbox", "kps") for s in (8, 16, 32)]

# Raw-tensor agreement gates against the fp32 ONNX. OpenVINO fp32 is exact to
# float noise. CoreML computes in fp16: probabilities move ~1e-3 and the
# stride-unit offsets ~1e-2, i.e. well under a pixel after `* stride`.
BAKE_MAX_ABS = 1e-4
OV_MAX_ABS = 1e-3
COREML_MAX_ABS = 0.1

MODEL_CARD = """\
---
license: mit
library_name: onnx
tags:
  - face-detection
  - yunet
  - camstack
---

# YuNet 2023mar — CamStack build

Face detector with 5 landmarks, re-packaged for the CamStack inference pool.
Selectable on the `face-detection` step as `yunet-2023mar`.

| Format | File | Precision |
| --- | --- | --- |
| ONNX | `onnx/camstack-yunet-2023mar.onnx` | fp32 |
| OpenVINO IR | `openvino/camstack-yunet-2023mar.{xml,bin}` | fp32 |
| CoreML | `coreml/camstack-yunet-2023mar.mlpackage` | fp16 |
| TFLite (Coral Edge TPU) | `tflite/camstack-yunet-2023mar_edgetpu.tflite` | int8 |
| TFLite (CPU, the Edge TPU file's source) | `tflite/camstack-yunet-2023mar_int8.tflite` | int8 |

## Source

- Model: `face_detection_yunet_2023mar.onnx` from OpenCV Zoo,
  <https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet>
  (mirrored at <https://huggingface.co/opencv/face_detection_yunet>),
  sha256 `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`.
- Training code: <https://github.com/ShiqiYu/libfacedetection.train> (BSD-3-Clause).
- Paper: Wu, Peng, Yu, "YuNet: A Tiny Millisecond-level Face Detector",
  Machine Intelligence Research, 2023.

## Modifications

The only change to the upstream graph is a two-node prefix that adapts the
input contract: the input `image` takes **RGB float in [0,1]** (NCHW,
1×3×640×640); `Mul(255)` then `Gather([2,1,0], axis=1)` turn it into the
**BGR 0..255** tensor the upstream graph expects. Outputs are unchanged and
named `cls_{8,16,32}`, `obj_{8,16,32}`, `bbox_{8,16,32}`, `kps_{8,16,32}`.
The OpenVINO and CoreML files are converted from that patched ONNX. Built by
`scripts/build-yunet-model.py` in the CamStack repository.

The TFLite files are built by `scripts/build-yunet-edgetpu.py` from the patched
ONNX: the two-node prefix is folded into the first convolution (the same
function — the Edge TPU has no Gather), the graph is quantised to full integer
(int8, per-channel weights; input uint8 with scale 1/255, so raw RGB bytes are
the [0,1] tensor) on CamStack person crops, and the Edge TPU file is that graph
compiled with `edgetpu_compiler` 14.1. Output names are unchanged.

## Training data

YuNet was trained on **WIDER FACE** (<http://shuoyang1213.me/WIDERFACE/>),
whose images are distributed under a **Creative Commons BY-NC-ND** licence.
The model weights are released by their authors under MIT (below). Whether a
dataset's non-commercial terms extend to a model trained on it is not settled;
this caveat applies to essentially every public face detector trained on WIDER
FACE, and is stated here so it is not lost.

## Licence

The model weights are MIT-licensed:

```
MIT License

Copyright (c) 2020 Shiqi Yu <shiqi.yu@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
"""


def _download(dest: Path) -> Path:
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"→ downloading {SRC_URL}")
        urllib.request.urlretrieve(SRC_URL, dest)
    digest = sha256(dest.read_bytes()).hexdigest()
    if digest != SRC_SHA256:
        raise SystemExit(f"yunet sha256 {digest} != expected {SRC_SHA256}")
    if dest.stat().st_size != SRC_BYTES:
        raise SystemExit(f"yunet is {dest.stat().st_size} B, expected {SRC_BYTES}")
    print(f"  ✓ sha256 {digest}")
    return dest


def _bake_input_contract(src: Path, dst: Path) -> None:
    """Prepend ``Mul(255) → Gather([2,1,0], axis=1)`` and rename the input."""
    import numpy as np
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    model = onnx.load(str(src))
    graph = model.graph
    upstream_input = graph.input[0].name  # "input": BGR 0..255, fed to the first Conv

    graph.initializer.extend([
        numpy_helper.from_array(np.array(255.0, dtype=np.float32), "camstack_scale_255"),
        numpy_helper.from_array(np.array([2, 1, 0], dtype=np.int64), "camstack_rgb_to_bgr"),
    ])
    graph.node.insert(
        0,
        helper.make_node("Gather", ["camstack_scaled", "camstack_rgb_to_bgr"], [upstream_input],
                         name="camstack_rgb_to_bgr", axis=1),
    )
    graph.node.insert(
        0,
        helper.make_node("Mul", [INPUT_NAME, "camstack_scale_255"], ["camstack_scaled"],
                         name="camstack_scale_255"),
    )
    graph.input.remove(graph.input[0])
    graph.input.insert(
        0, helper.make_tensor_value_info(INPUT_NAME, TensorProto.FLOAT, [1, 3, IMGSZ, IMGSZ])
    )
    if [o.name for o in graph.output] != OUTPUT_NAMES:
        raise SystemExit(f"unexpected upstream outputs {[o.name for o in graph.output]}")

    model.producer_name = "camstack"
    model.doc_string = (
        "YuNet 2023mar (OpenCV Zoo, MIT, (c) 2020 Shiqi Yu). "
        "Input `image`: RGB NCHW float in [0,1] (the CamStack pool's /255 tensor); "
        "the upstream BGR 0..255 contract is baked in as Mul(255)+Gather([2,1,0]). "
        "Outputs cls/obj/bbox/kps at strides 8/16/32."
    )
    onnx.checker.check_model(model)
    dst.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(dst))
    print(f"  ✓ {dst.name} ({dst.stat().st_size / 1e3:.0f} KB)")


# --- stages, each in its own interpreter -------------------------------------
# Same reason as build-auraface-model.py: openvino, onnxruntime and the
# protobuf/absl stack coremltools pulls in deadlock this Mac inside abseil when
# loaded into ONE process, silently, looking exactly like a slow conversion.


def _run_stage(name: str, *args: str) -> None:
    run = subprocess.run([sys.executable, __file__, "--stage", name, *args])
    if run.returncode != 0:
        raise SystemExit(f"stage {name} failed (exit {run.returncode})")


def _stage_openvino(onnx_path: Path, xml: Path) -> None:
    """ONNX → OpenVINO IR (fp32) whose outputs keep their public names on EVERY device.

    The pool keys a result by `get_any_name()` of the COMPILED port. The CPU
    plugin fuses each `Reshape → Sigmoid` tail under f32 inference precision
    (the x86 default) and the fused port then carries both the internal name
    and the public one — `{'291', 'cls_8'}` — and `get_any_name()` returns
    `291`. Under the ARM default f16 it returns `cls_8`. The decoder matches by
    name, so an Intel node would have raised "output 'cls_8' missing" on every
    frame while a Mac looked fine. Internal tensor names are never read by
    anything, so they are cleared: a fused port can then only carry the public
    name. Checked below under both precisions."""
    import openvino as ov
    from convert_lib import validate_openvino_ir

    model = ov.convert_model(str(onnx_path))
    public = set(OUTPUT_NAMES) | {INPUT_NAME}
    for op in model.get_ordered_ops():
        for port in op.outputs():
            if not (set(port.get_names()) & public):
                port.get_tensor().set_names(set())
    xml.parent.mkdir(parents=True, exist_ok=True)
    ov.save_model(model, str(xml), compress_to_fp16=False)
    validate_openvino_ir(str(xml))

    core = ov.Core()
    for hint in ("f32", "f16"):
        compiled = core.compile_model(str(xml), "CPU", {"INFERENCE_PRECISION_HINT": hint})
        names = [p.get_any_name() for p in compiled.outputs]
        if sorted(names) != sorted(OUTPUT_NAMES):
            raise SystemExit(f"OpenVINO outputs under {hint} are named {names}, not {OUTPUT_NAMES}")
    print(f"  ✓ {xml.name} + .bin ({xml.with_suffix('.bin').stat().st_size / 1e3:.0f} KB)")


def _stage_coreml(onnx_path: Path, pkg: Path) -> None:
    """onnx2torch → trace → coremltools, with the outputs NAMED.

    Not `convert_lib.export_coreml_from_onnx`: that names outputs `var_*`, and
    YuNet's `cls_*` / `obj_*` cannot be told apart by shape. No onnxsim either —
    the graph is already static (1×3×640×640)."""
    import coremltools as ct
    import onnx
    import torch
    from onnx2torch import convert as onnx_to_torch

    module = onnx_to_torch(onnx.load(str(onnx_path))).eval()
    example = torch.rand(1, 3, IMGSZ, IMGSZ)
    with torch.no_grad():
        traced = torch.jit.trace(module, example, strict=False)
    mlmodel = ct.convert(
        traced,
        source="pytorch",
        inputs=[ct.TensorType(name=INPUT_NAME, shape=example.shape)],
        outputs=[ct.TensorType(name=n) for n in OUTPUT_NAMES],
        convert_to="mlprogram",
        minimum_deployment_target=ct.target.iOS16,
    )
    mlmodel.short_description = "YuNet 2023mar face detector (MIT, (c) 2020 Shiqi Yu), CamStack build"
    mlmodel.license = "MIT"
    pkg.parent.mkdir(parents=True, exist_ok=True)
    mlmodel.save(str(pkg))
    loaded = ct.models.MLModel(str(pkg))
    names = [o.name for o in loaded.get_spec().description.output]
    if sorted(names) != sorted(OUTPUT_NAMES):
        raise SystemExit(f"CoreML output names {names} != {OUTPUT_NAMES}")
    size = sum(f.stat().st_size for f in pkg.rglob("*") if f.is_file())
    print(f"  ✓ {pkg.name} ({size / 1e3:.0f} KB)")


def _inputs():
    """Two synthetic [0,1] RGB frames: noise, and a smooth pattern. A face-free
    input still exercises every weight — the gate compares raw tensors."""
    import numpy as np

    rng = np.random.default_rng(1234)
    yy, xx = np.mgrid[0:IMGSZ, 0:IMGSZ].astype(np.float32) / (IMGSZ - 1)
    pattern = np.stack([
        np.exp(-(((xx - 0.5) ** 2 + (yy - 0.4) ** 2) / 0.05)),
        0.5 + 0.5 * np.sin(9 * xx) * np.cos(7 * yy),
        (xx + yy) / 2,
    ]).astype(np.float32)
    return np.stack([rng.random((3, IMGSZ, IMGSZ), dtype=np.float32), np.clip(pattern, 0, 1)])


def _run_engine(engine: str, base: Path, upstream: Path, tmp: Path) -> None:
    import numpy as np

    xs = _inputs()
    if engine == "onnx":
        import onnxruntime as ort

        sess = ort.InferenceSession(str(base / f"onnx/{NAME}.onnx"),
                                    providers=["CPUExecutionProvider"])
        names = [o.name for o in sess.get_outputs()]
        for i, x in enumerate(xs):
            np.savez(tmp / f"onnx-{i}.npz", **dict(zip(names, sess.run(None, {INPUT_NAME: x[None]}))))
        up = ort.InferenceSession(str(upstream), providers=["CPUExecutionProvider"])
        up_names = [o.name for o in up.get_outputs()]
        for i, x in enumerate(xs):
            bgr255 = (x[::-1] * 255.0)[None].astype(np.float32)
            np.savez(tmp / f"upstream-{i}.npz", **dict(zip(up_names, up.run(None, {"input": bgr255}))))
    elif engine == "openvino":
        import openvino as ov

        # f32 execution: this gate checks the CONVERSION. The ARM CPU plugin
        # otherwise defaults to f16 inference precision (max|Δ| ~7e-2 here,
        # the same order as CoreML fp16), which is a runtime choice, not the IR.
        compiled = ov.Core().compile_model(str(base / f"openvino/{NAME}.xml"), "CPU",
                                           {"INFERENCE_PRECISION_HINT": "f32"})
        for i, x in enumerate(xs):
            res = compiled(x[None])
            np.savez(tmp / f"openvino-{i}.npz",
                     **{p.get_any_name(): np.array(res[p]) for p in compiled.outputs})
    elif engine == "coreml":
        import coremltools as ct

        ml = ct.models.MLModel(str(base / f"coreml/{NAME}.mlpackage"))
        for i, x in enumerate(xs):
            pred = ml.predict({INPUT_NAME: x[None]})
            np.savez(tmp / f"coreml-{i}.npz", **{k: np.array(v) for k, v in pred.items()})


def _verify(base: Path, upstream: Path, tmp: Path, want_coreml: bool) -> None:
    import numpy as np

    tmp.mkdir(parents=True, exist_ok=True)
    engines = ["onnx", "openvino"] + (["coreml"] if want_coreml else [])
    for engine in engines:
        _run_stage(f"run-{engine}", str(base), str(upstream), str(tmp))

    def max_abs(a: str, b: str) -> float:
        worst = 0.0
        for i in range(len(_inputs())):
            ta, tb = np.load(tmp / f"{a}-{i}.npz"), np.load(tmp / f"{b}-{i}.npz")
            missing = set(OUTPUT_NAMES) - set(tb.files)
            if missing:
                raise SystemExit(f"{b} is missing outputs {sorted(missing)}")
            for n in OUTPUT_NAMES:
                worst = max(worst, float(np.max(np.abs(ta[n].reshape(-1) - tb[n].reshape(-1)))))
        return worst

    checks = [("baked ONNX vs upstream(BGR*255)", "upstream", "onnx", BAKE_MAX_ABS),
              ("ONNX fp32 vs OpenVINO fp32", "onnx", "openvino", OV_MAX_ABS)]
    if want_coreml:
        checks.append(("ONNX fp32 vs CoreML fp16", "onnx", "coreml", COREML_MAX_ABS))
    failures = []
    for label, a, b, bound in checks:
        d = max_abs(a, b)
        print(f"  {label:34s} max|Δ| = {d:.2e}  (gate {bound:g})")
        if d > bound:
            failures.append(f"{label}: {d:.3e} > {bound:g}")
    if failures:
        raise SystemExit("  ✗ " + "\n  ✗ ".join(failures))
    print("  ✓ all engines agree")


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)  # keep order with the stage subprocesses
    if len(sys.argv) > 2 and sys.argv[1] == "--stage":
        stage, rest = sys.argv[2], [Path(a) for a in sys.argv[3:]]
        if stage.startswith("run-"):
            _run_engine(stage.removeprefix("run-"), *rest)
        elif stage == "openvino":
            _stage_openvino(*rest)
        elif stage == "coreml":
            _stage_coreml(*rest)
        else:
            raise SystemExit(f"unknown stage {stage}")
        return

    work = Path(sys.argv[1] if len(sys.argv) > 1 else "yunet-build").resolve()
    base = work / "stage" / "faceDetection" / "yunet"
    upstream = _download(work / "src" / "face_detection_yunet_2023mar.onnx")

    print("→ baking the RGB/255 → BGR 0..255 input contract into the ONNX")
    onnx_path = base / "onnx" / f"{NAME}.onnx"
    _bake_input_contract(upstream, onnx_path)

    print("→ OpenVINO IR (fp32)")
    _run_stage("openvino", str(onnx_path), str(base / "openvino" / f"{NAME}.xml"))

    want_coreml = sys.platform == "darwin"
    if want_coreml:
        print("→ CoreML mlpackage (onnx2torch → trace → coremltools, named outputs)")
        _run_stage("coreml", str(onnx_path), str(base / "coreml" / f"{NAME}.mlpackage"))
    else:
        print("⊘ CoreML skipped — darwin only")

    (base / "README.md").write_text(MODEL_CARD)
    print("  ✓ README.md (model card: MIT text, source, WIDER FACE note)")

    if "--skip-verify" not in sys.argv:
        print("→ cross-engine verification")
        _verify(base, upstream, work / "verify-tmp", want_coreml)

    print(f"\nReady to publish: {base}")
    print(f"  hf upload camstack/camstack-models {base} faceDetection/yunet")


if __name__ == "__main__":
    main()
