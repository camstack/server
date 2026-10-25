#!/usr/bin/env python3
"""
Rebuild every Ultralytics-derived (AGPL-3.0) model the CamStack mirror hosts.

This is the Corresponding Source for the AGPL-3.0 weights of
https://huggingface.co/camstack/camstack-models in

  objectDetection/yolo26      yolo26{n,s,m,l,x} @640, yolo26{n,s,m,l} @320 and @256
  objectDetection/yolov9      yolov9{t,s,m,c} @320 and @640
  segmentation/yolo26-seg     yolo26{n,s,m}-seg @640

Every hosted file is one output of ONE recipe in `RECIPES` below, and the recipe
holds exactly the settings that file records about itself: the Ultralytics
`export()` arguments (stored in each ONNX / CoreML file's metadata), the OpenVINO
weight compression and the NNCF calibration subset size (stored in each IR's
`rt_info`). `--check-hosted` proves the mapping is complete against the live
mirror: every hosted weight file must be an output of some recipe.

Usage:
  python build-camstack-models.py --list                       # every recipe
  python build-camstack-models.py --check-hosted               # recipes == mirror?
  python build-camstack-models.py --variant camstack-yolo26n-320
  python build-camstack-models.py --family yolov9              # one mirror folder
  python build-camstack-models.py --all                        # the whole mirror
  python build-camstack-models.py --all --formats onnx,openvino --dry-run

  # Something not in the mirror (same pipeline, your own settings):
  python build-camstack-models.py --model yolo26n --imgsz 416 \
      --openvino fp16,int8 --calib-samples 128

  # A fine-tuned local checkpoint, INT8-calibrated on your own frames (a
  # folder of images, or an extracted retrain export: its frames/ are used):
  python build-camstack-models.py --checkpoint runs/train/weights/best.pt \
      --imgsz 640 --openvino fp16,int8 --calib-dir ./my-export --name custom-yolov9m-640

Outputs land in `--out` (default ./exported-models) under the MIRROR's paths,
e.g. exported-models/objectDetection/yolo26/openvino/camstack-yolo26n-320-int8.xml.

Formats:
  onnx      Ultralytics export(format="onnx") from the upstream .pt
  coreml    Ultralytics export(format="coreml") from the upstream .pt (macOS only),
            always FP16: an FP32 package never runs on the Neural Engine
  openvino  convert_lib.export_openvino: ov.convert_model(ONNX) + ov.save_model
            (compress_to_fp16 per precision) — never the Ultralytics OV exporter
  int8      convert_lib.quantize_openvino_int8: NNCF post-training quantisation
            of the ONNX, calibrated on the first N images (sorted by path,
            recursively; an export folder's frames/ only) of --calib-dir
            (default $CAMSTACK_CALIB_DIR or ./calibration-images). Recipe (D818):
            preset MIXED, full bias correction, the Detect head in float —
            its own ops (DFL + box decode) for a YOLOv9 head, all of it for
            YOLO26's end-to-end head; every conv before it is INT8

INT8 calibration: the hosted INT8 IRs record subset_size 128 (YOLO26) and 300
(YOLOv9), drawn from COCO; an IR does not record WHICH images. The documented
set is COCO val2017: unpack http://images.cocodataset.org/zips/val2017.zip and
point --calib-dir at it — the recipe's N is taken in file-name order. Images are letterboxed to
the recipe's input size, CENTRED with grey (114) padding, and scaled to [0, 1],
exactly as the CamStack runtime feeds the model (the padding sat top-left until
2026-10-08, which the runtime never does). A different calibration set yields an
equivalent but not bit-identical IR (NNCF picks ranges from the data).

Which recipe each hosted INT8 IR carries. All were built from the HOSTED ONNX
with OpenVINO 2026.2.1 + NNCF 3.2.0 on the first N COCO val2017 images
(reproduce with `--reuse-onnx`, the mirror's .onnx placed under --out):
  D818 recipe (this script, since 2026-10-09 — MIXED, full bias correction,
  the Detect head in float; docs/benchmarks/2026-10-09-int8-recipe.md):
    yolov9{t,s,m,c}-{320,640}, yolo26{n,s,l} @640, yolo26n-320,
    yolo26{n,s}-256
  NNCF defaults, centred calibration (convert_lib 2026-10-08 → 2026-10-09,
  the mirror's source/archive/convert_lib-before-2026-10-09.py — kept: the D818
  build was more accurate but 11-22 % slower on the Intel iGPU):
    yolo26{m,x} @640, yolo26{m,l}-256
  NNCF defaults, top-left calibration (convert_lib before 2026-10-08,
  source/archive/convert_lib-before-2026-10-08.py — kept, same reason):
    yolo26{s,m,l}-320
The D818 build reproduces every replaced IR's .bin bit for bit
(docs/benchmarks/2026-10-09-int8-recipe.md).

Toolchain: each recipe names the Ultralytics / torch / coremltools / OpenVINO
versions its hosted files record. Other versions produce the same model with a
possibly different graph layout; the script warns when they differ.

Environment: `pip install -r requirements.txt ultralytics` (requirements.txt is
convert_lib's). convert_lib.py is found next to this script (the mirror's
`source/` folder) or in packages/addon-model-studio/python/ (the repository).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

_HERE = Path(__file__).resolve().parent
_CONVERT_LIB_DIRS = (_HERE, _HERE.parent / 'packages' / 'addon-model-studio' / 'python')
_CONVERT_LIB_DIR = next((d for d in _CONVERT_LIB_DIRS if (d / 'convert_lib.py').is_file()), None)
if _CONVERT_LIB_DIR is None:
    sys.exit('convert_lib.py not found next to this script or in packages/addon-model-studio/python/')
sys.path.insert(0, str(_CONVERT_LIB_DIR))

HF_REPO = 'camstack/camstack-models'
DEFAULT_CALIB_DIR = Path(os.environ.get('CAMSTACK_CALIB_DIR', 'calibration-images'))

# --- Recipe model ------------------------------------------------------------


@dataclass(frozen=True)
class OnnxExport:
    """Ultralytics export(format="onnx") arguments, as the hosted ONNX records them."""

    dynamic: bool
    opset: int


@dataclass(frozen=True)
class CoremlExport:
    """Ultralytics export(format="coreml") arguments, as the hosted package records them."""

    dynamic: bool
    batch: int
    half: bool


@dataclass(frozen=True)
class OpenvinoOutput:
    """One hosted IR: file suffix after the model name, and how it is produced.

    `precision` is `fp32` (compress_to_fp16=False), `fp16` (compress_to_fp16=True)
    or `int8` (NNCF on the ONNX, `calib_samples` images).
    """

    suffix: str
    precision: str


@dataclass(frozen=True)
class Toolchain:
    ultralytics: str
    torch: str
    coremltools: str
    openvino: str


@dataclass(frozen=True)
class Recipe:
    name: str  # hosted file stem, e.g. camstack-yolo26n-320
    folder: str  # mirror folder, e.g. objectDetection/yolo26
    imgsz: int
    toolchain: Toolchain
    # The PyTorch checkpoint: an Ultralytics asset id (`yolo26n` -> yolo26n.pt,
    # auto-downloaded by Ultralytics), or — `--checkpoint` — the absolute path
    # of a local `.pt` (a fine-tune), used verbatim.
    checkpoint: str
    onnx: Optional[OnnxExport]
    coreml: Optional[CoremlExport]
    openvino: tuple[OpenvinoOutput, ...] = ()
    calib_samples: int = 0
    note: str = ''

    def outputs(self) -> list[str]:
        """Mirror paths this recipe produces (an .mlpackage is a directory)."""
        out: list[str] = []
        if self.onnx is not None:
            out.append(f'{self.folder}/onnx/{self.name}.onnx')
        if self.coreml is not None:
            out.append(f'{self.folder}/coreml/{self.name}.mlpackage/')
        for ov in self.openvino:
            stem = f'{self.folder}/openvino/{self.name}{ov.suffix}'
            out.extend([f'{stem}.xml', f'{stem}.bin'])
        return out


# --- The hosted set ------------------------------------------------------------
# Toolchains as recorded by the hosted files themselves (ONNX/CoreML metadata
# `version`, CoreML `com.github.apple.coremltools.*` and `torch==`, IR rt_info
# `Runtime_version`).
TC_2604 = Toolchain('8.4.24', '2.10.0', '9.0', '2026.2.1')
TC_2607_REDUCED = Toolchain('8.4.92', 'onnx 2.13.0, coreml 2.5.1', '8.3.0', '2026.2.1')
TC_2607_YOLOV9 = Toolchain('8.4.98', '2.13.0', '9.0', '2026.2.1')

FP16_IR = OpenvinoOutput('', 'fp16')


def _yolo26_full(tier: str) -> Recipe:
    """yolo26<tier> @640: static ONNX, static FP16 CoreML, IR fp16 twice + INT8.

    The unsuffixed IR and `-fp16` IR are the same compressed-to-FP16 weights;
    the catalog addresses both names. The hosted CoreML packages record
    `half: False` and still compute in FP16: Ultralytics 8.4.24 left Core ML's
    FP16 default in place. Later Ultralytics pins FP32 unless FP16 is asked
    for, so the recipe asks (`check_recipes`, D743).
    """
    return Recipe(
        name=f'camstack-yolo26{tier}', folder='objectDetection/yolo26', imgsz=640,
        toolchain=TC_2604, checkpoint=f'yolo26{tier}',
        onnx=OnnxExport(dynamic=False, opset=17),
        coreml=CoremlExport(dynamic=False, batch=1, half=True),
        openvino=(FP16_IR, OpenvinoOutput('-fp16', 'fp16'), OpenvinoOutput('-int8', 'int8')),
        calib_samples=128,
    )


def _yolo26_reduced(tier: str, res: int) -> Recipe:
    """yolo26<tier>-<res>: dynamic-axes ONNX, STATIC FP16 CoreML, IR fp32 + INT8.

    The CoreML package was batch-flexible (1..16) until 2026-10-07, and that
    package aborts the process that loads it (SIGABRT, macOS 26.2, every compute
    unit, coremltools 8.3 and 9.0 alike): Core ML's Espresso shape pass frees an
    unallocated pointer in `gather_nd` when the input batch is a range. YOLO26's
    NMS-free head is the only hosted graph with a `gather_nd`, which is why the
    one other batch-flexible package (bird-classifier) never hit it, and why the
    static @640 YOLO26 packages load. The static export loads and runs on every
    compute unit and replaced the flexible one in place (D742);
    `check_recipes` keeps a YOLO26 CoreML export from going flexible again.
    """
    return Recipe(
        name=f'camstack-yolo26{tier}-{res}', folder='objectDetection/yolo26', imgsz=res,
        toolchain=TC_2607_REDUCED, checkpoint=f'yolo26{tier}',
        onnx=OnnxExport(dynamic=True, opset=17),
        coreml=CoremlExport(dynamic=False, batch=1, half=True),
        openvino=(OpenvinoOutput('', 'fp32'), OpenvinoOutput('-int8', 'int8')),
        calib_samples=128,
    )


def _yolov9(tier: str, res: int) -> Recipe:
    """yolov9<tier>-<res>: static opset-13 ONNX, static FP16 CoreML, IR fp16 + INT8.

    The CoreML packages were FP32 until 2026-10-07: `half=False` under
    Ultralytics 8.4.98 pins Core ML's compute precision to FP32. The Neural
    Engine computes in FP16 only, so Core ML ran them on the GPU (`ALL`) or the
    CPU (`CPU_AND_NE`). The FP16 export runs on the Neural Engine and replaced
    the FP32 one in place (D743).
    """
    return Recipe(
        name=f'camstack-yolov9{tier}-{res}', folder='objectDetection/yolov9', imgsz=res,
        toolchain=TC_2607_YOLOV9, checkpoint=f'yolov9{tier}',
        onnx=OnnxExport(dynamic=False, opset=13),
        coreml=CoremlExport(dynamic=False, batch=1, half=True),
        openvino=(OpenvinoOutput('-fp16', 'fp16'), OpenvinoOutput('-int8', 'int8')),
        calib_samples=300,
    )


def _yolo26_seg(tier: str) -> Recipe:
    return Recipe(
        name=f'camstack-yolo26{tier}-seg', folder='segmentation/yolo26-seg', imgsz=640,
        toolchain=TC_2604, checkpoint=f'yolo26{tier}-seg',
        onnx=OnnxExport(dynamic=False, opset=17),
        coreml=CoremlExport(dynamic=False, batch=1, half=True),
        openvino=(FP16_IR,),
    )


RECIPES: tuple[Recipe, ...] = (
    *(_yolo26_full(t) for t in 'nsmlx'),
    *(_yolo26_reduced(t, r) for t in 'nsml' for r in (320, 256)),
    *(_yolov9(t, r) for t in ('t', 's', 'm', 'c') for r in (320, 640)),
    *(_yolo26_seg(t) for t in 'nsm'),
)

# Checkpoints whose graph carries YOLO26's NMS-free head (`topk` + `gather_nd`).
# Core ML aborts the process that loads such a graph with a batch-flexible input
# (macOS 26.2, every compute unit; D742), so their CoreML export is static.
GATHER_ND_CHECKPOINT_PREFIX = 'yolo26'


def check_recipes(recipes: tuple[Recipe, ...]) -> list[str]:
    """Recipes whose CoreML export is unusable on a Mac; empty when all is well.

    - A batch-flexible YOLO26 package aborts the process that loads it (D742).
    - An FP32 package never runs on the Neural Engine, which computes in FP16
      only: Core ML puts it on the GPU (`ALL`) or the CPU (`CPU_AND_NE`), 2-4x
      slower than the FP16 package of the same model on the Neural Engine
      (D743). Ultralytics pins FP32 unless `half` is set, so every CoreML
      recipe sets it.
    """
    bad: list[str] = []
    for r in recipes:
        if r.coreml is None:
            continue
        if r.coreml.dynamic and r.checkpoint.startswith(GATHER_ND_CHECKPOINT_PREFIX):
            bad.append(f'{r.name}: CoreML export must be static (dynamic=False, batch=1) — a '
                       f'batch-flexible {r.checkpoint} package aborts the process that loads it (D742)')
        if not r.coreml.half:
            bad.append(f'{r.name}: CoreML export must be FP16 (half=True) — an FP32 package never '
                       f'runs on the Neural Engine (D743)')
    return bad


FAMILIES = {
    'yolo26': 'objectDetection/yolo26',
    'yolov9': 'objectDetection/yolov9',
    'yolo26-seg': 'segmentation/yolo26-seg',
}
ALL_FORMATS = ('onnx', 'coreml', 'openvino')

# --- Helpers ----------------------------------------------------------------


def size_mb(path: Path) -> float:
    if path.is_file():
        return path.stat().st_size / 1_048_576
    return sum(f.stat().st_size for f in path.rglob('*') if f.is_file()) / 1_048_576


def warn_toolchain(recipe: Recipe) -> None:
    try:
        import ultralytics
    except ImportError:
        return
    want = recipe.toolchain.ultralytics.split(' ')[0]
    if ultralytics.__version__ != want:
        print(f'  ! the hosted {recipe.name} files were made with ultralytics {want}; '
              f'this is {ultralytics.__version__} (same weights, the graph may differ)')


def place(src: Path, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        shutil.rmtree(dest) if dest.is_dir() else dest.unlink()
    (shutil.copytree if src.is_dir() else shutil.copy2)(src, dest)
    print(f'    ✓ {dest} ({size_mb(dest):.1f} MB)')
    return dest


def checkpoint_path(recipe: Recipe) -> str:
    if recipe.checkpoint.endswith('.pt'):
        return recipe.checkpoint  # a local checkpoint (--checkpoint), verbatim
    return f'{recipe.checkpoint}.pt'  # Ultralytics downloads its own assets


# --- Child processes ----------------------------------------------------------
# Every backend runs in its OWN interpreter. On macOS two of them in one process
# abort it: an ONNX export followed by a CoreML export ("libc++abi: mutex lock
# failed"), and OpenVINO beside torch / onnx / tensorflow (each initialises its
# own protobuf). A child per step keeps a crash to that step, reported as a
# failure, and the parent imports none of them.

_CHILD_MARKER = '@@CAMSTACK_CHILD@@'

_ULTRALYTICS_CHILD = f"""
import json, sys
from ultralytics import YOLO
args = json.loads(sys.argv[1])
path = YOLO(args.pop('checkpoint')).export(**args)
print('\\n{_CHILD_MARKER}' + str(path), flush=True)
"""

# Only openvino (and, for INT8, nncf + cv2) is imported here: no torch, no onnx,
# no tensorflow. The conversion is convert_lib's, the same code Model Studio runs.
_OPENVINO_CHILD = f"""
import json, sys
args = json.loads(sys.argv[1])
sys.path.insert(0, args['convert_lib_dir'])
from convert_lib import export_openvino, quantize_openvino_int8, validate_openvino_ir
if args['precision'] == 'int8':
    quantize_openvino_int8(args['onnx'], args['xml'], args['calib_dir'], args['imgsz'],
                           max_samples=args['calib_samples'])
