#!/usr/bin/env python3
"""Build the Coral (Edge TPU) format of the ``yolox-tiny-plate`` detector (D710, D719).

    python3 scripts/build-yolox-plate-edgetpu.py --work <dir> --frames <dir> [--labels <json>] \
        --tf-python <python with tensorflow+onnx2tf> [--python <python with onnxruntime+ai-edge-litert>] \
        [--compiler docker|lima:<instance>]

produces, under ``<work>/stage/plateDetection/yolox-tiny-plate/tflite/``:

    camstack-yolox-tiny-plate_int8.tflite      full-integer CPU graph (the compiler's input;
                                               what every co-compiled set is built from)
    camstack-yolox-tiny-plate_edgetpu.tflite   the same graph, Edge TPU compiled alone

plus ``<work>/report.json`` (op mapping, on-chip memory alone and co-compiled
after the root SSD, parity) and the fixture
``packages/addon-pipeline/python/postprocessors/testdata/yolox_plate_int8_outputs.json``.
Upload with ``hf upload camstack/camstack-models <work>/stage/plateDetection/yolox-tiny-plate/tflite
plateDetection/yolox-tiny-plate/tflite`` (the folder's LICENSE and NOTICE are already there).

SOURCE
------
The published ``camstack-yolox-tiny-plate.onnx`` (build-yolox-plate-model.py,
pinned by sha256 below): RGB [0,1] NCHW in, ``Mul(255)`` + ``Gather`` to
upstream BGR 0..255, the YOLOv8 layout out.

THE GRAPH EDIT — why D719's "Focus does not compile" no longer holds
--------------------------------------------------------------------
1. **Focus → one Conv.** YOLOX's stem slices the input into four stride-2
   phases, concatenates them (12 channels) and runs a 3x3/s1 Conv. That is the
   same function as ONE 6x6/s2 Conv with padding 2 on the 3-channel input
   (the YOLOv5 v6 transform): ``W6[o, c, 2a+dy, 2b+dx] = W3[o, 3k+c, a, b]``
   for phase ``k = (dy, dx)`` in the concat order (top-left, bottom-left,
   top-right, bottom-right). The strided Slices were what the compiler refused.
2. **The bake folded into that Conv** (``W[:, bgr[c]] += 255 * W6[:, c]``), as
   for YuNet: a Gather is not an Edge TPU op.
3. **The head is cut before the decode.** Per stride ``s``: ``reg_s``
   (dx, dy, log w, log h; stride units) and ``score_s`` (obj*cls). The decode
   (grid add, ``Exp``) and the coordinate Concat would put pixel coordinates
   and probabilities under ONE int8 scale (~2.5 px and ~2.5 score units per
   step); ``postprocessors/yolo.py`` (``yolox_head_to_v8``) decodes the named
   outputs to the YOLOv8 layout the other builds emit.

The verify stage proves 1–3 exact in fp32 against the published graph
(max |score| and |box| differences printed; the gates are 1e-4 and 1e-2 px).
The int8 graph's input is uint8 scale 1/255, zero point 0: the raw pixel
bytes the edgetpu preprocess feeds ARE the RGB [0,1] tensor.

At 640 every op maps to the Edge TPU (one subgraph), so 416 and 320 were not
needed.

QUANTISATION AND PARITY
-----------------------
Full-integer post-training quantisation, calibrated on every third frame of
``--frames``: vehicle crops (+15% of the vehicle box, the detail plane's
convention) cut from NATIVE keyframes. The rest is the parity set. The frames
contain real plates and are the operator's; they are NOT kept or published —
the int8 CPU graph is.

Gates (exit 1 on a miss), against the published ONNX fp32 at 640, under the
step gate (``defaultConfidence`` 0.5):

- the int8 graph finds >= 95% of the reference's detections (IoU >= 0.5);
- end to end with the plate reader (``cct-s-v2-global``, ``plate-slots``,
  margin 0.05, cut from the crop's native pixels): the int8 boxes give >= 95%
  of the reference's reads; with ``--labels`` ({crop stem: plate}) the
  count is reads equal to the label, otherwise any non-empty read.

STAGES, each in its own interpreter: onnxruntime, LiteRT and TensorFlow are
never loaded into one process. The parent imports onnx, numpy and Pillow only.
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
_FIXTURE = _PY / "postprocessors" / "testdata" / "yolox_plate_int8_outputs.json"
_FIXTURE_IMAGE = _REPO / "packages" / "addon-pipeline" / "assets" / "reference-images" / "1-car-plate.jpg"

_HF = "https://huggingface.co/camstack/camstack-models/resolve/main"
SRC_ONNX = (f"{_HF}/plateDetection/yolox-tiny-plate/onnx/camstack-yolox-tiny-plate.onnx",
            "camstack-yolox-tiny-plate.onnx",
            "f57b5618eafe91bab19bbdcd9af9b0671dbdba30d76a6e0a3a86b0db24bb1ae6", 20_214_465)
SRC_OCR = (f"{_HF}/plateRecognition/cct-s-v2-global/onnx/camstack-cct-s-v2-global.onnx",
           "camstack-cct-s-v2-global.onnx",
           "79c3c00f906857e63453bc16cef6b4a0d34821dff685328eff565fd2da559d21", 5_262_145)

FOLDER = "plateDetection/yolox-tiny-plate"
NAME = "camstack-yolox-tiny-plate"
SIZE = 640
OUTPUTS = ["reg_8", "score_8", "reg_16", "score_16", "reg_32", "score_32"]
STEP_GATE = 0.5  # step-definitions.ts plate-detection.defaultConfidence
OCR_MARGIN = 0.05  # plate-ocr-crop-policy.ts 'plate-slots' (D719)
OCR_MIN_LONG = 70
OCR_CFG = {"minCharProbability": 0.75, "plateRegion": "DE"}  # step-definitions.ts plate-ocr defaults
GATE_DETECTIONS = 0.95
GATE_READS = 0.95
EDIT_MAX_ABS_SCORE = 1e-4
EDIT_MAX_ABS_BOX = 1e-2
_FOCUS_ORDER = ((0, 0), (1, 0), (0, 1), (1, 1))  # (dy, dx) of the Focus concat, in order


# ── graph edit (parent: onnx + numpy) ─────────────────────────────────────────

def _edit(src: Path, dst: Path) -> None:
    import numpy as np
    import onnx
    from onnx import helper, numpy_helper as nh

    m = onnx.load(str(src))
    g = m.graph
    inits = {i.name: i for i in g.initializer}
    by_name = {n.name: n for n in g.node}
    stem = by_name["/backbone/backbone/stem/conv/conv/Conv"]
    w3 = nh.to_array(inits[stem.input[1]])
    w6 = np.zeros((w3.shape[0], 3, 6, 6), np.float32)
    for k, (dy, dx) in enumerate(_FOCUS_ORDER):
        for c in range(3):
            for a in range(3):
                for b in range(3):
                    w6[:, c, 2 * a + dy, 2 * b + dx] = w3[:, 3 * k + c, a, b]
    scale = float(nh.to_array(inits["camstack_scale_255"]).reshape(-1)[0])
    bgr = nh.to_array(inits["camstack_rgb_to_bgr"]).astype(int).tolist()
    folded = np.zeros_like(w6)
    for c in range(3):
        folded[:, bgr[c]] += w6[:, c] * scale
    g.initializer.append(nh.from_array(folded, "camstack_stem6_w"))
    new_stem = helper.make_node("Conv", [g.input[0].name, "camstack_stem6_w", stem.input[2]], [stem.output[0]],
                                name="camstack_stem6", kernel_shape=[6, 6], strides=[2, 2], pads=[2, 2, 2, 2])
    position = list(g.node).index(stem)
    g.node.insert(position, new_stem)
    g.node.remove(stem)
    outputs = []
    for level, s in enumerate((8, 16, 32)):
        concat = by_name["/head/Concat" if level == 0 else f"/head/Concat_{level}"]
        reg, obj, cls = concat.input
        g.node.append(helper.make_node("Mul", [obj, cls], [f"score_{s}"], name=f"camstack_score_{s}"))
        g.node.append(helper.make_node("Identity", [reg], [f"reg_{s}"], name=f"camstack_reg_{s}"))
        outputs += [f"reg_{s}", f"score_{s}"]
    del g.output[:]
    for name in outputs:
        g.output.append(helper.make_tensor_value_info(name, onnx.TensorProto.FLOAT, None))
    needed, keep = set(outputs), []
    for n in reversed(list(g.node)):
        if any(o in needed for o in n.output):
            keep.append(n)
            needed.update(n.input)
    del g.node[:]
    g.node.extend(reversed(keep))
    used = {i for n in g.node for i in n.input}
    for i in [i for i in g.initializer if i.name not in used]:
        g.initializer.remove(i)
    del g.value_info[:]
    m = onnx.shape_inference.infer_shapes(m)
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
    np.save(sample, np.stack([np.asarray(Image.open(e["path"]).convert("RGB").resize((128, 128)), np.float32) / 255.0
                              for e in (rows * 20)[:20]]).astype(np.float32))


def _stage_rename(src: Path, dst: Path) -> None:
    from tensorflow.lite.tools import flatbuffer_utils as fu

    m = fu.read_model(str(src))
    sg, sig = m.subgraphs[0], m.signatureDefs[0]
    by_key = {(o.name.decode() if isinstance(o.name, bytes) else o.name): o.tensorIndex for o in sig.outputs}
    order = sorted(by_key, key=lambda k: int(k.rsplit("_", 1)[1]))
    if len(order) != len(OUTPUTS):
        raise SystemExit(f"expected {len(OUTPUTS)} outputs, got {order}")
    for key, name in zip(order, OUTPUTS):
        sg.tensors[by_key[key]].name = name.encode()
    sg.tensors[sig.inputs[0].tensorIndex].name = b"images"
    fu.write_model(m, str(dst))


def _decode(pred: dict, w: int, h: int, scale: float, pad, floor: float) -> list:
    sys.path.insert(0, str(_PY))
    from postprocessors.yolo import postprocess_yolo

    cfg = {"confidence": floor, "labels": ["plate"], "numClasses": 1, "nmsIouThreshold": 0.45, "inputSize": SIZE}
    return [{"score": d["score"], "bbox": d["bbox"]} for d in postprocess_yolo(pred, cfg, w, h, scale, pad)["detections"]]


def _ort_predictor(model: Path):
    import numpy as np
    import onnxruntime as ort

    s = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
    names = [o.name for o in s.get_outputs()]
    return lambda x: dict(zip(names, s.run(None, {"images": (x.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]})))


def _litert_predictor(model: Path, raw_sink: dict | None = None):
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


def _stage_edit_check(published: Path, edited: Path, index: Path) -> None:
    import numpy as np
    import onnxruntime as ort

    sys.path.insert(0, str(_PY))
    from postprocessors.yolo import yolox_head_to_v8

    a = ort.InferenceSession(str(published), providers=["CPUExecutionProvider"])
    b = ort.InferenceSession(str(edited), providers=["CPUExecutionProvider"])
    names = [o.name for o in b.get_outputs()]
    worst_s = worst_b = 0.0
    for e in json.loads(index.read_text())[:8]:
        x = (_letterbox(e["path"], SIZE)[0].astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
        ref = a.run(None, {"images": x})[0]
        # The ONNX head is NCHW; yolox_head_to_v8 reads the NHWC the TFLite file stores.
        raw = {n: (v.transpose(0, 2, 3, 1) if v.ndim == 4 else v) for n, v in zip(names, b.run(None, {"images": x}))}
        got = yolox_head_to_v8(raw, SIZE)
        worst_s = max(worst_s, float(np.abs(ref[0, 4] - got[0, 4]).max()))
        worst_b = max(worst_b, float(np.abs(ref[0, :4] - got[0, :4]).max()))
    print(f"  edit: max |score| diff {worst_s:.2e}, max |box| diff {worst_b:.2e} px")
    if worst_s > EDIT_MAX_ABS_SCORE or worst_b > EDIT_MAX_ABS_BOX:
        raise SystemExit("graph edit is not exact")


def _stage_run(runtime: str, model: Path, index: Path, out: Path) -> None:
    pred = _ort_predictor(model) if runtime == "ort" else _litert_predictor(model)
    res = {}
    for e in json.loads(index.read_text()):
        if e["split"] != "eval":
            continue
        x, scale, pad, (w, h) = _letterbox(e["path"], SIZE)
        res[e["name"]] = _decode(pred(x), w, h, scale, pad, 0.1)
    out.write_text(json.dumps(res))


def _stage_ocr(ocr_model: Path, index: Path, dets: Path, out: Path) -> None:
    """Top detection >= gate -> +5% cut from the crop's native pixels -> the plate reader."""
    import numpy as np
    import onnxruntime as ort
    from PIL import Image

    sys.path.insert(0, str(_PY))
    from postprocessors.plate_slots import postprocess_plate_slots

    s = ort.InferenceSession(str(ocr_model), providers=["CPUExecutionProvider"])
    names = [o.name for o in s.get_outputs()]
    paths = {e["name"]: e["path"] for e in json.loads(index.read_text())}
    reads = {}
    for name, found in json.loads(dets.read_text()).items():
        above = [d for d in found if d["score"] >= STEP_GATE]
        if not above:
            reads[name] = None
            continue
        x1, y1, x2, y2 = max(above, key=lambda d: d["score"])["bbox"]
        img = Image.open(paths[name]).convert("RGB")
        bw, bh = x2 - x1, y2 - y1
        cut = img.crop((int(round(max(0, x1 - bw * OCR_MARGIN))), int(round(max(0, y1 - bh * OCR_MARGIN))),
                        int(round(min(img.width, x2 + bw * OCR_MARGIN))), int(round(min(img.height, y2 + bh * OCR_MARGIN)))))
        if max(cut.size) < OCR_MIN_LONG:
            reads[name] = ""
            continue
        t = np.asarray(cut.resize((128, 64), Image.BILINEAR), np.float32)[None] / 255.0
        reads[name] = postprocess_plate_slots(dict(zip(names, s.run(None, {"input": t}))), OCR_CFG,
                                              cut.width, cut.height, 1.0, (0, 0)).get("text", "")
    out.write_text(json.dumps(reads))


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


