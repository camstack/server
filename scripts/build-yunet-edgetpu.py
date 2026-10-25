#!/usr/bin/env python3
"""Build the Coral (Edge TPU) format of the ``yunet-2023mar`` face detector (D710).

    python3 scripts/build-yunet-edgetpu.py --work <dir> --frames <dir> \
        --tf-python <python with tensorflow+onnx2tf> [--python <python with onnxruntime+ai-edge-litert>] \
        [--compiler docker|lima:<instance>]

produces, under ``<work>/stage/faceDetection/yunet/tflite/``:

    camstack-yunet-2023mar_int8.tflite      full-integer CPU graph (the compiler's input;
                                            what every co-compiled set is built from)
    camstack-yunet-2023mar_edgetpu.tflite   the same graph, Edge TPU compiled alone

plus the evidence D710 asks for in ``<work>/report.json`` (op mapping, on-chip
memory alone and co-compiled with the root SSD, parity) and the fixture
``packages/addon-pipeline/python/postprocessors/testdata/yunet_int8_outputs.json``.
Upload with ``hf upload camstack/camstack-models <work>/stage/faceDetection/yunet
faceDetection/yunet``.

SOURCE
------
The published ``camstack-yunet-2023mar.onnx`` (built by build-yunet-model.py,
pinned by sha256 below). Its input contract is baked in: RGB float [0,1] NCHW
in, ``Mul(255)`` + ``Gather([2,1,0])`` to the upstream BGR 0..255 (D645).

THE GRAPH EDIT
--------------
A Gather is not an Edge TPU op, and the compiler maps nothing after the first
op it cannot map. The bake is therefore FOLDED into the first Conv —
``W'[:, bgr[c]] += 255 * W[:, c]`` — which is the same function (the verify
stage proves it: max |diff| ~1e-5 on random input). The contract does not
change: the int8 graph's input is uint8 with scale 1/255 and zero point 0, so
the raw pixel bytes the edgetpu preprocess feeds ARE the RGB [0,1] tensor, and
the entry still declares no ``inputNormalization``.

The outputs keep their names (``cls_8`` … ``kps_32``): ``postprocessors/yunet.py``
matches by name only, and the edgetpu predict closure keys a name-matching
postprocessor's outputs by tensor name (``edgetpu_output_keys``).

QUANTISATION
------------
Full-integer post-training quantisation (onnx2tf → TFLiteConverter,
per-channel weights, uint8 input, int8 outputs) calibrated on every third
frame of ``--frames``; the other two thirds are the parity set. The frames are
the operator's: padded person crops (+15% of the box, the detail plane's
convention), as the face step sees them. They are NOT kept or published — the
int8 CPU graph is, so a recompile or a co-compiled set starts from that file
and never needs them again.

640 is the only admitted size: at 480 recall falls to ~0.82 of the reference
and at 320 to ~0.50, and the loss is resolution, not quantisation (the fp32
graph at 320 loses the same faces).

GATES (exit 1 on a miss), at the step gate (the model's ``defaultConfidence``
0.85) against the ONNX reference fed the same letterboxed frame:

- the emitted face set is identical on >= 95% of the parity crops;
- every face only one side emits has the other side's score for the same box
  within 0.05 of the gate (a straddle, not a different detection);
- landmarks (face-align depends on them): mean point error <= 2% of the face
  box diagonal.

STAGES, each in its own interpreter: onnxruntime, LiteRT and TensorFlow are
never loaded into one process (mixing ML runtimes deadlocks or crashes on this
Mac). The parent imports onnx, numpy and Pillow only.
"""
from __future__ import annotations

import argparse
import base64
import json
import shutil
import subprocess
import sys
import zlib
from hashlib import sha256
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import edgetpu_toolchain as tc  # noqa: E402

_REPO = Path(__file__).resolve().parents[1]
_PY = _REPO / "packages" / "addon-pipeline" / "python"
_FIXTURE = _PY / "postprocessors" / "testdata" / "yunet_int8_outputs.json"
_FIXTURE_IMAGE = _REPO / "packages" / "addon-pipeline" / "assets" / "reference-images" / "3-persons.jpg"

_HF = "https://huggingface.co/camstack/camstack-models/resolve/main/faceDetection/yunet"
SRC_ONNX = (f"{_HF}/onnx/camstack-yunet-2023mar.onnx", "camstack-yunet-2023mar.onnx",
            "55df63fd5a5128903ee2b6dd4315aa82979be9a1d6cf83cc154b74cd4bd2c42f", 233_080)

