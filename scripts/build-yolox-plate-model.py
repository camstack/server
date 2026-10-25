#!/usr/bin/env python3
"""Build the `yolox-tiny-plate` catalog artefacts from open-lpr's YOLOX-tiny plate detector.

    python3 scripts/build-yolox-plate-model.py <work-dir> [--skip-verify]
    hf upload camstack/camstack-models <work-dir>/stage/plateDetection/yolox-tiny-plate \
        plateDetection/yolox-tiny-plate

Produces, under ``<work-dir>/stage/plateDetection/yolox-tiny-plate``, the three
formats the catalog entry points at, plus the model card and the upstream
licence files:

    onnx/camstack-yolox-tiny-plate.onnx             (fp32, ~19 MB)
    openvino/camstack-yolox-tiny-plate.{xml,bin}    (fp16 weights, ~10 MB)
    coreml/camstack-yolox-tiny-plate.mlpackage      (fp16, ~10 MB)
    README.md                                       (model card)
    SOURCE.md                                       (pinned upstream + how to rebuild)
    LICENSE, NOTICE                                 (upstream, verbatim)

The TFLite / Coral build is NOT made here: ``build-yolox-plate-edgetpu.py``
builds it from this script's ONNX (Focus rewritten as a 6x6/s2 Conv, the raw
head kept; D710 addendum). Its card rows live in MODEL_CARD below.

SOURCE
------
``plate_yolox_tiny_640.onnx`` of https://huggingface.co/faisalthaheem/open-lpr-models,
tag ``detector-2026.10.1`` = commit ``aed0df35…`` (the URL below pins the commit,
as the upstream CHANGELOG asks: a tag can move). Trained by the open-lpr project
from Megvii's COCO ``yolox_tiny.pth``; Apache-2.0 (LICENSE + NOTICE, both copied
verbatim into the folder: Apache-2.0 §4(d) requires the NOTICE to travel).

THE GRAPH EDIT — do not drop it
-------------------------------
Upstream takes a dynamic ``images`` tensor in **BGR, 0..255** (YOLOX's cv2
training loader) and returns ``output [1, 8400, 6]`` = ``cx, cy, w, h`` (input
pixels), ``obj``, ``cls``. The CamStack pool feeds every letterbox detector
**RGB float /255, NCHW** and the shipped ``yolo`` postprocessor decodes the
YOLOv8 layout ``[1, 4 + classes, N]``. The edit makes the model speak that
contract, so no pool or postprocessor code changes:

    images [1,3,640,640] RGB 0..1
      → Mul(255) → Gather([2,1,0], axis=1)      (= upstream BGR 0..255)
      → upstream graph
      → Slice box / obj / cls → obj*cls → Concat → Transpose
    output0 [1,5,8400] = cx, cy, w, h, obj*cls

The input is static (the catalog declares 640x640), and all three formats are
derived from that one edited ONNX, so the contract is applied exactly once on
every backend and the catalog entry declares no ``inputNormalization``. The
verify pass proves the edit exact against upstream fed ``BGR*255``, and the
three runtimes equal to each other on the decoded detections at the step's
confidence floor (0.5), on a public plate image (open-lpr's own
``blackbox/jeep.jpg``, pinned) and three variants of it.

STAGES, each in its own interpreter
-----------------------------------
openvino, onnxruntime and the protobuf/absl stack coremltools (and tensorflow)
pull in deadlock this Mac inside abseil when loaded into ONE process, silently,
looking exactly like a slow conversion (same as build-yunet-model.py). The
parent imports only ``onnx`` and numpy.
"""
from __future__ import annotations

import subprocess
import sys
import urllib.request
from hashlib import sha256
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
_CONVERT_LIB_DIR = _REPO / "packages" / "addon-model-studio" / "python"
_POSTPROCESSOR_DIR = _REPO / "packages" / "addon-pipeline" / "python"
sys.path.insert(0, str(_CONVERT_LIB_DIR))

UPSTREAM_COMMIT = "aed0df35ec2891c5a90437041ebeadb592cc516b"  # tag detector-2026.10.1
UPSTREAM_REPO = "https://huggingface.co/faisalthaheem/open-lpr-models"
_RESOLVE = f"{UPSTREAM_REPO}/resolve/{UPSTREAM_COMMIT}"

