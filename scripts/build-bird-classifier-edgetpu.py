#!/usr/bin/env python3
"""Build the Coral (Edge TPU) format of the ``bird-classifier`` survivor (D710).

    python3 scripts/build-bird-classifier-edgetpu.py --work <dir> [--images <dir>] \
        [--compiler docker|lima:<instance>]

produces, under ``<work>/stage/animalClassification/bird-classifier/``:

    tflite/bird-classifier_edgetpu.tflite    (full-integer uint8, Edge TPU compiled)

and next to it the evidence D710 asks for: the compiler log (op mapping and
on-chip memory), the same compiler co-compiling the root SSD with the bird
(does the pair fit the ~8 MB parameter cache together?), and the top-1 parity
report against the ONNX survivor. Upload with:

    hf upload camstack/camstack-models <work>/stage/animalClassification/bird-classifier \
        animalClassification/bird-classifier

The model card (``hf/camstack-models/animalClassification/bird-classifier/README.md``)
travels with ``hf/camstack-models/upload.sh``, not with this script.

SOURCE
------
The survivor is Google AIY Vision Birds V1 (MobileNetV2 1.0 224, 964 species +
background, Apache-2.0). Google publishes its full-integer quantised TFLite in
``google-coral/test_data`` as ``mobilenet_v2_1.0_224_inat_bird_quant.tflite``;
the ONNX/OpenVINO/CoreML builds of the same id come from the float graph. This
script compiles THAT quantised file with ``edgetpu_compiler`` rather than
re-quantising the ONNX: Google's quantisation is the one the upstream
published, and a second post-training calibration on CamStack crops would be a
new set of weights for no measured gain. Pinned by commit and sha256 below.

The contract needs no graph edit:

    in   [1,224,224,3] uint8, quantisation scale 1/128 zp 128  (raw 0..255 RGB,
         the [-1,1] normalisation is IN the graph — the edgetpu preprocess feeds
         raw uint8 and ignores ``inputNormalization``)
    out  [1,965] uint8, scale 1/256 zp 0 — softmax already applied in-graph;
         ``edgetpu_dequant.dequant_edgetpu_output`` turns it into probabilities,
         and the catalog's ``outputProbabilities: true`` stops a second softmax.

Labels: the existing ``onnx/bird-classifier-labels.json`` (same 965 entries,
same order, index 964 ``background``) — no new label file.

COMPILER
--------
``edgetpu_compiler`` is x86-64 Linux only, and the Coral apt repository is gone
(403), so the compiler is Google's own bundle from ``google-coral/edgetpu``
(version 14, pinned by commit and sha256 below — binary, loader and libs).
``--compiler docker`` runs it in a ``linux/amd64`` ``debian:bookworm-slim``
container (an Apple Silicon Docker emulates it); ``--compiler lima:<instance>``
does the same with the VM's rootless ``nerdctl`` in a Lima VM started with
``limactl start --name=coral --vm-type=vz --rosetta template:default`` (what
this Mac uses: no Docker Desktop; Rosetta runs the amd64 container). Lima 2
shares no writable host directory, so the inputs are copied in and the outputs
copied back.

Reproducible up to the CACHE TOKEN: every compile writes a fresh random 8-byte
parameter-cache token (twice in the file), so two runs differ in exactly 16
bytes and the sha256 changes; everything else is byte-identical. The token is
what makes two separately compiled models evict each other from the cache.

STAGES, each in its own interpreter
-----------------------------------
onnxruntime and LiteRT (ai-edge-litert) are never loaded into one process:
mixing ML runtimes in one interpreter deadlocks or crashes on this Mac (see
build-yunet-model.py). The parent imports numpy and Pillow only. The stage
interpreter (``--python``, default this one) needs: numpy pillow onnxruntime
ai-edge-litert.

PARITY
------
Crops, not photos: the step classifies ``crop-roi`` of an ``animal`` detection.
The ``crops`` stage runs Google's CPU SSD MobileNet V2 COCO (the CPU sibling of
the catalog's root Coral detector) over every image, keeps ``bird`` boxes at
score >= 0.4, pads each by 10% and crops it; an image with no bird box is used
whole and counted apart. Every crop is also fed as a low-resolution variant
(short side 48 px, as a distant bird on a camera is) — the pipeline resizes
both to 224 with bilinear, as the pool does. Reference: the ONNX survivor fed
``x/255`` NHWC (the pool's onnx preprocess for ``inputNormalization: 'none'``).
Candidate: the CPU int8 graph the Edge TPU file is compiled from, run by LiteRT
and dequantised exactly as the edgetpu predict closure does. The Edge TPU
executes that graph's integer ops; the run on a real Coral is the deploy check.

Gates (exit 1 on a miss), under the step's own gate (``defaultConfidence`` 0.6,
``background`` rejected): the EMITTED outcome (species or nothing) is the same
on >= 95% of crops, the two never emit DIFFERENT species, and wherever the
reference emits a species with p >= 0.8 the candidate emits the same species.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import urllib.request
from hashlib import sha256
from pathlib import Path

_REPO = Path(__file__).resolve().parents[1]
_REFERENCE_IMAGES = _REPO / "packages" / "addon-pipeline" / "assets" / "reference-images"

CORAL_COMMIT = "104342d2d3480b3e66203073dac24f4e2dbb4c41"  # google-coral/test_data HEAD, 2021-07-26
_CORAL = f"https://raw.githubusercontent.com/google-coral/test_data/{CORAL_COMMIT}"
_HF = "https://huggingface.co/camstack/camstack-models/resolve/main/animalClassification/bird-classifier"

# (url, file name, sha256, bytes)
SRC_BIRD_QUANT = (f"{_CORAL}/mobilenet_v2_1.0_224_inat_bird_quant.tflite", "bird_quant.tflite",
                  "350fcd8cf1df1560060d464595dfed8b174b05792788052896004848d9ad04f9", 3_579_500)
# The root detector's CPU sibling: crops for parity, and the co-compile cost check.
SRC_SSD_QUANT = (f"{_CORAL}/ssd_mobilenet_v2_coco_quant_postprocess.tflite", "ssd_quant.tflite",
                 "42fb3d70ffb7bb37dd518f730f7be784b831c2078f30c497d0019cc2e987fa26", 6_220_797)
REF_ONNX = (f"{_HF}/onnx/bird-classifier.onnx", "bird-classifier.onnx",
            "64dd1b966628145219f2424b42b18b76b8dc33a0a9d9ce90b8c057397fa76da2", 13_893_131)
REF_LABELS = (f"{_HF}/onnx/bird-classifier-labels.json", "bird-classifier-labels.json",
              "1289e4cb0d7dbc9298b115abf077cd7f7df68ab04ab29501fed2fc58d66babfd", 26_102)

FOLDER = "animalClassification/bird-classifier"
OUT_NAME = "bird-classifier_edgetpu.tflite"
COMPILER_IMAGE = "debian:bookworm-slim"
# edgetpu_compiler 14 ("eel2", 2020-07) as Google committed it to
# google-coral/edgetpu: the binary with its own loader and libs. The apt
# repository that carried 15/16 (packages.cloud.google.com coral-edgetpu-stable)
# answers 403 since Google ended Coral support, so the GitHub bundle is the one
# reproducible source. Its output runs on any libedgetpu (runtime >= 13).
COMPILER_COMMIT = "3b625cddfe8886f15978221a02cda2e52044b24c"
_COMPILER = f"https://raw.githubusercontent.com/google-coral/edgetpu/{COMPILER_COMMIT}/compiler/x86_64/edgetpu_compiler_bin"
COMPILER_FILES = (
    ("edgetpu_compiler", "5482d4627920e7b0c0c9fb4b1dcaa941bbdb47430fd5a28fbbd13b3bf8415679", 19_613_568),
    ("ld-linux-x86-64.so.2", "0d3fc8700afd0fbdfd63af0aba794e5bc4260b679f03e93a6f792e4fe2d522a9", 169_552),
    ("libc++.so.1", "457fb2108a42215e0da9990bbbdd0d910ffef8f85bc87f422832b6e2764ddb5f", 788_920),
    ("libc++abi.so.1", "435713546d48e6aeefa765f983a90393b5b992307c76176774ca31e28fdba282", 211_616),
    ("libc.so.6", "fd8496fe7ae47c79dbacd411af3c6f63f821201150c9ca99f1e833f7b2d972e9", 1_795_984),
    ("libdl.so.2", "9ce41c740532940d1c625a3afd8159d44c86721fb7dcc06438be45e1e3560a89", 14_448),
    ("libm.so.6", "6bde953e2692494c9aa1aaa01a7d14196c7603d1a8f20ed7a55d4e804f9151a5", 1_435_680),
    ("libpthread.so.0", "67443ab4f157a3acebb514d6a7505ac76f22052004eabb6ea9a3688ccf6f0e8f", 105_496),
    ("libresolv.so.2", "8bf1a5049e7a3ddbde2c2b86983fa239fd4eb096356479dc3c305af76abda05a", 84_008),
    ("librt.so.1", "bd0cd2f5be13a5a12a79b19699aa4330b57628cef5eb6fa5bc09a948e05c405d", 31_056),
)

INPUT = 224
BACKGROUND = 964
STEP_GATE = 0.6  # step-definitions.ts STEP_BIRD_CLASSIFIER.defaultConfidence
SSD_BIRD = 15  # COCO_90 index of "bird" (postprocessors/ssd.py)
SSD_MIN_SCORE = 0.4
CROP_PAD = 0.10
LOWRES_SHORT_SIDE = 48
GATE_OUTCOME_AGREEMENT = 0.95
GATE_CONFIDENT_P = 0.8


def _fetch(src: tuple[str, str, str, int], dest_dir: Path) -> Path:
    url, name, digest, size = src
    dest = dest_dir / name
    if not dest.exists():
        print(f"  fetch {url}")
        with urllib.request.urlopen(url) as resp, dest.open("wb") as out:
            shutil.copyfileobj(resp, out)
    data = dest.read_bytes()
    if len(data) != size or sha256(data).hexdigest() != digest:
        dest.unlink()
        raise SystemExit(f"{name}: size/sha256 mismatch (expected {size} bytes, {digest})")
    return dest


# ── compile ──────────────────────────────────────────────────────────────────

def _fetch_compiler(work: Path) -> Path:
    """The pinned compiler bundle (binary + its own loader and libs), sha256-checked."""
    bin_dir = work / "edgetpu_compiler_bin"
    bin_dir.mkdir(exist_ok=True)
    for name, digest, size in COMPILER_FILES:
        _fetch((f"{_COMPILER}/{name}", name, digest, size), bin_dir)
    for name in ("edgetpu_compiler", "ld-linux-x86-64.so.2"):
        (bin_dir / name).chmod(0o755)
    return bin_dir


_COMPILE_SCRIPT = (
    "set -e; B=$PWD/edgetpu_compiler_bin; "
    "tpuc() { \"$B/ld-linux-x86-64.so.2\" --library-path \"$B\" \"$B/edgetpu_compiler\" \"$@\"; }; "
    "tpuc --version; "
    "tpuc -s -o compiled bird_quant.tflite; "
    # Cost on the shared context (D710 §3): the root SSD and the bird
    # co-compiled, SSD first (cache space is allocated in command-line order).
    "tpuc -s -o cocompiled ssd_quant.tflite bird_quant.tflite"
)


def _container_run(work: str) -> list[str]:
    return ["run", "--rm", "--platform", "linux/amd64", "-v", f"{work}:/work", "-w", "/work",
            COMPILER_IMAGE, "bash", "-c", _COMPILE_SCRIPT]


def _compile(compiler: str, work: Path) -> Path:
    _fetch_compiler(work)
    for d in ("compiled", "cocompiled"):
        shutil.rmtree(work / d, ignore_errors=True)
        (work / d).mkdir()
    if compiler == "docker":
        subprocess.run(["docker", *_container_run(str(work))], check=True)
    elif compiler.startswith("lima:"):
        # Lima 2's default template shares no writable host directory, so the
        # inputs are copied into the VM and the outputs copied back.
        vm = compiler.split(":", 1)[1]
        vm_work = "/tmp/camstack-bird-edgetpu"
        subprocess.run(["limactl", "shell", vm, "bash", "-c",
                        f"rm -rf {vm_work} && mkdir -p {vm_work}/compiled {vm_work}/cocompiled"], check=True)
        for item in ("bird_quant.tflite", "ssd_quant.tflite", "edgetpu_compiler_bin"):
            subprocess.run(["limactl", "copy", "-r", str(work / item), f"{vm}:{vm_work}/"], check=True)
        subprocess.run(["limactl", "shell", vm, "nerdctl", *_container_run(vm_work)], check=True)
        tar = subprocess.run(["limactl", "shell", vm, "tar", "-C", vm_work, "-cf", "-",
                              "compiled", "cocompiled"], check=True, capture_output=True).stdout
        subprocess.run(["tar", "-C", str(work), "-xf", "-"], input=tar, check=True)
    else:
        raise SystemExit(f"unknown --compiler {compiler!r} (docker | lima:<instance>)")
    built = work / "compiled" / "bird_quant_edgetpu.tflite"
    if not built.exists():
        raise SystemExit("edgetpu_compiler produced no bird_quant_edgetpu.tflite")
    return built


def _report_compile(work: Path) -> dict:
    log = (work / "compiled" / "bird_quant_edgetpu.log").read_text()
    co_log = (work / "cocompiled" / "ssd_quant_edgetpu.log").read_text()
    print("\n── edgetpu_compiler: bird alone ──\n" + log)
    print("── edgetpu_compiler: SSD + bird co-compiled ──\n" + co_log)
    return {"bird_log": log, "cocompile_log": co_log}


# ── stages (own interpreter each) ─────────────────────────────────────────────

def _stage_crops(images_list: Path, ssd: Path, out_dir: Path) -> None:
    import numpy as np
    from PIL import Image
    from ai_edge_litert.interpreter import Interpreter

    it = Interpreter(str(ssd))
    it.allocate_tensors()
    ind = it.get_input_details()[0]
    outs = it.get_output_details()
    _, h, w, _ = ind["shape"]
    index = []
    for i, line in enumerate(images_list.read_text().splitlines()):
        img = Image.open(line).convert("RGB")
        it.set_tensor(ind["index"], np.asarray(img.resize((w, h), Image.BILINEAR), np.uint8)[None])
        it.invoke()
        boxes, classes, scores, count = (it.get_tensor(o["index"])[0] for o in outs[:4])
        crops = []
        for k in range(int(count)):
            if int(classes[k]) != SSD_BIRD or float(scores[k]) < SSD_MIN_SCORE:
                continue
            y0, x0, y1, x1 = (float(v) for v in boxes[k])
            pw, ph = (x1 - x0) * CROP_PAD, (y1 - y0) * CROP_PAD
            box = (max(0, int((x0 - pw) * img.width)), max(0, int((y0 - ph) * img.height)),
                   min(img.width, int((x1 + pw) * img.width)), min(img.height, int((y1 + ph) * img.height)))
            if box[2] - box[0] >= 16 and box[3] - box[1] >= 16:
                crops.append(img.crop(box))
        source = "crop" if crops else "whole"
        for j, crop in enumerate(crops or [img]):
            name = f"{i:03d}_{j}"
            crop.save(out_dir / f"{name}.png")
            short = min(crop.size)
            f = LOWRES_SHORT_SIDE / short
            if f < 1:
                low = crop.resize((max(1, round(crop.width * f)), max(1, round(crop.height * f))), Image.BILINEAR)
                low.save(out_dir / f"{name}_low.png")
                index.append({"name": f"{name}_low", "source": source, "variant": "low", "image": line})
            index.append({"name": name, "source": source, "variant": "full", "image": line})
    (out_dir / "index.json").write_text(json.dumps(index, indent=1))


def _load_224(path: Path):
    import numpy as np
    from PIL import Image
    img = Image.open(path).convert("RGB").resize((INPUT, INPUT), Image.BILINEAR)
    return np.asarray(img, dtype=np.uint8)


def _stage_onnx(model: Path, crops: Path, out: Path) -> None:
    import numpy as np
    import onnxruntime as ort

    sess = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
    name = sess.get_inputs()[0].name
    index = json.loads((crops / "index.json").read_text())
    probs = [sess.run(None, {name: (_load_224(crops / f"{e['name']}.png").astype(np.float32) / 255.0)[None]})[0][0]
             for e in index]
    np.save(out, np.stack(probs).astype(np.float32))


def _stage_litert(model: Path, crops: Path, out: Path) -> None:
    import numpy as np
    from ai_edge_litert.interpreter import Interpreter

    sys.path.insert(0, str(_REPO / "packages" / "addon-pipeline" / "python"))
    from edgetpu_dequant import dequant_edgetpu_output

    it = Interpreter(str(model))
    it.allocate_tensors()
    ind = it.get_input_details()[0]
    outd = it.get_output_details()[0]
    scale, zp = outd["quantization"]
    index = json.loads((crops / "index.json").read_text())
    probs = []
    for e in index:
        it.set_tensor(ind["index"], _load_224(crops / f"{e['name']}.png")[None])
        it.invoke()
        raw = it.get_tensor(outd["index"])[0]
        probs.append(dequant_edgetpu_output(raw, dtype_name=np.dtype(outd["dtype"]).name,
                                            scale=float(scale), zero_point=int(zp)))
    np.save(out, np.asarray(probs, dtype=np.float32))


def _run_stage(python: str, name: str, *args: str) -> None:
    subprocess.run([python, __file__, "--stage", name, *args], check=True)


# ── parity ───────────────────────────────────────────────────────────────────

def _emitted(p) -> int | None:
    top = int(p.argmax())
    return top if top != BACKGROUND and float(p[top]) >= STEP_GATE else None


def _parity(work: Path, labels: list[str]) -> dict:
    import numpy as np

    index = json.loads((work / "crops" / "index.json").read_text())
    ref = np.load(work / "probs_onnx.npy")
    cand = np.load(work / "probs_litert.npy")

    def summarise(rows: list[int]) -> dict:
        if not rows:
            return {"n": 0}
        top1 = sum(int(ref[i].argmax()) == int(cand[i].argmax()) for i in rows)
        out_same = sum(_emitted(ref[i]) == _emitted(cand[i]) for i in rows)
        confident = [i for i in rows if _emitted(ref[i]) is not None and float(ref[i].max()) >= GATE_CONFIDENT_P]
        conf_same = sum(_emitted(cand[i]) == _emitted(ref[i]) for i in confident)
        conflicts = sum(_emitted(ref[i]) is not None and _emitted(cand[i]) is not None
                        and _emitted(ref[i]) != _emitted(cand[i]) for i in rows)
        top5 = float(np.mean([len(set(np.argsort(-ref[i])[:5]) & set(np.argsort(-cand[i])[:5])) for i in rows]))
        maxabs = [float(np.abs(ref[i] - cand[i]).max()) for i in rows]
        return {
            "n": len(rows), "top1_agree": top1, "outcome_agree": out_same,
            "emitted_ref": sum(_emitted(ref[i]) is not None for i in rows),
            "emitted_cand": sum(_emitted(cand[i]) is not None for i in rows),
            "confident_n": len(confident), "confident_same": conf_same,
            "species_conflicts": conflicts,
            "top5_overlap_mean": round(top5, 2),
            "max_abs_dp_mean": round(float(np.mean(maxabs)), 4),
            "max_abs_dp_p95": round(float(np.percentile(maxabs, 95)), 4),
        }

    all_rows = list(range(len(index)))
    report = {
        "all": summarise(all_rows),
        "detected_crops_full": summarise([i for i, e in enumerate(index) if e["source"] == "crop" and e["variant"] == "full"]),
        "detected_crops_low": summarise([i for i, e in enumerate(index) if e["source"] == "crop" and e["variant"] == "low"]),
        "whole_images": summarise([i for i, e in enumerate(index) if e["source"] == "whole"]),
        "outcome_differences": [
            {"crop": index[i]["name"], "image": Path(index[i]["image"]).name,
             "ref": [labels[int(ref[i].argmax())], round(float(ref[i].max()), 3)],
             "cand": [labels[int(cand[i].argmax())], round(float(cand[i].max()), 3)]}
            for i in all_rows if _emitted(ref[i]) != _emitted(cand[i])
        ],
    }
    print("\n── parity: ONNX survivor vs int8 graph (step gate 0.6, background rejected) ──")
    print(json.dumps(report, indent=1))
    a = report["all"]
    if (a["outcome_agree"] / a["n"] < GATE_OUTCOME_AGREEMENT or a["confident_same"] != a["confident_n"]
            or a["species_conflicts"] != 0):
        raise SystemExit("parity gate FAILED")
    return report


def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--work", type=Path)
    ap.add_argument("--images", type=Path, action="append", default=[],
                    help="extra directory of bird photos (jpg/png) for the parity pass")
    ap.add_argument("--compiler", default="docker", help="docker | lima:<instance>")
    ap.add_argument("--python", default=sys.executable, help="interpreter for the ML stages")
    ap.add_argument("--skip-compile", action="store_true", help="reuse <work>/compiled")
    ap.add_argument("--stage", help=argparse.SUPPRESS)
    ap.add_argument("stage_args", nargs="*", help=argparse.SUPPRESS)
    a = ap.parse_args()

    if a.stage:
        fn = {"crops": _stage_crops, "onnx": _stage_onnx, "litert": _stage_litert}[a.stage]
        fn(*(Path(p) for p in a.stage_args))
        return
    if a.work is None:
        ap.error("--work is required")

    work = a.work.absolute()  # not resolve(): /tmp/lima must stay /tmp/lima for the VM
    work.mkdir(parents=True, exist_ok=True)
    print("1/4 fetch (pinned, sha256-checked)")
    bird = _fetch(SRC_BIRD_QUANT, work)
    ssd = _fetch(SRC_SSD_QUANT, work)
    onnx_model = _fetch(REF_ONNX, work)
    labels = json.loads(_fetch(REF_LABELS, work).read_text())["labels"]

    print("2/4 compile")
    built = (work / "compiled" / "bird_quant_edgetpu.tflite") if a.skip_compile else _compile(a.compiler, work)
    compile_report = _report_compile(work)

    print("3/4 parity")
    crops = work / "crops"
    shutil.rmtree(crops, ignore_errors=True)
    crops.mkdir()
    images = sorted(str(p) for p in _REFERENCE_IMAGES.glob("*bird*.jpg"))
    for d in a.images:
        images += sorted(str(p) for p in d.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png"))
    (work / "images.txt").write_text("\n".join(images))
    _run_stage(a.python, "crops", str(work / "images.txt"), str(ssd), str(crops))
    _run_stage(a.python, "onnx", str(onnx_model), str(crops), str(work / "probs_onnx.npy"))
    _run_stage(a.python, "litert", str(bird), str(crops), str(work / "probs_litert.npy"))
    parity = _parity(work, labels)

    print("4/4 stage")
    dest = work / "stage" / FOLDER / "tflite" / OUT_NAME
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(built, dest)
    digest = sha256(dest.read_bytes()).hexdigest()
    (work / "report.json").write_text(json.dumps(
        {"file": str(dest), "sha256": digest, "bytes": dest.stat().st_size,
         "source": SRC_BIRD_QUANT[0], **compile_report, "parity": parity}, indent=1))
    print(f"  {dest}  {dest.stat().st_size} bytes  sha256 {digest}")
    print(f"  hf upload camstack/camstack-models {work / 'stage' / FOLDER} {FOLDER}")


if __name__ == "__main__":
    main()
