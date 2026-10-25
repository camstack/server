---
id: D742
title: A CoreML package is loaded once in a child before the pool loads it, and a YOLO26 CoreML export is static
status: accepted
date: 2026-10-07
supersedes:
applies-to:
  - packages/addon-pipeline/python/coreml_load_probe.py
  - packages/addon-pipeline/python/inference_pool.py
  - packages/addon-pipeline/src/detection-pipeline/registry/model-catalogs.ts
  - scripts/build-camstack-models.py
---

## Context

On an M3 Pro (macOS 26.2), the hosted YOLO26 @320 and @256 CoreML packages
abort any process that loads them. The process gets SIGABRT from libmalloc
("pointer being freed was not allocated") inside
`Espresso::generic_gather_nd_kernel::top_shapes_for_bottom_shapes`, called
from `MLModel` load. This happens on every compute unit (ALL, CPU_AND_NE,
CPU_AND_GPU, CPU_ONLY), with coremltools 8.3 and 9.0, and also when the model
is compiled with `xcrun coremlcompiler` and loaded as a `CompiledMLModel`.

The trigger is two facts together:

- These are the only hosted packages with a batch-flexible input (a
  `shapeRange`, 1..16).
- The graph has a `gather_nd`. YOLO26's NMS-free head is the only hosted
  graph with one.

The static @640 YOLO26 and YOLO26-seg packages load. So does the one other
flexible package (bird-classifier, which has no `gather_nd`), and so does every
static YOLOv9. Rebuilding the flexible recipe reproduces the abort. The same
recipe exported with a static batch loads and runs on all four compute units.
Against the hosted ONNX on ten COCO val2017 images, its detections match the
ONNX ones (recall 0.96–1.00, the same order as the hosted @640 pair at 0.98).
The ANE p50 is 0.9 ms (`yolo26n-320`) to 3.6 ms (`yolo26l-320`).

Python cannot catch an abort. A pool worker that loaded one of these packages
died, the host respawned it, and the respawned worker went straight into the
same load.

A fixed package uploaded over the old path does not reach a node that
already has the old one: `ensureModel` returns early for a path that exists.
Publishing the fix under a new file name (plus the old one as an alias) was
built first and then dropped by the operator: nobody runs the reduced YOLO26
CoreML entries, so no node holds a crashing copy worth a second name.

Building the probe exposed a second fault. coremltools rewrites
`Manifest.json` (same bytes, new mtime) on every open of a package, including
`ct.utils.load_spec`. The compiled-model cache keyed its stamp on the
package's max mtime, and its HIT path calls `load_spec`. So every HIT
invalidated the stamp for the next spawn: HIT, MISS, HIT, MISS. This may
explain much of the 59 HIT / 55 MISS split measured on 2026-09-19, which had
been put down only to concurrent workers.

## Decision

The CoreML branch of `_load_model` first calls
`coreml_load_probe.ensure_coreml_loadable(path, device)`. That call loads the
package in a fresh interpreter, using the pool's own `_acquire_coreml_model`
plus one predict. It keeps the verdict in `.coreml-cache/<stem>.<device>.probe.json`,
keyed on the package fingerprint, the device and the OS build.

- A child that dies by a signal is `crashed`. The load is refused with
  `CoremlLoadCrashed` (reply `reason: "native-load-crashed"`), and every later
  load of that package is refused without probing again.
- `ok` is never probed again. The child has already written the compiled
  cache, so the in-process load is a cache HIT.
- Anything else (a Python exception, a timeout, a child that cannot start) is
  not stored, and the load runs as it did before.

The compiled-model fingerprint counts `Manifest.json` by size only, not by
mtime.

A CoreML export of a YOLO26 checkpoint is static (batch 1). The YOLO26
@320/@256 packages were re-exported that way and replaced IN PLACE on the
mirror: same paths, same catalog ids, same file names.

## Consequences

- The first load of each CoreML package, per device and OS build, costs one
  extra interpreter start plus one cached load (about 1–2 s). A macOS update
  probes every package once more.
- A package that crashes is refused until it changes on disk. A re-download
  gives it a new fingerprint, so it is probed again. The host's load
  back-off (D653) limits how often the refusal is logged.
- The YOLO26 @320/@256 CoreML packages no longer take a stacked batch on the
  ANE (`_supports_batch` is false for them, as for every other static
  package). They never had a working one.
- A node that had already downloaded a crashing package keeps it (same
  name, so it is never re-fetched). The probe refuses it instead of crashing;
  deleting the file makes the next load fetch the static one.

## Enforcement

- `packages/addon-pipeline/python/test_coreml_load_probe.py`: a real child
  that calls `os.abort()` is classified `crashed`; verdict persistence; and
  `_load_model` never reaches `ct.models.MLModel` for a crashed package.
  These fail without the gate.
- `test_inference_pool_coreml_cache.py`: a HIT does not invalidate the next
  HIT when the loader rewrites `Manifest.json`.
- `build-camstack-models.py`: `check_recipes` refuses (exit 2, on every
  run, ad-hoc `--model yolo26* --dynamic` included) a YOLO26 recipe whose
  CoreML export is batch-flexible.
- `model-catalogs-yolo26-reduced-coreml.spec.ts`: the reduced entries keep
  their original CoreML file names.