# (file name upstream, sha256, bytes). The ONNX hash equals manifest.json's.
SRC_ONNX = ("plate_yolox_tiny_640.onnx",
            "e5350bb2152eb44fa129b2438d1e39bbbf3c27accfe51cd893ce6e17d028d0b9", 20_183_226)
SRC_LICENSE = ("LICENSE", "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4", 11_357)
SRC_NOTICE = ("NOTICE", "8fe7b8450e295ba3a1aae6359cee0cbe69142d2a8b8a395b4ddfb28ad8154fd2", 2_127)

# open-lpr's own public test image (Apache-2.0 repository), used only by the
# verify pass so the detection check is not vacuous.
TEST_IMAGE_URL = ("https://raw.githubusercontent.com/faisalthaheem/open-lpr/"
                  "faa9540c5cf51dec5e63c6748830d168a844d55b/blackbox/jeep.jpg")
TEST_IMAGE = ("jeep.jpg", "40780444dd9eb88175e4697b9e3239f2d6dd59968b19ee4d0fca23255295d483", 120_044)

FOLDER = "plateDetection/yolox-tiny-plate"
NAME = "camstack-yolox-tiny-plate"
IMGSZ = 640
INPUT_NAME = "images"
OUTPUT_NAME = "output0"
NUM_ANCHORS = 8400

# Gates. The edit is exact float math (one Mul, one Gather, a few Slices).
# Raw-score agreement across runtimes: fp16 weights move a probability by
# ~1e-2 at most. Decoded detections at the step floor: same count, each paired
# box IoU >= 0.9 and score within 0.05 of the ORT reference.
EDIT_MAX_ABS_SCORE = 1e-4
EDIT_MAX_ABS_BOX = 1e-2
RUNTIME_MAX_ABS_SCORE = 0.05
DETECTION_CONFIDENCE = 0.5
DETECTION_MIN_IOU = 0.9
DETECTION_MAX_SCORE_DELTA = 0.05

MODEL_CARD = f"""\
---
license: apache-2.0
library_name: onnx
tags:
  - object-detection
  - license-plate-detection
  - yolox
  - camstack
---

# YOLOX-tiny licence-plate detector — CamStack build

Single-class (`plate`) detector, re-packaged for the CamStack inference pool.
The `plate-detection` step's only model, catalog id `yolox-tiny-plate`.

| Format | File | Precision |
| --- | --- | --- |
| ONNX | `onnx/{NAME}.onnx` | fp32 |
| OpenVINO IR | `openvino/{NAME}.{{xml,bin}}` | fp16 weights |
| CoreML | `coreml/{NAME}.mlpackage` | fp16 |
| TFLite (Coral Edge TPU) | `tflite/{NAME}_edgetpu.tflite` | int8 |
| TFLite (CPU, the Edge TPU file's source) | `tflite/{NAME}_int8.tflite` | int8 |

## Source

- Model: `plate_yolox_tiny_640.onnx` from
  [faisalthaheem/open-lpr-models]({UPSTREAM_REPO}), tag `detector-2026.10.1`
  (commit `{UPSTREAM_COMMIT}`), sha256 `{SRC_ONNX[1]}`.
- Application: [open-lpr](https://github.com/faisalthaheem/open-lpr) (Apache-2.0).
- Architecture: [YOLOX](https://github.com/Megvii-BaseDetection/YOLOX)
  (Megvii, Apache-2.0); pretrained from COCO `yolox_tiny.pth`, then fine-tuned
  by the open-lpr project. The weights' Apache-2.0 status rests on the open-lpr
  repository licence and its NOTICE, which state that YOLOX code and its
  same-repository release weights are Apache-2.0 and that no Ultralytics
  weights were used.

## Modifications

The input and output contract is adapted in the graph; the upstream weights are
untouched. The input `{INPUT_NAME}` takes **RGB float in [0,1]** (NCHW,
1x3x{IMGSZ}x{IMGSZ}); `Mul(255)` then `Gather([2,1,0], axis=1)` give the upstream
graph its BGR 0..255 tensor. The upstream output `[1, 8400, 6]`
(cx, cy, w, h, obj, cls) is reshaped to `{OUTPUT_NAME} [1, 5, 8400]`
(cx, cy, w, h, obj*cls). The OpenVINO and CoreML files are converted from that
edited ONNX. Built by `scripts/build-yolox-plate-model.py` in the CamStack
repository; see `SOURCE.md`.

The TFLite files are built by `scripts/build-yolox-plate-edgetpu.py` from that
edited ONNX: YOLOX's Focus stem (four strided slices and a concat) is rewritten
as the mathematically equivalent 6x6 stride-2 convolution, the input prefix is
folded into it, and the graph ends at the raw head — per stride `s`,
`reg_s` (dx, dy, log w, log h) and `score_s` (obj*cls), which the CamStack
`yolo` postprocessor decodes. It is quantised to full integer (int8,
per-channel weights; input uint8 with scale 1/255) on CamStack vehicle crops,
and the Edge TPU file is that graph compiled with `edgetpu_compiler` 14.1.

## Training data

**Unknown terms.** Per the upstream NOTICE and manifest: an annotated
licence-plate corpus (Simanno) plus community-contributed photographs,
pseudo-labelled by a teacher model. The training imagery is not published; the
upstream NOTICE states the community photographs contain real licence plates,
faces and vehicles and were "uploaded without consent obtained".

## Licence

Apache-2.0. The upstream `LICENSE` and `NOTICE` are reproduced verbatim in this
folder; the NOTICE must accompany any redistribution (Apache-2.0 §4(d)).
"""