FOLDER = "faceDetection/yunet"
NAME = "camstack-yunet-2023mar"
SIZE = 640
OUTPUTS = [f"{k}_{s}" for k in ("cls", "obj", "bbox", "kps") for s in (8, 16, 32)]
STEP_GATE = 0.85  # model-catalogs.ts yunet-2023mar.defaultConfidence (D662)
LOW_FLOOR = 0.3  # decode floor: a box just under the gate on one side is still seen
PAD = 0.15
GATE_SET_AGREEMENT = 0.95
GATE_STRADDLE = 0.05
GATE_LANDMARK_DIAG = 0.02
FOLD_MAX_ABS = 1e-4


# ── graph edit (parent: onnx + numpy) ─────────────────────────────────────────

def _fold(src: Path, dst: Path) -> None:
    import numpy as np
    import onnx
    from onnx import numpy_helper as nh

    m = onnx.load(str(src))
    g = m.graph
    mul, gat, conv = list(g.node)[:3]
    if (mul.op_type, gat.op_type, conv.op_type) != ("Mul", "Gather", "Conv"):
        raise SystemExit("unexpected graph head: the published bake (Mul, Gather, Conv) is not first")
    inits = {i.name: i for i in g.initializer}
    scale = float(nh.to_array(inits[mul.input[1]]).reshape(-1)[0])
    bgr = nh.to_array(inits[gat.input[1]]).astype(int).tolist()
    w = nh.to_array(inits[conv.input[1]])
    folded = np.zeros_like(w)
    for c in range(3):
        folded[:, bgr[c]] += w[:, c] * scale
    inits[conv.input[1]].CopyFrom(nh.from_array(folded.astype(np.float32), conv.input[1]))
    conv.input[0] = g.input[0].name
    g.node.remove(mul)
    g.node.remove(gat)
    for name in (mul.input[1], gat.input[1]):
        g.initializer.remove(inits[name])
    onnx.checker.check_model(m)
    onnx.save(m, str(dst))


# ── stages (own interpreter each) ─────────────────────────────────────────────

def _letterbox(path: str, size: int):
    """Byte-for-byte the pool's ``letterbox_image`` (pad 114), uint8 HWC."""
    import numpy as np
    from PIL import Image

    img = Image.open(path).convert("RGB")
    w, h = img.size
    scale = size / max(w, h)
    nw, nh_ = int(w * scale), int(h * scale)
    px, py = (size - nw) // 2, (size - nh_) // 2
    if (w, h) != (size, size):
        canvas = Image.new("RGB", (size, size), (114, 114, 114))
        canvas.paste(img if (w, h) == (nw, nh_) else img.resize((nw, nh_), Image.BILINEAR), (px, py))
        img, pad = canvas, (px, py)
    else:
        scale, pad = 1.0, (0, 0)
    return np.asarray(img, dtype=np.uint8), scale, pad, (w, h)


def _stage_calib(index: Path, out: Path, sample: Path) -> None:
    import numpy as np
    from PIL import Image

    rows = [e for e in json.loads(index.read_text()) if e["split"] == "calib"]
    np.save(out, np.stack([_letterbox(e["path"], SIZE)[0] for e in rows]).astype(np.float32) / 255.0)
    # onnx2tf's own output check wants a 20x128x128x3 sample next to it; give
    # it ours instead of letting it download one.
    np.save(sample, np.stack([np.asarray(Image.open(e["path"]).convert("RGB").resize((128, 128)), np.float32) / 255.0
                              for e in (rows * 20)[:20]]).astype(np.float32))


def _stage_rename(src: Path, dst: Path) -> None:
    """Signature order = ONNX output order; give each output its public name."""
    from tensorflow.lite.tools import flatbuffer_utils as fu

    m = fu.read_model(str(src))
    sg, sig = m.subgraphs[0], m.signatureDefs[0]
    by_key = {(o.name.decode() if isinstance(o.name, bytes) else o.name): o.tensorIndex for o in sig.outputs}
    order = sorted(by_key, key=lambda k: int(k.rsplit("_", 1)[1]))
    if len(order) != len(OUTPUTS):
        raise SystemExit(f"expected {len(OUTPUTS)} outputs, got {order}")
    for key, name in zip(order, OUTPUTS):
        sg.tensors[by_key[key]].name = name.encode()
    sg.tensors[sig.inputs[0].tensorIndex].name = b"image"
    fu.write_model(m, str(dst))


