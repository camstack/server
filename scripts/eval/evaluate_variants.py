#!/usr/bin/env python3
"""Evaluate variants of ONE detector (e.g. old INT8, new INT8, float) on one set.

    python scripts/eval/evaluate_variants.py \\
      --coco instances_val2017.json --images val2017 --skip 300 --limit 1000 \\
      --model old=yolov9m-640-int8.old.xml@640 --model new=yolov9m-640-int8.xml@640 \\
      --model fp16=yolov9m-640-fp16.xml@640 \\
      --baseline old --floors person=0.55,vehicle=0.4,animal=0.7 \\
      --cache dets/ --out report.json

- Sets: COCO (`--coco` + `--images`; `--skip` the calibration images, which
  come first in file-name order), a pseudo ground truth (`--pseudo-gt`, schema
  `camstack.pseudo-gt/v1`) or the hub's annotated export (`--export`).
- A model is ``label=path@size``; an ``.xml`` runs on OpenVINO (CPU, FP32, the
  pool's own PrePostProcessor), anything else on ONNX Runtime CPU.
- ``--cache``: each model's raw detections are stored per set and re-used, so
  models can be run in separate processes (``--run-only``) — e.g. INT8 IRs on
  an x86 interpreter and float models natively — and reported together.
- Report per macro class: P/R at ``--floors`` (the baseline's shipped floors),
  AP50 and AP50-95, and for every other model the paired-bootstrap 95 %
  interval of its AP difference to the baseline (`camstack_eval/bootstrap.py`).
- ``--budget-model``/``--budget-floors``: the D739 floor each model gets
  against that reference's false-positive budget (default: the baseline at
  ``--floors``).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from camstack_eval.bootstrap import AP50, AP50_95, ap_rounds, draw_weights, paired_delta  # noqa: E402
from camstack_eval.classes import DETECTOR_CLASSES, to_macro  # noqa: E402
from camstack_eval.dataset import EvalFrame, load_coco, load_export, load_pseudo_gt  # noqa: E402
from camstack_eval.floors import FloorPolicy, ScoredDetection, propose_floor  # noqa: E402
from camstack_eval.metrics import (  # noqa: E402
    COCO_IOUS,
    Detection,
    evaluate_class,
    frame_matches,
    scored_detections,
)


def parse_floors(text: str) -> dict[str, float]:
    out = {}
    for part in text.split(","):
        name, _, value = part.partition("=")
        out[name.strip()] = float(value)
    return out


def parse_model(text: str) -> tuple[str, str, int]:
    label, _, rest = text.partition("=")
    path, _, size = rest.rpartition("@")
    if not label or not path or not size.isdigit():
        raise SystemExit(f"--model {text!r}: expected label=path@size")
    return label, path, int(size)


def dataset_key(args: argparse.Namespace) -> str:
    if args.coco:
        return f"coco-{Path(args.coco).stem}-skip{args.skip}-n{args.limit}"
    if args.pseudo_gt:
        return f"pgt-{Path(args.pseudo_gt).stem}"
    return f"export-{Path(args.export).stem}"


def load_frames(args: argparse.Namespace) -> list[EvalFrame]:
    if args.coco:
        if not args.images:
            raise SystemExit("--coco needs --images")
        return load_coco(args.coco, args.images, skip=args.skip, limit=args.limit)
    if args.pseudo_gt:
        return load_pseudo_gt(args.pseudo_gt, args.images)
    return load_export(args.export, complete_only=not args.include_incomplete)


def weights_digest(path: str) -> str:
    weights = Path(path).with_suffix(".bin") if path.endswith(".xml") else Path(path)
    return hashlib.sha256(weights.read_bytes()).hexdigest()


def detections_for(label: str, path: str, size: int, frames: list[EvalFrame], cache: Path | None,
                   key: str, run: bool) -> dict[str, list[Detection]]:
    digest = weights_digest(path)
    file = cache / f"{key}__{label}.json" if cache else None
    if file is not None and file.is_file():
        stored = json.loads(file.read_text("utf-8"))
        if stored["sha256"] == digest and stored["size"] == size:
            return {fid: [Detection(c, s, tuple(b)) for c, s, b in rows] for fid, rows in stored["frames"].items()}
        print(f"  {label}: cache {file.name} is for other weights — re-running", file=sys.stderr)
    if not run:
        raise SystemExit(f"{label}: no cached detections for {key} (run it first)")
    from camstack_eval.pipeline import make_detector

    detector = make_detector(path, size)
    started = time.time()
    out: dict[str, list[Detection]] = {}
    for i, f in enumerate(frames):
        out[f.truth.frame_id] = list(detector.detect(f.read()))
        if (i + 1) % 100 == 0:
            print(f"  {label}: {i + 1}/{len(frames)} ({(time.time() - started) / (i + 1):.2f} s/frame)",
                  file=sys.stderr, flush=True)
    if file is not None:
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps({
            "model": path, "size": size, "sha256": digest, "set": key,
            "frames": {fid: [[d.cls, round(d.score, 5), [round(v, 6) for v in d.bbox]] for d in dets]
                       for fid, dets in out.items()},
        }))
    return out


def class_report(cls, runs, floor, weights) -> tuple[dict, dict]:
    """Summary at ``floor`` and per-round AP50 / AP50-95 arrays for the bootstrap."""
    result = evaluate_class(cls, runs, floor)
    by_iou = {t: frame_matches(cls, runs, t) for t in COCO_IOUS}
    ap50 = ap_rounds(by_iou, weights, AP50)
    ap5095 = ap_rounds(by_iou, weights, AP50_95)
    summary = {
        "floor": floor,
        "tp": result.tp, "fp": result.fp, "fn": result.fn,
        "precision": result.precision, "recall": result.recall,
        "ap50": None if ap50[0] != ap50[0] else float(ap50[0]),
        "ap5095": None if ap5095[0] != ap5095[0] else float(ap5095[0]),
        "recallByLight": dict(sorted(result.recall_by_light.items())),
    }
    return summary, {"ap50": ap50, "ap5095": ap5095}


def fmt(v) -> str:
    return "  -  " if v is None else f"{v:.3f}"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--coco", help="COCO instances_*.json")
    src.add_argument("--pseudo-gt", help="camstack.pseudo-gt/v1 JSON")
    src.add_argument("--export", help="the hub's annotated export (tar or directory)")
    p.add_argument("--images", help="image folder (COCO; pseudo-GT default: the JSON's folder)")
    p.add_argument("--skip", type=int, default=0, help="COCO: drop the first N images (the calibration set)")
    p.add_argument("--limit", type=int, help="COCO: then keep N images")
    p.add_argument("--include-incomplete", action="store_true")
    p.add_argument("--model", action="append", required=True, help="label=path@size (repeatable)")
    p.add_argument("--cache", type=Path, help="detections cache folder")
    p.add_argument("--run-only", action="store_true", help="compute and cache detections, no report")
    p.add_argument("--no-run", action="store_true", help="report from the cache only")
    p.add_argument("--baseline", help="label the others are compared with (default: the first)")
    p.add_argument("--floors", default="person=0.65,vehicle=0.5,animal=0.5",
                   help="the floors P/R are reported at (the baseline's shipped floors)")
    p.add_argument("--budget-model", help="label whose false positives set the D739 budget")
    p.add_argument("--budget-floors", help="its floors (default --floors)")
    p.add_argument("--min-support", type=int, default=20)
    p.add_argument("--clamp", type=float, default=0.15)
    p.add_argument("--bootstrap", type=int, default=1000)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--out", help="write the JSON report here")
    args = p.parse_args(argv)

    frames = load_frames(args)
    key = dataset_key(args)
    models = [parse_model(m) for m in args.model]
    print(f"{key}: {len(frames)} frames", file=sys.stderr)
    dets = {label: detections_for(label, path, size, frames, args.cache, key, not args.no_run)
            for label, path, size in models}
    if args.run_only:
        return 0

    labels = [m[0] for m in models]
    baseline = args.baseline or labels[0]
    floors = parse_floors(args.floors)
    runs = {label: [(f.truth, to_macro(dets[label][f.truth.frame_id])) for f in frames] for label in labels}
    weights = draw_weights(len(frames), args.bootstrap, args.seed)
    budget_label = args.budget_model or baseline
    budget_floors = parse_floors(args.budget_floors) if args.budget_floors else floors
    policy = FloorPolicy(min_support=args.min_support, clamp=args.clamp)

    report: dict = {"set": key, "frames": len(frames), "baseline": baseline, "floors": floors,
                    "budget": {"model": budget_label, "floors": budget_floors},
                    "bootstrapRounds": args.bootstrap, "models": {}, "classes": {}}
    for label, path, size in models:
        report["models"][label] = {"path": path, "size": size}
    rounds: dict = {}
    for cls in DETECTOR_CLASSES:
        row: dict = {}
        budget_scored, positives = scored_detections(cls, runs[budget_label])
        for label in labels:
            summary, rounds[(label, cls)] = class_report(cls, runs[label], floors[cls], weights)
            scored, _ = scored_detections(cls, runs[label])
            proposed = propose_floor(
                [ScoredDetection(d.score, d.true_positive) for d in budget_scored], budget_floors[cls],
                [ScoredDetection(d.score, d.true_positive) for d in scored], positives, policy)
            summary["d739Floor"] = {"value": proposed.value, "reason": proposed.reason,
                                    "fitted": proposed.fitted, "fpBudget": proposed.fp_budget}
            row[label] = summary
        row["positives"] = positives
        report["classes"][cls] = row
    report["mean"] = {}
    for label in labels:
        mean = {m: sum(rounds[(label, c)][m] for c in DETECTOR_CLASSES) / len(DETECTOR_CLASSES)
                for m in ("ap50", "ap5095")}
        rounds[(label, "mean")] = mean
        report["mean"][label] = {m: float(v[0]) for m, v in mean.items()}
    report["deltas"] = {}
    for label in labels:
        if label == baseline:
            continue
        report["deltas"][label] = {
            scope: {m: (d.as_dict() if (d := paired_delta(rounds[(baseline, scope)][m],
                                                          rounds[(label, scope)][m])) else None)
                    for m in ("ap50", "ap5095")}
            for scope in (*DETECTOR_CLASSES, "mean")
        }

    print(f"{key}: {len(frames)} frames, baseline {baseline}")
    print(f"{'class':8} {'model':10} {'floor':>5} {'P':>6} {'R':>6} {'AP50':>6} {'AP50-95':>8} {'D739':>5}")
    for cls in DETECTOR_CLASSES:
        for label in labels:
            m = report["classes"][cls][label]
            print(f"{cls:8} {label:10} {m['floor']:5.2f} {fmt(m['precision']):>6} {fmt(m['recall']):>6} "
                  f"{fmt(m['ap50']):>6} {fmt(m['ap5095']):>8} {m['d739Floor']['value']:5.2f}")
    for label, scopes in report["deltas"].items():
        mean = scopes["mean"]
        print(f"{label} - {baseline}: mAP50 {mean['ap50']['delta']:+.4f} {mean['ap50']['ci95']}, "
              f"mAP50-95 {mean['ap5095']['delta']:+.4f} {mean['ap5095']['ci95']}")
    if args.out:
        Path(args.out).write_text(json.dumps(report, indent=2), "utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
