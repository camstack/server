# Model Studio — custom-model manipulation, conversion & distribution

**Status:** Design (brainstorm) — not implemented
**Date:** 2026-06-27
**Author:** session handoff

## Goal

A first-class surface to bring custom detection models into CamStack and shape
them for the cluster's heterogeneous hardware:

- **Manipulate models in all directions** — convert between `onnx ↔ openvino ↔
  coreml` and quantize (`fp32 → fp16`, NNCF `int8`).
- **Upload custom models** (bring-your-own trained detector) and **distribute
  them to specific nodes**.
- Maintain a **registry** of custom models with **per-node addressing/routing**,
  and surface them in the detection-pipeline model picker alongside the static
  catalog.

## Requirements (from the user)

- A **NEW addon**, structured like `addon-benchmark` (on-demand install, a
  Module-Federation **custom page**).
- The page allows **model manipulation in all directions** + **upload to nodes**.
- A **capability** for **maintenance + addressing/routing** of custom models.

## What already exists (reuse, don't reinvent)

- **Conversion pipeline (offline):** `scripts/build-camstack-models.py` +
  `gen-variants` already do `ov.convert_model` (onnx→IR), `compress_to_fp16`,
  NNCF `int8` (COCO-letterbox calibration) and validate (compile + named
  tensors). The Model Studio engine is this logic, promoted to a runtime cap.
- **Static catalog:** `ModelCatalogEntry` + `ovFormat`/`ovPrecisionVariant` in
  `detection-pipeline/registry/model-catalogs.ts`; `getStepDefinition().models`.
- **Download + sibling fetch:** `@camstack/system` `ensureModel` /
  `ModelDownloadService` (now sibling-aware), `isModelDownloaded`.
- **Per-node addressing precedent:** agent-pull addon deploy (hub stages a tgz →
  agent pulls it over an authenticated one-time-token HTTP route, sha256-verified)
  — the model-distribution mechanism should mirror this, not re-invent it.
- **Embedded portable Python** per node (the same interpreter the inference pool
  uses) — where conversion/quantization runs.

## Architecture — a new addon + one capability, decomposed into 4 sub-projects

```
            ┌──────────────────────── addon-model-studio ────────────────────────┐
  Custom    │  MF custom page  ──cap──▶  custom-model-registry (singleton, hub)   │
  page  ───▶│  (import / convert / quantize / upload / manage)                    │
            │       │                         │ persists the registry             │
            │       │ convert request         │ + per-node availability map       │
            │       ▼                         ▼                                   │
            │  model-convert (per-node) ──▶ writes IR into that node's /data/models│
            └────────────────────────────────────────────────────────────────────┘
                         │ registry feeds the picker
                         ▼
            detection-pipeline model resolution (static catalog ∪ custom registry)
```

### Sub-project A — `custom-model-registry` capability (foundation)

A **singleton** cap (hub-resident) that maintains a **persisted** registry of
custom models and their **per-node availability**, and exposes them to the
detection-pipeline model resolver.

- **State (durable):** `CustomModel { id, name, family (detector/face/…),
  inputSize, labels, preprocessMode, postprocessor, formats: { onnx?, openvino?,
  coreml? } (each a content hash + sizeMB), createdAt }` plus an
  `availability: Record<modelId, Record<nodeId, { format, present, path }>>`.
- **Methods:** `list`, `get`, `register(model + uploaded artifacts)`,
  `remove`, `getAvailability(modelId)`, `setNodeTarget(modelId, nodeId, format)`
  (addressing/routing — declare a model should live on a node), `resolveEntry
  (modelId) → ModelCatalogEntry-compatible` so the executor downloads it like a
  catalog model.