def _decode(pred: dict, w: int, h: int, scale: float, pad, floor: float) -> list:
    sys.path.insert(0, str(_PY))
    from postprocessors.yunet import postprocess_yunet

    cfg = {"confidence": floor, "inputSize": SIZE, "nmsIouThreshold": 0.45}
    return postprocess_yunet(pred, cfg, w, h, scale, pad)["detections"]


def _ort_predictor(model: Path):
    import numpy as np
    import onnxruntime as ort

    s = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
    names = [o.name for o in s.get_outputs()]
    return lambda x: dict(zip(names, s.run(None, {"image": (x.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]})))


def _litert_predictor(model: Path, raw_sink: dict | None = None):
    """The edgetpu predict closure's contract: uint8 in, every output dequantised."""
    import numpy as np
    from ai_edge_litert.interpreter import Interpreter

    sys.path.insert(0, str(_PY))
    from edgetpu_dequant import dequant_edgetpu_output

    it = Interpreter(str(model))
    it.allocate_tensors()
    ind, outs = it.get_input_details()[0], it.get_output_details()

    def pred(x):
        it.set_tensor(ind["index"], x[None])
        it.invoke()
        r = {}
        for d in outs:
            raw = it.get_tensor(d["index"])
            q = d["quantization"]
            if raw_sink is not None:
                raw_sink[d["name"]] = {"shape": [int(v) for v in raw.shape], "dtype": np.dtype(d["dtype"]).name,
                                       "scale": float(q[0]), "zeroPoint": int(q[1]),
                                       "zlibB64": base64.b64encode(zlib.compress(raw.tobytes(), 9)).decode()}
            r[d["name"]] = dequant_edgetpu_output(raw, dtype_name=np.dtype(d["dtype"]).name,
                                                  scale=float(q[0]), zero_point=int(q[1]))
        return r
    return pred


def _stage_run(runtime: str, model: Path, index: Path, out: Path) -> None:
    pred = _ort_predictor(model) if runtime == "ort" else _litert_predictor(model)
    res = {}
    for e in json.loads(index.read_text()):
        if e["split"] != "eval":
            continue
        x, scale, pad, (w, h) = _letterbox(e["path"], SIZE)
        res[e["name"]] = _decode(pred(x), w, h, scale, pad, LOW_FLOOR)
    out.write_text(json.dumps(res))