else:
    export_openvino(args['onnx'], args['xml'], fp16=args['precision'] == 'fp16')
validate_openvino_ir(args['xml'])
print('\\n{_CHILD_MARKER}' + args['xml'], flush=True)
"""

_COREML_CHECK_CHILD = f"""
import json, sys
import coremltools as ct
import numpy as np
args = json.loads(sys.argv[1])
model = ct.models.MLModel(args['package'])
name = model.get_spec().description.input[0].name
for batch in (1, 4):
    out = model.predict({{name: np.random.rand(batch, 3, args['imgsz'], args['imgsz']).astype(np.float32)}})
    print(f'    batch={{batch}} -> {{getattr(next(iter(out.values())), "shape", "?")}}')
print('\\n{_CHILD_MARKER}ok', flush=True)
"""


def run_child(code: str, payload: dict[str, object], what: str) -> str:
    """Run one backend step in a fresh interpreter; return what it reported.

    The step counts as done only when the child printed its marker line; a
    child that crashes (a signal, an abort) before that is a failed step and is
    never retried.
    """
    proc = subprocess.run(
        [sys.executable, '-c', code, json.dumps(payload)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    marked = [ln[len(_CHILD_MARKER):] for ln in proc.stdout.splitlines() if ln.startswith(_CHILD_MARKER)]
    if not marked:
        sys.stdout.write('\n'.join(proc.stdout.splitlines()[-25:]) + '\n')
        raise RuntimeError(f'{what} failed (child exit {proc.returncode})')
    if proc.returncode != 0:
        print(f'  ! {what}: the child exited {proc.returncode} after finishing')
    return marked[-1]


def ultralytics_export(checkpoint: str, **kwargs: object) -> Path:
    path = Path(run_child(_ULTRALYTICS_CHILD, {'checkpoint': checkpoint, **kwargs},
                          f'ultralytics export {kwargs} of {checkpoint}'))
    if not path.exists():
        raise RuntimeError(f'ultralytics export reported {path}, which does not exist')
    return path


# --- Format steps -------------------------------------------------------------


def build_onnx(recipe: Recipe, out: Path) -> Path:
    dest = out / recipe.folder / 'onnx' / f'{recipe.name}.onnx'
    assert recipe.onnx is not None
    print(f'  → ONNX (imgsz={recipe.imgsz}, dynamic={recipe.onnx.dynamic}, opset={recipe.onnx.opset})')
    src = ultralytics_export(
        checkpoint_path(recipe), format='onnx', imgsz=recipe.imgsz,
        dynamic=recipe.onnx.dynamic, simplify=True, opset=recipe.onnx.opset,
        nms=False, batch=1, half=False,
    )
    return place(src, dest)


def build_coreml(recipe: Recipe, out: Path, verify: bool) -> Path:
    assert recipe.coreml is not None
    c = recipe.coreml
    print(f'  → CoreML (imgsz={recipe.imgsz}, dynamic={c.dynamic}, batch={c.batch}, half={c.half})')
    src = ultralytics_export(
        checkpoint_path(recipe), format='coreml', imgsz=recipe.imgsz,
        dynamic=c.dynamic, batch=c.batch, half=c.half, nms=False,
    )
    dest = place(src, out / recipe.folder / 'coreml' / f'{recipe.name}.mlpackage')
    if verify and c.dynamic:
        verify_coreml_batch(dest, recipe.imgsz)
    return dest


def build_openvino(recipe: Recipe, onnx_path: Path, out: Path, calib_dir: Path,
                   calib_samples: int) -> list[str]:
    """Every IR of the recipe, each in its own child. Returns the outputs it skipped."""
    skipped: list[str] = []
    for ov in recipe.openvino:
        xml = out / recipe.folder / 'openvino' / f'{recipe.name}{ov.suffix}.xml'
        if ov.precision == 'int8' and not (calib_dir.is_dir() and any(calib_dir.iterdir())):
            print(f'  ⊘ {xml.name}: no calibration images in {calib_dir} (--calib-dir)')
            skipped.append(str(xml))
            continue
        detail = f'NNCF, {calib_samples} images from {calib_dir}' if ov.precision == 'int8' else 'ov.convert_model'
        print(f'  → OpenVINO {ov.precision.upper()} {xml.name} ({detail})')
        xml.parent.mkdir(parents=True, exist_ok=True)
        run_child(_OPENVINO_CHILD, {
            'convert_lib_dir': str(_CONVERT_LIB_DIR), 'onnx': str(onnx_path.resolve()),
            'xml': str(xml.resolve()), 'precision': ov.precision, 'imgsz': recipe.imgsz,
            'calib_dir': str(calib_dir.resolve()), 'calib_samples': calib_samples,
        }, f'OpenVINO {ov.precision} {xml.name}')
        print(f'    ✓ {xml} ({size_mb(xml.with_suffix(".bin")):.1f} MB)')
    return skipped


def verify_coreml_batch(mlpackage: Path, imgsz: int) -> None:
    """Predict with N=1 then N=4 on a flexible-batch package, in a throwaway child.

    Opt-in (--verify-coreml): CoreML's runtime has aborted the whole process on
    one of these packages (Espresso gather_nd shape computation) on a Mac whose
    toolchain differs from the recorded one. A crash here is a failed CHECK, not
    a failed build — the package on disk is the export's output either way.
    """
    try:
        run_child(_COREML_CHECK_CHILD, {'package': str(mlpackage.resolve()), 'imgsz': imgsz},
                  f'CoreML batch check of {mlpackage.name}')
        print('    ✓ flexible batch predicts at N=1 and N=4')
    except RuntimeError as exc:
        print(f'  ! {exc}; the package is kept, check it on the target device')


# --- Orchestration ------------------------------------------------------------


@dataclass
class Report:
    failed: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


def run_step(report: Report, label: str, step: Callable[[], object]) -> object:
    try:
        return step()
    except Exception as exc:  # one failed format must not stop the others
        print(f'  ✗ {label} failed: {exc}')
        report.failed.append(label)
        return None


def build(recipe: Recipe, formats: set[str], out: Path, calib_dir: Path,
          calib_samples: Optional[int], verify_coreml: bool, report: Report,
          reuse_onnx: bool = False) -> None:
    print('\n' + '=' * 70 + f'\n{recipe.name}  ({recipe.folder}, {recipe.imgsz}×{recipe.imgsz})\n' + '=' * 70)
    if recipe.note:
        print(f'  {recipe.note}')
    warn_toolchain(recipe)
    onnx_path: Optional[Path] = None
    existing_onnx = out / recipe.folder / 'onnx' / f'{recipe.name}.onnx'
    if reuse_onnx and recipe.onnx and existing_onnx.is_file():
        print(f'  → ONNX: reusing {existing_onnx} (--reuse-onnx)')
        onnx_path = existing_onnx
    elif formats & {'onnx', 'openvino'} and recipe.onnx:
        result = run_step(report, f'{recipe.name} onnx', lambda: build_onnx(recipe, out))
        onnx_path = result if isinstance(result, Path) else None
    if 'coreml' in formats and recipe.coreml is not None:
        if sys.platform != 'darwin':
            print('  ⊘ CoreML needs macOS')
            report.skipped.append(f'{recipe.name} coreml')
        else:
            run_step(report, f'{recipe.name} coreml', lambda: build_coreml(recipe, out, verify_coreml))
    if 'openvino' in formats and recipe.openvino and onnx_path is not None:
        samples = calib_samples or recipe.calib_samples or 300
        skipped = run_step(report, f'{recipe.name} openvino',
                           lambda: build_openvino(recipe, onnx_path, out, calib_dir, samples))
        report.skipped.extend(skipped if isinstance(skipped, list) else [])


def adhoc_recipe(args: argparse.Namespace) -> Recipe:
    """A recipe from the command line, for a size/resolution the mirror does not host."""
    precisions = [p for p in (args.openvino or 'fp16,int8').split(',') if p]
    bad = [p for p in precisions if p not in ('fp32', 'fp16', 'int8')]
    if bad:
        sys.exit(f'--openvino accepts fp32, fp16, int8; got {bad}')
    if args.checkpoint is not None:
        local = Path(args.checkpoint).expanduser().resolve()
        if not local.is_file() or local.suffix != '.pt':
            sys.exit(f'--checkpoint {args.checkpoint}: not a .pt file')
        checkpoint, stem = str(local), local.stem
    else:
        checkpoint, stem = args.model, args.model
    name = args.name or f'camstack-{stem}-{args.imgsz}'
    coreml_dynamic = args.dynamic and args.checkpoint is None
    return Recipe(
        name=name, folder=args.folder, imgsz=args.imgsz,
        toolchain=Toolchain('any', 'any', 'any', 'any'), checkpoint=checkpoint,
        onnx=OnnxExport(dynamic=args.dynamic, opset=args.opset),
        # A local checkpoint's architecture is not in its name, so the D742
        # check cannot tell a YOLO26 fine-tune: its CoreML export is always
        # static, the shape every architecture loads.
        coreml=CoremlExport(dynamic=coreml_dynamic, batch=16 if coreml_dynamic else 1, half=True),
        openvino=tuple(OpenvinoOutput(f'-{p}', p) for p in precisions),
        calib_samples=args.calib_samples or 300,
    )


def hosted_weight_paths() -> list[str]:
    url = f'https://huggingface.co/api/models/{HF_REPO}/tree/main?recursive=true'
    with urllib.request.urlopen(url, timeout=60) as resp:
        tree = json.load(resp)
    prefixes = tuple(f'{f}/' for f in FAMILIES.values())
    return sorted(
        e['path'] for e in tree
        if e['type'] == 'file' and e['path'].startswith(prefixes) and not e['path'].endswith('README.md')
    )


def check_hosted() -> int:
    """Every hosted AGPL weight file is an output of a recipe, and vice versa."""
    hosted = hosted_weight_paths()
    outputs = [o for r in RECIPES for o in r.outputs()]

    def covered(path: str) -> bool:
        return any(path == o or (o.endswith('/') and path.startswith(o)) for o in outputs)

    def present(output: str) -> bool:
        return any(h == output or (output.endswith('/') and h.startswith(output)) for h in hosted)

    orphans = [h for h in hosted if not covered(h)]
    unhosted = [o for o in outputs if not present(o)]
    print(f'{len(hosted)} hosted files under {", ".join(FAMILIES.values())}; '
          f'{len(RECIPES)} recipes, {len(outputs)} outputs')
    for h in orphans:
        print(f'  NOT REPRODUCED by any recipe: {h}')
    for o in unhosted:
        print(f'  recipe output not hosted: {o}')
    if orphans or unhosted:
        return 1
    print('OK: every hosted file is a recipe output, and every recipe output is hosted.')
    return 0


def list_recipes() -> None:
    for r in RECIPES:
        ov = ','.join(f'{o.precision}{"→" + o.suffix if o.suffix else ""}' for o in r.openvino)
        onnx = f'{"dynamic" if r.onnx and r.onnx.dynamic else "static"} opset{r.onnx.opset if r.onnx else ""}'
        cm = (f'{"flex≤" + str(r.coreml.batch) if r.coreml.dynamic else "static"}'
              f'{" fp16" if r.coreml.half else ""}') if r.coreml else '-'
        int8 = f' int8 N={r.calib_samples}' if any(o.precision == 'int8' for o in r.openvino) else ''
        print(f'{r.name:30s} {r.folder:28s} {r.imgsz:4d}  onnx[{onnx}] coreml[{cm}] '
              f'openvino[{ov}]{int8}  '
              f'ultralytics {r.toolchain.ultralytics}  from {r.checkpoint}.pt')


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sel = p.add_argument_group('what to build')
    sel.add_argument('--all', action='store_true', help='every hosted recipe')
    sel.add_argument('--family', action='append', choices=sorted(FAMILIES), help='one mirror folder')
    sel.add_argument('--variant', action='append', help='a hosted file stem, e.g. camstack-yolov9m-320')
    sel.add_argument('--list', action='store_true', help='print the recipes and exit')
    sel.add_argument('--check-hosted', action='store_true',
                     help='compare the recipes with the live mirror and exit (non-zero on a gap)')
    sel.add_argument('--dry-run', action='store_true', help='print the files that would be built')
    p.add_argument('--formats', default=','.join(ALL_FORMATS), help='subset of onnx,coreml,openvino')
    p.add_argument('--out', type=Path, default=Path('exported-models'))
    p.add_argument('--calib-dir', type=Path, default=DEFAULT_CALIB_DIR)
    p.add_argument('--verify-coreml', action='store_true',
                   help='predict N=1 and N=4 on each flexible-batch CoreML package (in a child process)')
    p.add_argument('--calib-samples', type=int, help="override the recipe's INT8 calibration image count")
    p.add_argument('--reuse-onnx', action='store_true',
                   help='an ONNX already at its mirror path under --out is used as is, not re-exported: '
                        'download the hosted ONNX there to re-quantise an IR from the exact graph the '
                        'mirror serves (no Ultralytics needed)')
    adhoc = p.add_argument_group('ad-hoc build (not a hosted file)')
    source = adhoc.add_mutually_exclusive_group()
    source.add_argument('--model', help='Ultralytics id, e.g. yolo26n, yolov9m, yolo26s-seg')
    source.add_argument('--checkpoint',
                        help='a local .pt (e.g. a fine-tune), exported exactly like --model; '
                             'pair with --calib-dir <your frames> for its INT8 IR')
    adhoc.add_argument('--imgsz', type=int, default=640)
    adhoc.add_argument('--name', help='output stem (default camstack-<model>-<imgsz>)')
    adhoc.add_argument('--folder', default='custom')
    adhoc.add_argument('--dynamic', action='store_true', help='dynamic axes (ONNX) / flexible batch (CoreML)')
    adhoc.add_argument('--opset', type=int, default=17)
    adhoc.add_argument('--openvino', help='IR precisions, comma-separated: fp32,fp16,int8')
    return p.parse_args(argv)


def select(args: argparse.Namespace) -> list[Recipe]:
    if args.model or args.checkpoint:
        return [adhoc_recipe(args)]
    by_name = {r.name: r for r in RECIPES}
    unknown = [v for v in (args.variant or []) if v not in by_name]
    if unknown:
        sys.exit(f'unknown --variant {unknown}; see --list')
    folders = {FAMILIES[f] for f in (args.family or [])}
    return [r for r in RECIPES
            if args.all or r.folder in folders or r.name in (args.variant or [])]


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    bad = check_recipes(RECIPES)
    if bad:
        print('\n'.join(bad))
        return 2
    if args.list:
        list_recipes()
        return 0
    if args.check_hosted:
        return check_hosted()
    recipes = select(args)
    bad = check_recipes(tuple(recipes))  # an ad-hoc --model yolo26* --dynamic too
    if bad:
        print('\n'.join(bad))
        return 2
    if not recipes:
        print('Nothing selected: pass --all, --family, --variant or --model (see --help).')
        return 2
    formats = {f for f in args.formats.split(',') if f}
    if formats - set(ALL_FORMATS):
        sys.exit(f'--formats accepts {",".join(ALL_FORMATS)}')
    if args.dry_run:
        for r in recipes:
            for o in r.outputs():
                print(args.out / o)
        return 0
    report = Report()
    for r in recipes:
        build(r, formats, args.out, args.calib_dir, args.calib_samples,
              args.verify_coreml, report, reuse_onnx=args.reuse_onnx)
    print('\nDone.' + (f' Failed: {report.failed}.' if report.failed else '')
          + (f' Skipped: {report.skipped}.' if report.skipped else ''))
    return 1 if report.failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
