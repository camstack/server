---
id: D743
title: A CoreML export is FP16, and an artefact replaced in place carries a catalog revision
status: accepted
date: 2026-10-07
supersedes:
applies-to:
  - scripts/build-camstack-models.py
  - packages/types/src/types/models.ts
  - packages/system/src/download/model-downloader.ts
  - packages/addon-pipeline/src/detection-pipeline/registry/model-catalogs.ts
---

## Context

On an M3 Pro, the hosted YOLOv9 CoreML packages never ran on the Neural
Engine. `CPU_AND_NE` ran them at CPU speed (`yolov9m-320` 41 ms) and `ALL`
put them on the GPU (9 ms, the same as `CPU_AND_GPU`). The YOLO26 packages ran
on the Neural Engine, 2–4× faster than a YOLOv9 of the same accuracy. The
YOLOv9 packages were FP32 (77 MB for `yolov9m-320`, the size of its ONNX), and
the Neural Engine computes in FP16 only.

The cause was the recipe, copied from YOLO26 @640: `half=False`. Under
Ultralytics 8.4.24 that left coremltools' ML Program default, FP16, in place;
the YOLO26 @640 and YOLO26-seg packages record `half: False` and are FP16.
Ultralytics 8.4.98, which built the YOLOv9 packages, pins
`compute_precision=FLOAT32` unless FP16 is asked for. Nothing checked the
precision of what came out.

The FP16 re-export runs on the Neural Engine with no op left behind (the DFL
head included). Measured `ALL` p50 on the M3 Pro, FP32 → FP16:
`yolov9t-320` 5.1 → 1.1 ms, `yolov9s-640` 12.0 → 5.1, `yolov9m-320` 9.0 → 3.2,
`yolov9m-640` 27.3 → 10.2, `yolov9c-640` 32.0 → 12.1. `ALL` equals
`CPU_AND_NE` within noise and is 2–3× faster than `CPU_AND_GPU`. The batch
shape was not the blocker: a batch-flexible FP16 export also runs on the Neural
Engine (3.8 ms). Against the hosted ONNX, 97–99.7 % of detections match (60
COCO val2017 images and 408 hub frames, mean |Δscore| ≤ 0.01), and every
accuracy cell at the shipped floors is within 0.03 of the ONNX row.

The operator wanted the packages replaced in place: same paths, no new names,
no aliases. But a same-path upload never reaches a node that has the file:
`ensureModel` returns early for a path that exists, with no hash, size or
mtime check. D742 hit this and accepted it, because no node held the replaced
YOLO26 packages. Here the Mac default detector is `yolov9m-320`, and the Mac
mini node holds its FP32 copy. Renaming was ruled out, and deleting files on
nodes by hand does not scale.

## Decision

Every CoreML export is FP16. Every CoreML recipe in
`scripts/build-camstack-models.py` sets `half=True`, and ad-hoc builds always
do.

A catalog format whose bytes were replaced in place names a `revision`
(`ModelFormatEntry.revision`). The node writes the revision it downloaded to
`<file>.revision` next to the file or bundle. A copy with no record, or a
different one, is stale: `isModelDownloaded` answers false, and `ensureModel`
downloads the new bytes and swaps them in only when all of them arrived. A
format without a `revision` behaves as before. The YOLOv9 CoreML entries use
the sha256 of the package's `weight.bin` on the mirror as their revision.

## Consequences

- Every node that holds a YOLOv9 CoreML package downloads it once more
  (4–49 MB), including nodes that already got the FP16 bytes before the
  catalog shipped: they have no record. The old copy serves until the new one
  is complete. A pool that already loaded a model keeps it until it reloads.
- The new package has a new compiled-cache fingerprint and a new load-probe
  verdict (D742), so its first load compiles and probes once.
- Replacing any hosted artefact in place now means changing its `revision`
  in the same catalog change. Without it, nodes keep the old bytes silently.
- The record sits outside the bundle, so model distribution (which tars the
  bundle) does not carry it. A distributed copy of a revisioned format is
  fetched again from the mirror once. The custom models it is used for have no
  revision.
- `ModelDownloadService` (the CLIP models) does not read `revision`.
- The YOLO26 @320/@256 CoreML packages replaced under D742 carry no revision;
  a node holding a crashing copy still needs the file deleted.

## Enforcement

- `scripts/test_build_camstack_models.py`: `check_recipes` refuses an FP32
  CoreML recipe, and every hosted recipe and ad-hoc build is FP16.
  `check_recipes` runs on every invocation of the build script (exit 2).
- `packages/system/__tests__/model-downloader.test.ts`: a copy with no or a
  different record is stale and is fetched again; a current one costs no
  request; a failed fetch keeps the old copy; an outdated main file is never
  paired with a new sibling.
- `model-catalogs-yolov9-coreml-fp16.spec.ts`: each YOLOv9 CoreML entry keeps
  its file name, names its own sha256 revision, and is about half its ONNX
  size.
- That a revision matches the hosted bytes is review only: compare it with the
  `lfs.oid` of `weight.bin` in the Hugging Face tree API.