SOURCE_NOTE = f"""\
# Source of plateDetection/yolox-tiny-plate

| | |
| --- | --- |
| Upstream repository | {UPSTREAM_REPO} |
| Upstream tag / commit | `detector-2026.10.1` / `{UPSTREAM_COMMIT}` |
| Upstream file | `{SRC_ONNX[0]}`, {SRC_ONNX[2]} bytes, sha256 `{SRC_ONNX[1]}` |
| Upstream LICENSE | sha256 `{SRC_LICENSE[1]}` (copied here verbatim) |
| Upstream NOTICE | sha256 `{SRC_NOTICE[1]}` (copied here verbatim) |
| Weights licence | Apache-2.0 |
| Training data | not published; terms UNKNOWN (see README.md) |

Rebuild every file in this folder from the pinned upstream file:

```
python3 scripts/build-yolox-plate-model.py <work-dir>
```

in the CamStack repository (https://github.com/camstack/server). The script
downloads the upstream ONNX by commit and refuses it if the sha256 differs,
applies the graph edit described in README.md, converts the edited ONNX to
OpenVINO IR (fp16 weights) and CoreML (fp16) with CamStack's `convert_lib.py`,
and checks that the edit is exact and that the three runtimes return the same
detections.
"""


def _fetch(url: str, dest: Path, expect: tuple[str, str, int]) -> Path:
    name, digest_want, size_want = expect
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"→ downloading {url}")
        urllib.request.urlretrieve(url, dest)
    digest = sha256(dest.read_bytes()).hexdigest()
    if digest != digest_want:
        raise SystemExit(f"{name}: sha256 {digest} != expected {digest_want}")
    if dest.stat().st_size != size_want:
        raise SystemExit(f"{name}: {dest.stat().st_size} B, expected {size_want}")
    print(f"  ✓ {name} sha256 {digest[:16]}…")
    return dest


