"""``python -m camstack_train run|dataset``.

``run``: one job. The hub's provider starts the container with
``--job /data/job.json --dataset /data/dataset.tar --out /data/out --cache /cache``.
``dataset``: the export → YOLO layout only, for training by hand.

Exit codes: 0 ok, 64 bad job.json, 65 dataset unusable, 70 internal.
"""
from __future__ import annotations

import argparse
import tempfile
from pathlib import Path
from typing import Optional, Sequence

from .dataset import extract_archive, frames_from_manifest, write_layout
from .errors import EXIT_BAD_SPEC, EXIT_OK, TrainerError
from .events import Emitter
from .manifest import failed_result, write_result
from .run import Deps, Paths, run_job
from .spec import job_key_of, load_job


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="camstack_train", description="CamStack detector trainer")
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="run one training job")
    run.add_argument("--job", type=Path, required=True)
    run.add_argument("--dataset", type=Path, required=True)
    run.add_argument("--out", type=Path, required=True)
    run.add_argument("--cache", type=Path, required=True)
    run.add_argument("--work", type=Path, default=None, help="scratch dir (default: a temp dir)")
    ds = sub.add_parser("dataset", help="convert a hub export to a YOLO layout (all frames → train)")
    ds.add_argument("--export", type=Path, required=True)
    ds.add_argument("--out", type=Path, required=True)
    return parser


def _run(args: argparse.Namespace, deps: Optional[Deps]) -> int:
    emitter = deps.emitter if deps is not None else Emitter()
    try:
        job = load_job(args.job)
    except TrainerError as exc:
        emitter.error(exc.stage, exc.code, exc.message)
        digest = write_result(args.out / "result.json", failed_result(job_key_of(args.job), exc.as_dict()))
        emitter.done("failed", digest)
        return EXIT_BAD_SPEC
    work = args.work or Path(tempfile.mkdtemp(prefix="camstack-train-"))
    paths = Paths(job=args.job, dataset=args.dataset, out=args.out, cache=args.cache, work=work)
    return run_job(job, paths, deps)


def _dataset(args: argparse.Namespace) -> int:
    source = args.out / "export"
    manifest = extract_archive(args.export, source)
    frames = [f for f in frames_from_manifest(manifest) if f.trainable]
    counts = write_layout({"train": frames}, source, args.out / "yolo")
    print(f"{counts.frames.get('train', 0)} frames, {counts.boxes.get('train', 0)} boxes → {args.out / 'yolo'}")
    return EXIT_OK


def main(argv: Optional[Sequence[str]] = None, deps: Optional[Deps] = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "run":
        return _run(args, deps)
    try:
        return _dataset(args)
    except TrainerError as exc:
        print(f"{exc.code}: {exc.message}")
        return exc.exit_code
