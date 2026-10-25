---
license: agpl-3.0
tags:
  - object-detection
  - yolov9
  - training
  - camstack
library_name: ultralytics
---

<!-- Tracked in camstack/server as hf/camstack-trainer/; edit it there, not on the Hub. The vendored code under camstack_train/_vendor/ is a byte-identical copy of camstack/server sources, guarded by scripts/check-trainer-vendor.ts. -->

# CamStack trainer

The container a [CamStack](https://camstack-docs.zentik.app) hub runs on a
cloud GPU (Modal first) to fine-tune its YOLOv9 root detector on the operator's
own annotated frames. It evaluates the result against the model the cameras
run today, proposes per-class confidence floors, and exports every format a
CamStack node runs (ONNX, OpenVINO FP16 and INT8, Core ML FP16).

**Licence: AGPL-3.0.** It imports Ultralytics (AGPL-3.0), and a model it
fine-tunes is an Ultralytics derivative. The hub never imports this package: it
talks to the container through files and a process boundary only. This
repository, Dockerfile included, is the Corresponding Source of every image
built from it.

## The contract

In:

- `/data/job.json` — schema `camstack.training/v1`, every field filled by the
  hub ([`schemas/job.schema.json`](schemas/job.schema.json)). An unknown schema
  exits 64.
- `/data/dataset.tar` — the hub's annotated export
  (`camstack.retrain-export/v2|v3`), verified against `dataset.sha256`.
- `/cache` — a persistent volume: base weights, the COCO replay slice, the
  baseline ONNX.

Out, in `/data/out`:

- `bundle.tar` — every artefact under its flat catalog name:
  `<id>.pt`, `<id>.onnx`, `<id>-fp16.xml/.bin`, `<id>-int8.xml/.bin`,
  `<id>.mlpackage/`.
- `result.json` — schema `camstack.training-result/v1`
  ([`schemas/result.schema.json`](schemas/result.schema.json)): the dataset
  split, training summary, baseline vs candidate evaluation, proposed floors,
  the INT8 gate, one row per bundled file with its sha256, and a
  `catalogDraft` (a `ModelCatalogEntry` per variant, relative URLs, revisions).
  Written on failure too.

Progress: one `CAMSTACK_EVENT {json}` line per event on stdout — `stage`,
`epoch`, `metric`, `artifact`, `error`, and a final `done` carrying the sha256
of `result.json`. Every event has `v: 1` and `ts` (epoch ms).

Exit codes: 0 ok · 64 bad job · 65 dataset unusable · 70 internal.

## What it does

1. **Prepare** — verify the archive, convert it to a YOLO layout (COCO-80 ids;
   a vehicle/animal box needs a COCO `label` or its frame is left out of
   training; `model_error` boxes are learned as background), and split it by
   whole cameras or whole days, never by random frame.
2. **Replay** — mix a pinned slice of COCO val2017 back in so the 80-class head
   is not forgotten.
3. **Train** — Ultralytics `YOLO(<base>.pt).train(...)` with the job's
   epochs / batch / lr0 / freeze / patience / seed.
4. **Export** — ONNX (static, opset 13), OpenVINO FP16, OpenVINO INT8
   calibrated on the user's own train frames letterboxed exactly like the
   runtime, Core ML FP16. A failing optional format is dropped with its
   reason; ONNX failing fails the job.
5. **Evaluate** — the CamStack evaluation harness (vendored from
   `scripts/eval/`) runs the baseline and the candidate with the inference
   pool's own preprocess and decode on the complete holdout frames, and the
   D739 rule proposes floors. INT8 is dropped when its mAP50 falls more than
   `int8Gate.maxMap50Drop` below FP16.
6. **Package** — `bundle.tar` + `result.json`.

Logs carry counts only — never a frame path or a camera name.

## Running it yourself

```bash
docker build --platform linux/amd64 --build-arg TRAINER_REVISION=main -t camstack-trainer .
docker run --gpus all -v $PWD/data:/data -v $PWD/cache:/cache camstack-trainer \
  python -m camstack_train run --job /data/job.json --dataset /data/dataset.tar --out /data/out --cache /cache
```

Without Docker (`pip install ".[train,export]"` into an environment that has
torch), the same command runs as is. To only convert an export for training by
hand:

```bash
python -m camstack_train dataset --export camstack-retrain.tar --out ./yolo-dataset
```

Tests (no torch, Ultralytics or OpenVINO needed): `pip install ".[test]" && pytest`.