def _edit_graph(src: Path, dst: Path) -> None:
    """Static RGB/255 input in front, the YOLOv8 output layout behind."""
    import numpy as np
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    model = onnx.load(str(src))
    graph = model.graph
    upstream_in = graph.input[0].name  # 'images'
    upstream_out = graph.output[0].name  # 'output'
    if (upstream_in, upstream_out) != ("images", "output"):
        raise SystemExit(f"unexpected upstream I/O {upstream_in!r} -> {upstream_out!r}")

    # The public input keeps upstream's name; the upstream graph reads a new one.
    inner = "camstack_images_bgr255"
    for node in graph.node:
        for i, name in enumerate(node.input):
            if name == upstream_in:
                node.input[i] = inner
    del graph.input[:]
    graph.input.append(
        helper.make_tensor_value_info(INPUT_NAME, TensorProto.FLOAT, [1, 3, IMGSZ, IMGSZ])
    )

    def i64(values: list[int], name: str) -> onnx.TensorProto:
        return numpy_helper.from_array(np.array(values, dtype=np.int64), name)

    graph.initializer.extend([
        numpy_helper.from_array(np.array(255.0, dtype=np.float32), "camstack_scale_255"),
        i64([2, 1, 0], "camstack_rgb_to_bgr"),
        i64([0], "camstack_s0"), i64([4], "camstack_s4"),
        i64([5], "camstack_s5"), i64([6], "camstack_s6"), i64([2], "camstack_axis2"),
    ])
    head = [
        helper.make_node("Mul", [INPUT_NAME, "camstack_scale_255"], ["camstack_scaled"],
                         name="camstack_scale_255"),
        helper.make_node("Gather", ["camstack_scaled", "camstack_rgb_to_bgr"], [inner],
                         axis=1, name="camstack_rgb_to_bgr"),
    ]
    tail = [
        helper.make_node("Slice", [upstream_out, "camstack_s0", "camstack_s4", "camstack_axis2"],
                         ["camstack_box"], name="camstack_box"),
        helper.make_node("Slice", [upstream_out, "camstack_s4", "camstack_s5", "camstack_axis2"],
                         ["camstack_obj"], name="camstack_obj"),
        helper.make_node("Slice", [upstream_out, "camstack_s5", "camstack_s6", "camstack_axis2"],
                         ["camstack_cls"], name="camstack_cls"),
        helper.make_node("Mul", ["camstack_obj", "camstack_cls"], ["camstack_score"],
                         name="camstack_score"),
        helper.make_node("Concat", ["camstack_box", "camstack_score"], ["camstack_cat"],
                         axis=2, name="camstack_cat"),
        helper.make_node("Transpose", ["camstack_cat"], [OUTPUT_NAME], perm=[0, 2, 1],
                         name="camstack_to_v8_layout"),
    ]
    nodes = head + list(graph.node) + tail
    del graph.node[:]
    graph.node.extend(nodes)
    del graph.output[:]
    graph.output.append(
        helper.make_tensor_value_info(OUTPUT_NAME, TensorProto.FLOAT, [1, 5, NUM_ANCHORS])
    )
    del graph.value_info[:]
    model = onnx.shape_inference.infer_shapes(model)
    model.producer_name = "camstack"
    model.doc_string = (
        "YOLOX-tiny licence-plate detector by the open-lpr project (Apache-2.0; "
        f"{UPSTREAM_REPO} @ {UPSTREAM_COMMIT}). Input `images`: RGB NCHW float in [0,1]; "
        "the upstream BGR 0..255 contract is baked in as Mul(255)+Gather([2,1,0]). "
        "Output `output0` [1,5,8400] = cx,cy,w,h (input px), obj*cls."
    )
    onnx.checker.check_model(model)
    dst.parent.mkdir(parents=True, exist_ok=True)
    onnx.save(model, str(dst))
    print(f"  ✓ {dst.name} ({dst.stat().st_size / 1e6:.1f} MB)")


# --- stages, each in its own interpreter -------------------------------------


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
    """convert_lib's onnx2torch → trace → coremltools path, fp16 (the detector default)."""
    from convert_lib import export_coreml_from_onnx, validate_coreml

    export_coreml_from_onnx(str(onnx_path), str(pkg), IMGSZ)
    validate_coreml(str(pkg))
    size = sum(f.stat().st_size for f in pkg.rglob("*") if f.is_file())
    print(f"  ✓ {pkg.name} ({size / 1e6:.1f} MB)")


