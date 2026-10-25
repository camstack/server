---
id: D208
title: Every model-resolution surface consults the custom registry, and a custom artifact travels by local convention, not by URL
status: accepted
date: 2026-08-21
supersedes:
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/engine/engine-factory.ts
  - packages/addon-model-studio/src/plus-catalog/plus-catalog-import.ts
  - packages/addon-model-studio/src/upload/model-upload-store.ts
  - packages/addon-pipeline/python/postprocessors/yolonas.py
---

## Context

Operator-registered custom models (the `custom-model-registry` cap, fed by
Model Studio) were SELECTABLE but not RUNNABLE. Three of the four resolution
surfaces consulted the registry — the picker (`buildSchemaSlots` merges custom
entries), the download path (`provider.resolveModelEntry`), and
`resolveModelForFormat` (passes unknown ids through) — but the fourth,
`EngineFactory.buildPoolModelConfig`, looked ONLY in the static
`def.models` and threw `Model "X" not found in step "Y" catalog`, failing the
WHOLE pool `applyConfig`. So an operator could choose a custom model in the UI
and thereby take the step's pool down. Two more silent halves of the same gap:
the pool labels came from `readModelLabels(extraFiles) ?? def.labels`, so a
custom model always decoded with the step's COCO-80 fallback whatever its
declared labels; and `resolveEffectivePostprocessor` looked the model up in
`def.models`, so a custom entry's per-model decode override silently fell back
to the step default (a reference detector `yolonas` model decoded as `yolo` produces zero
detections and no error anywhere).

Separately, converted/uploaded artifacts carry `camstack-local://<id>/<file>`
URLs. Nothing ever CONSUMES that scheme: it works only because `ensureModel`
resolves by URL basename against `modelsDir` and finds the file already there.
On any other node the "download" was a cryptic `fetch()` URL-parse failure
after three pointless retries. The alternative — serving uploads over a new
hub HTTP route — was rejected: routes live in `server/backend` (the framework
closure, not live-updatable by an addon deploy), and `model-distributor`
already moves model files node-to-node correctly. For upload itself, a
multipart route was rejected for the same reason; the file rides chunked
base64 customActions (~683 KiB per call under the hub's ~1 MB body limit).

The first real import target (the reference detector YOLO-NAS, public flat-NMS export)
surfaced one more: super-gradients exports bake the /255 preprocessing into
the graph and declare a `tensor(uint8)` input; the pool's unconditional
float32 [0,1] tensor is a hard onnxruntime type error.

## Decision

A model an operator can SELECT must be loadable end-to-end. Concretely:

1. Every surface that resolves a `(stepId, modelId)` pair — picker, download,
   pool-config, postprocessor choice, labels — resolves **static catalog
   first, then the custom registry**, never static-only. The pool side does
   this via the `resolveCustomModel` seam on `EngineFactoryOptions` (a sync
   snapshot reader over the provider's custom-models cache, which every load
   path refreshes before `loadAdditional`/`applyConfig`).
2. Pool label precedence is `-labels.json` extraFile → the entry's own
   non-empty `labels` → `def.labels`. A custom model's declared labels are its
   only label channel and must reach the decode.
3. A custom artifact is addressed by the `camstack-local://<modelId>/<file>`
   convention: the basename names a file that must already sit in the node's
   `modelsDir` (landed by the Model Studio upload store, a conversion, or
   `model-distributor`). The scheme is never fetched; a node missing the file
   fails fast with "distribute it from Model Studio", not a fetch error.
4. The ONNX pool captures the declared input dtype at session load; a
   `tensor(uint8)` model is fed raw uint8 pixels in its declared layout.

## Consequences

Custom models (the reference detector yolov9 / yolonas / mobiledet imports among them) are
selectable AND runnable on the node that holds the artifact; other nodes need
an explicit Distribute (Models tab) first — there is deliberately no implicit
cross-node fetch for operator-uploaded files. Any NEW model-resolution surface
must consult the custom registry or it reintroduces this exact class of break.
`PostprocessorType` gained `yolonas` as a compile-time-only member (the zod
side is `z.custom`), so addons compiled against the widened union run on hubs
whose installed framework predates it.

## Enforcement

`custom-model-pool-config.spec.ts` pins the pool-config resolution (custom
resolver consulted, entry labels win, per-model postprocessor override
honored, static path byte-identical). `test_inference_pool_preprocess.py`
pins the uint8/float input split; `test_yolonas.py` pins the flat [N,7]
decode. The `camstack-local://` fail-fast is review-only.