def _parity(ref: dict, cand: dict, ref_reads: dict, cand_reads: dict, labels: dict) -> dict:
    matched = n_ref = n_cand = 0
    ious, missed, extra = [], [], []
    for k in ref:
        R = [d for d in ref[k] if d["score"] >= STEP_GATE]
        C = [d for d in cand[k] if d["score"] >= STEP_GATE]
        n_ref += len(R)
        n_cand += len(C)
        used: set[int] = set()
        for r in R:
            best = max(((_iou(r["bbox"], c["bbox"]), j) for j, c in enumerate(C) if j not in used), default=(0.0, -1))
            if best[0] >= 0.5:
                used.add(best[1])
                matched += 1
                ious.append(best[0])
            else:
                missed.append({"crop": k, "score": r["score"]})
        extra += [{"crop": k, "score": c["score"]} for j, c in enumerate(C) if j not in used]

    def good(reads: dict, k: str) -> bool:
        return bool(reads[k]) and (k not in labels or reads[k] == labels[k])

    scored = [k for k in ref if k in labels] if labels else list(ref)
    return {
        "crops": len(ref), "reference_detections": n_ref, "int8_detections": n_cand, "matched": matched,
        "detections_of_reference": round(matched / max(1, n_ref), 4),
        "box_iou_mean": round(sum(ious) / max(1, len(ious)), 4), "box_iou_min": round(min(ious, default=0.0), 4),
        "missed": missed, "extra": extra,
        "reads_counted_on": "label match" if labels else "any non-empty read",
        "reference_reads": sum(good(ref_reads, k) for k in scored),
        "int8_reads": sum(good(cand_reads, k) for k in scored),
        "same_text": sum(ref_reads[k] == cand_reads[k] for k in ref),
    }


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--work", type=Path)
    ap.add_argument("--frames", type=Path, action="append", default=[],
                    help="directory of padded vehicle crops (jpg/png) from native keyframes")
    ap.add_argument("--labels", type=Path, help="optional JSON {crop stem: plate text} for the read count")
    ap.add_argument("--compiler", default="docker", help="docker | lima:<instance>")
    ap.add_argument("--python", default=sys.executable, help="interpreter with onnxruntime + ai-edge-litert + pillow")
    ap.add_argument("--tf-python", help="interpreter with tensorflow + onnx2tf (onnx2tf on PATH next to it)")
    ap.add_argument("--stage", help=argparse.SUPPRESS)
    ap.add_argument("stage_args", nargs="*", help=argparse.SUPPRESS)
    a = ap.parse_args()

    if a.stage:
        if a.stage == "run":
            _stage_run(a.stage_args[0], *(Path(p) for p in a.stage_args[1:]))
            return
        fn = {"calib": _stage_calib, "rename": _stage_rename, "edit-check": _stage_edit_check, "ocr": _stage_ocr,
              "fixture": _stage_fixture, "fixture-ref": _stage_fixture_ref}[a.stage]
        fn(*(Path(p) for p in a.stage_args))
        return
    if a.work is None or not a.frames or a.tf_python is None:
        ap.error("--work, --frames and --tf-python are required")

    work = a.work.absolute()
    work.mkdir(parents=True, exist_ok=True)
    print("1/6 fetch + edit (Focus -> 6x6/s2 Conv, bake folded, raw head)")
    published = tc.fetch(SRC_ONNX, work)
    ocr = tc.fetch(SRC_OCR, work)
    edited = work / "yolox-edgetpu.onnx"
    _edit(published, edited)
    paths = sorted(str(p) for d in a.frames for p in d.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    index = [{"name": Path(p).stem, "path": p, "split": "calib" if i % 3 == 0 else "eval"} for i, p in enumerate(paths)]
    (work / "frames.json").write_text(json.dumps(index))
    _run_stage(a.python, "edit-check", str(published), str(edited), str(work / "frames.json"))

    print(f"2/6 frames: {len(index)}, {sum(e['split'] == 'calib' for e in index)} calibrate")
    _run_stage(a.python, "calib", str(work / "frames.json"), str(work / "calib.npy"),
               str(work / "calibration_image_sample_data_20x128x128x3_float32.npy"))

    print("3/6 full-integer quantisation (onnx2tf)")
    tf_dir = work / "tf"
    shutil.rmtree(tf_dir, ignore_errors=True)
    onnx2tf = Path(a.tf_python).parent / "onnx2tf"
    subprocess.run([str(onnx2tf), "-i", str(edited), "-o", str(tf_dir), "-oiqt", "-qt", "per-channel",
                    "-cind", "images", str(work / "calib.npy"), "[[[[0,0,0]]]]", "[[[[1,1,1]]]]",
                    "-iqd", "uint8", "-oqd", "int8", "-n"], check=True, cwd=work,
                   stdout=(work / "onnx2tf.log").open("w"), stderr=subprocess.STDOUT)
    int8 = work / f"{NAME}_int8.tflite"
    _run_stage(a.tf_python, "rename", str(tf_dir / "yolox-edgetpu_full_integer_quant.tflite"), str(int8))

    print("4/6 compile: alone, and co-compiled after the root SSD")
    ssd = tc.fetch(tc.SRC_SSD_QUANT, work)
    tc.compile_jobs(a.compiler, work, [int8, ssd],
                    [("compiled", [int8.name]), ("cocompiled", [ssd.name, int8.name])])
    alone = tc.parse_compiler_output((work / "compiled" / "compiler.txt").read_text())
    co = tc.parse_compiler_output((work / "cocompiled" / "compiler.txt").read_text())
    for label, rows in (("alone", alone), ("SSD + YOLOX", co)):
        for r in rows:
            print(f"  {label:12s} {r['model']:44s} ops {r['ops_tpu']}/{r['ops_total']} on TPU, "
                  f"on-chip {tc.mib(r['on_chip_bytes'])}, streamed {tc.mib(r['streamed_bytes'])}")
    if alone[0]["ops_cpu"] != 0:
        raise SystemExit("not every op maps to the Edge TPU")

    print("5/6 parity at the step gate, detections and end-to-end reads")
    for rt, model, tag in (("ort", published, "ref"), ("litert", int8, "int8")):
        _run_stage(a.python, "run", rt, str(model), str(work / "frames.json"), str(work / f"{tag}.json"))
        _run_stage(a.python, "ocr", str(ocr), str(work / "frames.json"), str(work / f"{tag}.json"),
                   str(work / f"{tag}-reads.json"))
    labels = json.loads(a.labels.read_text()) if a.labels else {}
    parity = _parity(*(json.loads((work / f).read_text()) for f in ("ref.json", "int8.json", "ref-reads.json",
                                                                    "int8-reads.json")), labels)
    print(json.dumps(parity, indent=1))
    if (parity["detections_of_reference"] < GATE_DETECTIONS
            or parity["int8_reads"] < GATE_READS * parity["reference_reads"]):
        raise SystemExit("parity gate FAILED")

    print("6/6 fixture + stage")
    _run_stage(a.python, "fixture", str(published), str(int8), str(_FIXTURE))
    _run_stage(a.python, "fixture-ref", str(published), str(_FIXTURE))
    fx = json.loads(_FIXTURE.read_text())
    fx["producedBy"] = ("scripts/build-yolox-plate-edgetpu.py: raw outputs of the int8 graph the Edge TPU file is "
                        "compiled from, on reference-images/1-car-plate.jpg letterboxed to 640; onnxDetections = "
                        "the published ONNX at the step gate")
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
    print(f"  hf upload camstack/camstack-models {dest} {FOLDER}/tflite")


if __name__ == "__main__":
    main()