def _stage_fold_check(published: Path, folded: Path) -> None:
    import numpy as np
    import onnxruntime as ort

    a = ort.InferenceSession(str(published), providers=["CPUExecutionProvider"])
    b = ort.InferenceSession(str(folded), providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(0)
    worst = 0.0
    for _ in range(4):
        x = rng.random((1, 3, SIZE, SIZE), dtype=np.float32)
        worst = max(worst, max(float(np.abs(p - q).max()) for p, q in zip(a.run(None, {"image": x}), b.run(None, {"image": x}))))
    print(f"  fold: max |diff| vs the published graph = {worst:.2e}")
    if worst > FOLD_MAX_ABS:
        raise SystemExit("fold is not exact")


def _stage_fixture(onnx_model: Path, int8_model: Path, out: Path) -> None:
    raw: dict = {}
    x, scale, pad, (w, h) = _letterbox(str(_FIXTURE_IMAGE), SIZE)
    cand = _decode(_litert_predictor(int8_model, raw)(x), w, h, scale, pad, STEP_GATE)
    out.write_text(json.dumps({"frame": {"w": w, "h": h, "scale": scale, "pad": list(pad)}, "outputs": raw,
                               "int8Detections": cand}))


def _stage_fixture_ref(onnx_model: Path, fixture: Path) -> None:
    data = json.loads(fixture.read_text())
    x, scale, pad, (w, h) = _letterbox(str(_FIXTURE_IMAGE), SIZE)
    data["onnxDetections"] = _decode(_ort_predictor(onnx_model)(x), w, h, scale, pad, STEP_GATE)
    fixture.write_text(json.dumps(data))


def _run_stage(python: str, name: str, *args: str) -> None:
    subprocess.run([python, __file__, "--stage", name, *args], check=True)


# ── parity ───────────────────────────────────────────────────────────────────

def _iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _parity(ref: dict, cand: dict) -> dict:
    same_set, matched, n_ref, n_cand, lm, ious, one_sided = 0, 0, 0, 0, [], [], []
    for k in ref:
        r_all, c_all = ref[k], cand[k]
        R = [d for d in r_all if d["score"] >= STEP_GATE]
        C = [d for d in c_all if d["score"] >= STEP_GATE]
        n_ref += len(R)
        n_cand += len(C)
        used: set[int] = set()
        here = 0
        for r in R:
            best = max(((_iou(r["bbox"], c["bbox"]), j) for j, c in enumerate(C) if j not in used), default=(0.0, -1))
            if best[0] >= 0.5:
                used.add(best[1])
                here += 1
                ious.append(best[0])
                c = C[best[1]]
                diag = ((r["bbox"][2] - r["bbox"][0]) ** 2 + (r["bbox"][3] - r["bbox"][1]) ** 2) ** 0.5
                d = [((p["x"] - q["x"]) ** 2 + (p["y"] - q["y"]) ** 2) ** 0.5 for p, q in zip(r["landmarks"], c["landmarks"])]
                lm.append(sum(d) / len(d) / diag)
            else:
                other = max([c["score"] for c in c_all if _iou(r["bbox"], c["bbox"]) >= 0.5], default=0.0)
                one_sided.append({"crop": k, "side": "reference", "score": r["score"], "other": other})
        for j, c in enumerate(C):
            if j not in used:
                other = max([r["score"] for r in r_all if _iou(r["bbox"], c["bbox"]) >= 0.5], default=0.0)
                one_sided.append({"crop": k, "side": "int8", "score": c["score"], "other": other})
        matched += here
        same_set += int(len(R) == len(C) == here)
    lm_sorted = sorted(lm)
    return {
        "crops": len(ref), "reference_faces": n_ref, "int8_faces": n_cand, "matched": matched,
        "recall_of_reference": round(matched / max(1, n_ref), 4),
        "same_emitted_set": same_set, "same_emitted_set_rate": round(same_set / max(1, len(ref)), 4),
        "box_iou_mean": round(sum(ious) / max(1, len(ious)), 4),
        "landmark_err_over_diag_mean": round(sum(lm) / max(1, len(lm)), 4),
        "landmark_err_over_diag_p95": round(lm_sorted[int(0.95 * (len(lm_sorted) - 1))], 4) if lm_sorted else None,
        "one_sided": one_sided,
    }


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--work", type=Path)
    ap.add_argument("--frames", type=Path, action="append", default=[],
                    help="directory of padded person crops (jpg/png): every 3rd calibrates, the rest is the parity set")
    ap.add_argument("--compiler", default="docker", help="docker | lima:<instance>")
    ap.add_argument("--python", default=sys.executable, help="interpreter with onnxruntime + ai-edge-litert + pillow")
    ap.add_argument("--tf-python", help="interpreter with tensorflow + onnx2tf (onnx2tf on PATH next to it)")
    ap.add_argument("--stage", help=argparse.SUPPRESS)
    ap.add_argument("stage_args", nargs="*", help=argparse.SUPPRESS)
    a = ap.parse_args()

    if a.stage:
        fn = {"calib": _stage_calib, "rename": _stage_rename, "run": None, "fold-check": _stage_fold_check,
              "fixture": _stage_fixture, "fixture-ref": _stage_fixture_ref}[a.stage]
        if a.stage == "run":
            _stage_run(a.stage_args[0], *(Path(p) for p in a.stage_args[1:]))
        else:
            fn(*(Path(p) for p in a.stage_args))
        return
    if a.work is None or not a.frames or a.tf_python is None:
        ap.error("--work, --frames and --tf-python are required")

    work = a.work.absolute()  # not resolve(): /tmp/lima must stay /tmp/lima for the VM
    work.mkdir(parents=True, exist_ok=True)
    print("1/6 fetch + fold the bake into the first Conv")
    published = tc.fetch(SRC_ONNX, work)
    folded = work / "yunet-folded.onnx"
    _fold(published, folded)
    _run_stage(a.python, "fold-check", str(published), str(folded))

    print("2/6 frames")
    paths = sorted(str(p) for d in a.frames for p in d.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    index = [{"name": Path(p).stem, "path": p, "split": "calib" if i % 3 == 0 else "eval"} for i, p in enumerate(paths)]
    (work / "frames.json").write_text(json.dumps(index))
    print(f"  {len(index)} frames: {sum(e['split'] == 'calib' for e in index)} calibrate, the rest is the parity set")
    _run_stage(a.python, "calib", str(work / "frames.json"), str(work / "calib.npy"),
               str(work / "calibration_image_sample_data_20x128x128x3_float32.npy"))

    print("3/6 full-integer quantisation (onnx2tf)")
    tf_dir = work / "tf"
    shutil.rmtree(tf_dir, ignore_errors=True)
    onnx2tf = Path(a.tf_python).parent / "onnx2tf"
    subprocess.run([str(onnx2tf), "-i", str(folded), "-o", str(tf_dir), "-oiqt", "-qt", "per-channel",
                    "-cind", "image", str(work / "calib.npy"), "[[[[0,0,0]]]]", "[[[[1,1,1]]]]",
                    "-iqd", "uint8", "-oqd", "int8", "-n"], check=True, cwd=work,
                   stdout=(work / "onnx2tf.log").open("w"), stderr=subprocess.STDOUT)
    int8 = work / f"{NAME}_int8.tflite"
    _run_stage(a.tf_python, "rename", str(tf_dir / "yunet-folded_full_integer_quant.tflite"), str(int8))

    print("4/6 compile: alone, and co-compiled after the root SSD")
    ssd = tc.fetch(tc.SRC_SSD_QUANT, work)
    tc.compile_jobs(a.compiler, work, [int8, ssd],
                    [("compiled", [int8.name]), ("cocompiled", [ssd.name, int8.name])])
    alone = tc.parse_compiler_output((work / "compiled" / "compiler.txt").read_text())
    co = tc.parse_compiler_output((work / "cocompiled" / "compiler.txt").read_text())
    for label, rows in (("alone", alone), ("SSD + YuNet", co)):
        for r in rows:
            print(f"  {label:12s} {r['model']:40s} ops {r['ops_tpu']}/{r['ops_total']} on TPU, "
                  f"on-chip {tc.mib(r['on_chip_bytes'])}, streamed {tc.mib(r['streamed_bytes'])}")
    if alone[0]["ops_cpu"] != 0:
        raise SystemExit("not every op maps to the Edge TPU")

    print("5/6 parity at the step gate")
    _run_stage(a.python, "run", "ort", str(published), str(work / "frames.json"), str(work / "ref.json"))
    _run_stage(a.python, "run", "litert", str(int8), str(work / "frames.json"), str(work / "int8.json"))
    parity = _parity(json.loads((work / "ref.json").read_text()), json.loads((work / "int8.json").read_text()))
    print(json.dumps({k: v for k, v in parity.items() if k != "one_sided"}, indent=1))
    for row in parity["one_sided"]:
        print(f"  one-sided {row}")
    straddles = all(abs(r["other"] - STEP_GATE) <= GATE_STRADDLE for r in parity["one_sided"])
    if (parity["same_emitted_set_rate"] < GATE_SET_AGREEMENT or not straddles
            or parity["landmark_err_over_diag_mean"] > GATE_LANDMARK_DIAG):
        raise SystemExit("parity gate FAILED")

    print("6/6 fixture + stage")
    _run_stage(a.python, "fixture", str(published), str(int8), str(_FIXTURE))
    _run_stage(a.python, "fixture-ref", str(published), str(_FIXTURE))
    fx = json.loads(_FIXTURE.read_text())
    fx["producedBy"] = ("scripts/build-yunet-edgetpu.py: raw outputs of the int8 graph the Edge TPU file is compiled "
                        "from, on reference-images/3-persons.jpg letterboxed to 640; onnxDetections = the ONNX "
                        "reference at the step gate")
    _FIXTURE.write_text(json.dumps(fx))
    dest = work / "stage" / FOLDER / "tflite"
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(int8, dest / int8.name)
    shutil.copyfile(work / "compiled" / f"{int8.stem}_edgetpu.tflite", dest / f"{NAME}_edgetpu.tflite")
    files = {p.name: {"bytes": p.stat().st_size, "sha256": sha256(p.read_bytes()).hexdigest()} for p in dest.iterdir()}
    (work / "report.json").write_text(json.dumps({"files": files, "alone": alone, "cocompiled_after_ssd": co,
                                                  "parity": parity}, indent=1))
    for name, meta in files.items():
        print(f"  {dest / name}  {meta['bytes']} bytes  sha256 {meta['sha256']}")
    print(f"  hf upload camstack/camstack-models {work / 'stage' / FOLDER} {FOLDER}")


if __name__ == "__main__":
    main()