def _letterbox(img, size: int):
    """Copy of inference_pool.letterbox_image + the pool's /255 NCHW tensor."""
    import numpy as np
    from PIL import Image

    w, h = img.size
    scale = size / max(w, h)
    new_w, new_h = int(w * scale), int(h * scale)
    pad = ((size - new_w) // 2, (size - new_h) // 2)
    canvas = Image.new("RGB", (size, size), (114, 114, 114))
    canvas.paste(img.resize((new_w, new_h), Image.BILINEAR), pad)
    arr = np.asarray(canvas, dtype=np.float32) / 255.0
    return arr.transpose(2, 0, 1)[None].copy(), scale, pad


def _inputs(image: Path):
    """[(label, tensor, orig_w, orig_h, scale, pad)]: the plate image three ways + noise."""
    import numpy as np
    from PIL import Image, ImageOps

    src = Image.open(image).convert("RGB")
    w, h = src.size
    variants = [
        ("jeep", src),
        ("jeep-mirrored", ImageOps.mirror(src)),
        ("jeep-centre-crop", src.crop((w // 6, h // 6, w - w // 6, h - h // 6))),
    ]
    out = []
    for label, img in variants:
        t, scale, pad = _letterbox(img, IMGSZ)
        out.append((label, t, img.size[0], img.size[1], scale, pad))
    rng = np.random.default_rng(1234)
    out.append(("noise", rng.random((1, 3, IMGSZ, IMGSZ), dtype=np.float32), IMGSZ, IMGSZ, 1.0, (0, 0)))
    return out


def _run_engine(engine: str, base: Path, upstream: Path, image: Path, tmp: Path) -> None:
    import numpy as np

    xs = _inputs(image)
    if engine == "onnx":
        import onnxruntime as ort

        sess = ort.InferenceSession(str(base / f"onnx/{NAME}.onnx"), providers=["CPUExecutionProvider"])
        up = ort.InferenceSession(str(upstream), providers=["CPUExecutionProvider"])
        for i, (_, x, *_rest) in enumerate(xs):
            np.save(tmp / f"onnx-{i}.npy", sess.run(None, {INPUT_NAME: x})[0])
            raw = up.run(None, {"images": (x[:, ::-1] * 255.0).astype(np.float32)})[0][0]
            score = raw[:, 4:5] * raw[:, 5:6]
            np.save(tmp / f"upstream-{i}.npy", np.concatenate([raw[:, :4], score], axis=1).T[None])
    elif engine == "openvino":
        import openvino as ov

        compiled = ov.Core().compile_model(str(base / f"openvino/{NAME}.xml"), "CPU")
        for i, (_, x, *_rest) in enumerate(xs):
            np.save(tmp / f"openvino-{i}.npy", np.array(compiled(x)[compiled.outputs[0]]))
    elif engine == "coreml":
        import coremltools as ct

        ml = ct.models.MLModel(str(base / f"coreml/{NAME}.mlpackage"))
        name = ml.get_spec().description.input[0].name
        for i, (_, x, *_rest) in enumerate(xs):
            outs = [np.asarray(v) for v in ml.predict({name: x}).values()]
            np.save(tmp / f"coreml-{i}.npy", next(o for o in outs if o.shape == (1, 5, NUM_ANCHORS)))


def _iou(a: list[float], b: list[float]) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _verify(base: Path, upstream: Path, image: Path, tmp: Path, want_coreml: bool) -> None:
    import numpy as np

    sys.path.insert(0, str(_POSTPROCESSOR_DIR))
    from postprocessors.yolo import postprocess_yolo  # the shipped decoder, numpy only

    tmp.mkdir(parents=True, exist_ok=True)
    engines = ["onnx", "openvino"] + (["coreml"] if want_coreml else [])
    for engine in engines:
        _run_stage(f"run-{engine}", str(base), str(upstream), str(image), str(tmp))

    xs = _inputs(image)
    cfg = {"confidence": DETECTION_CONFIDENCE, "labels": ["plate"], "numClasses": 1,
           "nmsIouThreshold": 0.45}

    def decode(tag: str, i: int) -> list[dict]:
        _, _, w, h, scale, pad = xs[i]
        res = postprocess_yolo({"output": np.load(tmp / f"{tag}-{i}.npy")}, cfg, w, h, scale, pad)
        return sorted(res["detections"], key=lambda d: -d["score"])

    failures: list[str] = []
    real_hits = 0
    for i, (label, *_rest) in enumerate(xs):
        ref = np.load(tmp / f"onnx-{i}.npy")
        up = np.load(tmp / f"upstream-{i}.npy")
        d_box = float(np.max(np.abs(ref[0, :4] - up[0, :4])))
        d_score = float(np.max(np.abs(ref[0, 4] - up[0, 4])))
        print(f"  [{label}] edit vs upstream(BGR*255): max|Δbox| {d_box:.1e}  max|Δscore| {d_score:.1e}")
        if d_box > EDIT_MAX_ABS_BOX or d_score > EDIT_MAX_ABS_SCORE:
            failures.append(f"{label}: the edited ONNX disagrees with upstream")
        ref_dets = decode("onnx", i)
        if label != "noise":
            real_hits += len(ref_dets)
        for engine in engines[1:]:
            got = np.load(tmp / f"{engine}-{i}.npy")
            ds = float(np.max(np.abs(got[0, 4] - ref[0, 4])))
            dets = decode(engine, i)
            pairs = [(_iou(a["bbox"], b["bbox"]), abs(a["score"] - b["score"]))
                     for a, b in zip(ref_dets, dets)]
            worst_iou = min((p[0] for p in pairs), default=1.0)
            worst_ds = max((p[1] for p in pairs), default=0.0)
            print(f"  [{label}] {engine:8s} vs ORT: max|Δscore| {ds:.1e}  dets {len(dets)}/{len(ref_dets)}"
                  f"  min IoU {worst_iou:.3f}  max Δscore@det {worst_ds:.3f}")
            if (ds > RUNTIME_MAX_ABS_SCORE or len(dets) != len(ref_dets)
                    or worst_iou < DETECTION_MIN_IOU or worst_ds > DETECTION_MAX_SCORE_DELTA):
                failures.append(f"{label}: {engine} disagrees with ORT")
    if real_hits == 0:
        failures.append(f"no plate found at confidence {DETECTION_CONFIDENCE} on the test image: "
                        "the detection comparison would be vacuous")
    if failures:
        raise SystemExit("  ✗ " + "\n  ✗ ".join(failures))
    print(f"  ✓ edit exact; {len(engines)} runtimes agree ({real_hits} ORT detections on the plate image)")


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

    work = Path(sys.argv[1] if len(sys.argv) > 1 else "yolox-plate-build").resolve()
    base = work / "stage" / FOLDER
    src = work / "src"
    upstream = _fetch(f"{_RESOLVE}/{SRC_ONNX[0]}", src / SRC_ONNX[0], SRC_ONNX)
    base.mkdir(parents=True, exist_ok=True)
    for spec in (SRC_LICENSE, SRC_NOTICE):
        _fetch(f"{_RESOLVE}/{spec[0]}", src / spec[0], spec)
        (base / spec[0]).write_bytes((src / spec[0]).read_bytes())

    print("→ graph edit: RGB/255 static input, YOLOv8 output layout")
    onnx_path = base / "onnx" / f"{NAME}.onnx"
    _edit_graph(upstream, onnx_path)

    print("→ OpenVINO IR (fp16 weights)")
    _run_stage("openvino", str(onnx_path), str(base / "openvino" / f"{NAME}.xml"))

    want_coreml = sys.platform == "darwin"
    if want_coreml:
        print("→ CoreML mlpackage (fp16)")
        _run_stage("coreml", str(onnx_path), str(base / "coreml" / f"{NAME}.mlpackage"))
    else:
        print("⊘ CoreML skipped — darwin only")

    (base / "README.md").write_text(MODEL_CARD)
    (base / "SOURCE.md").write_text(SOURCE_NOTE)
    print("  ✓ README.md, SOURCE.md, LICENSE, NOTICE")

    if "--skip-verify" not in sys.argv:
        print("→ cross-runtime verification")
        image = _fetch(TEST_IMAGE_URL, src / TEST_IMAGE[0], TEST_IMAGE)
        _verify(base, upstream, image, work / "verify-tmp", want_coreml)

    print(f"\nReady to publish: {base}")
    print(f"  hf upload camstack/camstack-models {base} {FOLDER}")


if __name__ == "__main__":
    main()
