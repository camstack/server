#!/usr/bin/env python3
"""Evaluate a candidate root detector against the baseline on a holdout.

    python scripts/eval/evaluate.py \\
      --export camstack-retrain.tar \\
      --baseline yolov9m-640.onnx --baseline-size 640 --baseline-model-id yolov9m-640-int8 \\
      --candidate custom-640.onnx --candidate-size 640 \\
      --holdout-cameras 101,102 --out report.json

- Ground truth: the hub's annotated export (`getRetrainExportUrl` /
  `writeRetrainArchive`), COMPLETE frames only unless --include-incomplete.
- Both models run through the pipeline's own letterbox + YOLO decode
  (`camstack_eval/pipeline.py`), on ONNX Runtime CPU.
- Baseline floors: --baseline-floors person=0.55,... or the measured row of
  --baseline-model-id in docs/benchmarks/model-floors.json (the catalog's
  floors, D739).
- Candidate floors: proposed by the D739 rule (lowest floor within the
  baseline's false-positive budget), with --min-support and --clamp guards.

Prints a table and writes the full JSON report (--out).
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from camstack_eval.classes import DETECTOR_CLASSES  # noqa: E402
from camstack_eval.compare import compare_models, select_holdout  # noqa: E402
from camstack_eval.dataset import load_export  # noqa: E402
from camstack_eval.floors import FloorPolicy  # noqa: E402
from camstack_eval.pipeline import REPO_ROOT, OnnxDetector  # noqa: E402

MODEL_FLOORS = REPO_ROOT / "docs" / "benchmarks" / "model-floors.json"
GLOBAL_FLOORS = {"person": 0.65, "vehicle": 0.5, "animal": 0.5}


def parse_floors(text: str) -> dict[str, float]:
    out = {}
    for part in text.split(","):
        name, _, value = part.partition("=")
        out[name.strip()] = float(value)
    return out


def measured_floors(model_id: str) -> dict[str, float]:
    table = json.loads(MODEL_FLOORS.read_text("utf-8"))
    row = table.get(model_id)
    if row is None:
        raise SystemExit(f"{model_id} has no row in {MODEL_FLOORS}; pass --baseline-floors")
    return {c: float(row[c]["floor"]) for c in DETECTOR_CLASSES if c in row}


def fmt(value) -> str:
    return "  -  " if value is None else f"{value:.3f}"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--export", required=True, help="annotated export tar, or its extracted directory")
    p.add_argument("--baseline", required=True)
    p.add_argument("--baseline-size", type=int, required=True)
    p.add_argument("--candidate", required=True)
    p.add_argument("--candidate-size", type=int, required=True)
    p.add_argument("--baseline-floors", help="person=0.55,vehicle=0.4,animal=0.5")
    p.add_argument("--baseline-model-id", help="read baseline floors from model-floors.json")
    p.add_argument("--candidate-floors", help="evaluate the candidate at these instead of proposing")
    p.add_argument("--holdout-cameras", help="comma-separated device ids")
    p.add_argument("--since", help="ISO date: only frames captured at or after it")
    p.add_argument("--include-incomplete", action="store_true")
    p.add_argument("--min-support", type=int, default=20)
    p.add_argument("--clamp", type=float, default=0.15)
    p.add_argument("--out", help="write the JSON report here")
    args = p.parse_args(argv)

    if args.baseline_floors:
        base_floors = parse_floors(args.baseline_floors)
    elif args.baseline_model_id:
        base_floors = measured_floors(args.baseline_model_id)
    else:
        base_floors = dict(GLOBAL_FLOORS)
    base_floors = {**GLOBAL_FLOORS, **base_floors}

    frames = load_export(args.export, complete_only=not args.include_incomplete)
    cameras = [int(c) for c in args.holdout_cameras.split(",")] if args.holdout_cameras else None
    since = int(datetime.fromisoformat(args.since).timestamp() * 1000) if args.since else None
    holdout = select_holdout(frames, cameras=cameras, since=since)
    if not holdout:
        print("no frame in the holdout — nothing to evaluate", file=sys.stderr)
        return 2

    report = compare_models(
        holdout,
        baseline=OnnxDetector(args.baseline, args.baseline_size).detect,
        candidate=OnnxDetector(args.candidate, args.candidate_size).detect,
        baseline_floors=base_floors,
        candidate_floors=parse_floors(args.candidate_floors) if args.candidate_floors else None,
        policy=FloorPolicy(min_support=args.min_support, clamp=args.clamp),
    )
    report["inputs"] = {
        "export": args.export,
        "baseline": args.baseline,
        "candidate": args.candidate,
        "baselineFloors": base_floors,
        "holdoutCameras": cameras,
        "since": args.since,
        "completeOnly": not args.include_incomplete,
    }

    print(f"{len(holdout)} holdout frames")
    print(f"{'class':8} {'model':9} {'floor':>5} {'P':>6} {'R':>6} {'AP50':>6} {'night R':>8} {'small':>7}")
    for cls, row in report["classes"].items():
        for name in ("baseline", "candidate"):
            m = row[name]
            night = m["recallByLight"].get("night")
            print(
                f"{cls:8} {name:9} {m['floor']:5.2f} {fmt(m['precision']):>6} {fmt(m['recall']):>6} "
                f"{fmt(m['ap50']):>6} {fmt(night):>8} {m['smallFound']:>3}/{m['smallTotal']:<3}"
            )
        pf = row["proposedFloor"]
        print(f"{'':8} proposed floor {pf['value']:.2f} ({pf['reason']}, FP budget {pf['fpBudget']})")
    if args.out:
        Path(args.out).write_text(json.dumps(report, indent=2), "utf-8")
        print(f"report: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