- **Integration:** the detection step's model list becomes `static catalog ∪
  registry.list()`; `ensureModel` resolves a custom model via
  `registry.resolveEntry()` (URL or local path). Keep the registry the SOLE
  source of truth for custom models (no shadow maps).

### Sub-project B — `model-convert` capability (the manipulation engine)

A **per-node** cap (runs where the target runtime + python live) that performs
one conversion/quantization step and writes the result into that node's
`/data/models`. Promotes the offline script to runtime.

- **Methods:** `convert({ sourceModelId|sourceFile, from, to, precision:
  'fp32'|'fp16'|'int8', calibrationRef? }) → { artifact, sizeMB, validated }`.
- **Engine:** `ov.convert_model` (onnx→IR), `compress_to_fp16`, NNCF int8
  (calibration set ref — a stored COCO/user subset; for an Ultralytics
  detector the D818 recipe: MIXED, full bias correction, the Detect head in
  float); coremltools for coreml;
  onnx export via the source. Always **validate** (compile + named tensors)
  before returning — the malformed-IR class of bug must never ship.
- Runs in a subprocess off the embedded python (long job → progress events on
  `ctx.eventBus`, like model-download progress).

### Sub-project C — distribution to nodes (reuse agent-pull)

Get a model artifact onto a target node's `/data/models`. Mirror the
**agent-pull** deploy: hub stages the artifact + a one-time token; the target
node pulls it over the authenticated HTTP route, sha256 + byte-length verified.
`custom-model-registry.setNodeTarget` drives it; availability map updated on
success. (For hub-local targets it's a direct copy.) No bespoke server — extend
the existing pull route.

### Sub-project D — `addon-model-studio` + custom page (orchestration + UI)

The benchmark-style addon that ties A/B/C together.

- **On-demand install** (dropped from bootstrap, installed via
  `addons.installPackage` — like benchmark).
- **Custom MF page** (`remoteEntry.js`, `/addon/model-studio`): import (upload
  file or pick from catalog/HF) → choose conversions/quantizations + target
  nodes → run (live progress) → validate → register → it appears in the
  detection model picker. A management view lists custom models + their per-node
  availability with evict/redistribute actions.
- **customActions** orchestrate: `importModel`, `runConversion`, `distribute`,
  `deleteCustomModel` — fanning out to the B/C caps and updating the A registry.

## Data flow (happy path)

1. Operator uploads `my-detector.onnx` on the page → `importModel` stores it +
   `custom-model-registry.register` (onnx format, hash).
2. Operator picks "openvino int8 for `agent-a`, openvino fp16 for `hub`" →
   `runConversion` calls `model-convert` ON each node (or converts on the hub +
   distributes) → validated IRs written to each node's `/data/models`.
3. `custom-model-registry` availability map updated; the model now shows in the
   detection step picker. Selecting it per-node uses the resident IR.

## Phasing

- **P1 — Sub-project A** (registry cap + detection-pipeline picker integration).
  Smallest, unlocks "use a custom model that's already on a node".
- **P2 — Sub-project C** (distribution) — reuse agent-pull to place artifacts.
- **P3 — Sub-project B** (conversion engine) — the manipulation.
- **P4 — Sub-project D** (addon + custom page) — the UI tying it together.

Each sub-project gets its own spec → plan → implementation cycle.

## Open questions

1. **Conversion locality:** convert once on the hub then distribute, or convert
   ON each target node? (NNCF int8 calibration is CPU-only and portable, so
   hub-convert + distribute is simpler; per-node only matters if a target has a
   runtime the hub lacks.) Leaning hub-convert + distribute.
2. **Calibration data** for int8 of custom models — ship a default COCO subset,
   or let the operator upload a representative set? (Default + optional override.)
3. **Labels/postprocessor** for a custom detector — inferred from the model, or
   operator-declared on import? (Declare on import; validate output shape.)
4. **Eviction/quota** — `/data/models` growth across nodes; the registry should
   own a size cap + LRU evict of unused custom artifacts.

## Non-goals

- Training models (import only).
- A general MLOps platform — scoped to detection/classification models the
  pipeline already consumes.
