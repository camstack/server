---
id: D703
title: One licence-clean model survives per enrichment step, and a deleted model id is just a custom model
status: accepted
date: 2026-10-05
supersedes:
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/registry/model-catalogs.ts
  - packages/addon-pipeline/src/detection-pipeline/registry/step-definitions.ts
  - packages/addon-pipeline/src/pipeline-runner/stateless-step.ts
  - packages/addon-post-analysis/src/embedding-encoder/catalogs/embedding-models.ts
  - packages/types/src/pipeline/cluster-model-scope.ts
  - scripts/check-catalog-licence.ts
---

> **Amended by [D725](adr-0725-a-stored-pin-to-a-deleted-model-is-reset-to-the-step-default-by-the-orchestrator.md)
> on 2026-10-06.** A stored pin or cluster row naming a deleted id is no longer
> left for the operator: the orchestrator drops it (unless a registered custom
> model owns the id) and the step follows its default. Resolution is unchanged —
> an unknown id still passes through as a custom model.
>
> **Extended by [D710](adr-0710-a-coral-build-of-a-survivor-is-a-format-of-that-model-admitted-by-what-it-costs-the-shared-edge-tpu-context.md)
> on 2026-10-06.** One survivor per step still holds verbatim: a Coral (Edge TPU)
> build of a survivor is a `formats.tflite` of that same model, never a new
> `-edgetpu` id, and it is admitted by what it costs the shared Edge TPU context.
>
> **Extended by [D719](adr-0719-the-plate-detection-survivor-is-open-lpr-yolox-tiny-and-every-other-plate-detector-is-deleted.md)
> on 2026-10-06.** Plate detection, the one step this record left out, now has
> its survivor too: `yolox-tiny-plate`; `yolov8n-plate` is deleted.

## Context

D661 moved model licences into the catalogs and made every licence surface
generated from them. It left the non-commercial models that CamStack could not
yet replace in the catalog, each with a line in `NON_COMMERCIAL_ACCEPTED`
("until X is retired"). D643 handled the models that DID have a replacement by
adding `RETIRED_MODEL_IDS`: a removed id stayed listed, a pin to it silently
resolved to the step's format default, and a stateless step pinned to it was
refused by name (D54).

Both mechanisms aged badly:

- The accepted list only ever grew shorter on paper. SCRFD (InsightFace terms),
  MobileCLIP S1/S2 (Apple AMLR) and the unlicensed ArcFace / Inception-ResNet /
  VGG-English weights stayed shipped, downloadable and selectable for as long as
  the list said "until".
- `RETIRED_MODEL_IDS` was a second catalog: a list of ids that mean "not here
  any more", which every resolver (`resolveModelForFormat`, the servability
  check, the specs) had to consult and which could be forgotten by the next
  removal — D643 itself recorded that no guard stopped a removal that skipped
  it. A pin silently re-pointed to another model also hides, from the operator,
  that the model he chose is gone.
- Every enrichment sub-step already has a licence-clean replacement that is the
  cluster default in production (YuNet, AuraFace, `cct-s-v2-global`, RF-DETR
  package, SigLIP2). Keeping the second model only multiplied fixtures, vector
  indexes (`object-clip` at 512 dims next to `object-clip-siglip2-b16-224` at
  768) and licence surface.

## Decision

Each enrichment sub-step ships ONE licence-clean model, and a model that leaves
the catalog is deleted, not retired.

- Survivors: face-detection `yunet-2023mar`, face-embedding `auraface-r100`,
  plate-ocr `cct-s-v2-global`, package-detection `rfdetr-package`,
  clip-embedding `siglip2-b16-224` (image) and `siglip2-b16-224-text` (text),
  cluster-wide — the detection catalog AND the embedding-encoder catalog.
- Deleted: `scrfd-2.5g`, `ssd-mobilenet-v2-face-edgetpu`, `arcface-r100`,
  `inception-resnet-v1`, `vgg-english-g2`, `mobileclip-s1`, `mobileclip-s2`
  (and the `-text` towers), `yolov8n-package`, `bird-classifier-aiy-edgetpu`.
- `RETIRED_MODEL_IDS` is abolished, with its resolver branch and the `retired`
  `ModelServability` kind. A deleted id resolves like any unknown id: it passes
  through as a custom model, and a step that cannot serve it says so under the
  ordinary "cannot serve this model" refusal.
- The CamStack Coral OD survivor is `ssd-mobilenet-v2-coco-edgetpu` (selectable,
  not legacy) and `defaultModelIdByFormat.tflite` names it. Sibling Coral SSDs
  (`efficientdet-lite0-edgetpu`, `ssdlite-mobiledet-coco-edgetpu`) are deleted —
  plus catalog still offers MobileDet via its own catalog import; a deleted pin is a
  custom id until the operator picks the survivor.
- `NON_COMMERCIAL_ACCEPTED` keeps only what is accepted on purpose
  (`vehicle-type-v1`, D661). Deleting a model deletes its line.

This supersedes the retired-model path of D643 (the `RETIRED_MODEL_IDS` paragraph
and its fallback/refusal specs); the rest of D643 stands. D661's "until
MobileCLIP is retired" entries are resolved by this record.

## Consequences

- A pin or a cluster row naming a deleted id is not rewritten any more. It is
  treated as a custom model and fails where it cannot be served — visibly,
  instead of being silently replaced. An operator whose row still names a
  deleted model has to pick the survivor; the cluster-scoped steps
  (`face-embedding`, `clip-embedding`) list only the survivor as an option.
- The pre-SigLIP2 `object-clip` index (512-d MobileCLIP vectors) is no longer a
  space of `BUILTIN_CLIP_MODELS`, so `ObjectEmbeddingStore.indexes()` no longer
  names it. Orphan audit, delete and wipe do not reach rows that still live in
  it on an existing hub; reclaiming that index is a separate, explicit step
  (drop the index), and until it is taken those rows are inert, never searched.
- Search by a named MobileCLIP id (the admin cutover comparison, D649) is gone
  with the model: `resolveClipSearchPlan` and `pinClipRebuild` refuse it as "not
  a CLIP model".
- Tests that need SEVERAL CLIP models (tower LRU, cluster-row switch, the
  per-model search floor) inject synthetic entries into a test-local registry
  built with `buildClipModelRegistry`; the production catalog stays one entry.
- The Apple AMLR and InsightFace licence texts are no longer referenced by any
  catalog record; they stay in `licenses/models/` until the generator stops
  mapping them.

## Enforcement

- `scripts/check-catalog-licence.ts` fails on any catalog entry without a
  declared licence, and on a non-commercial entry missing from
  `NON_COMMERCIAL_ACCEPTED` (now one line). `MIN_ENTRIES` is a floor on the
  catalog walk.
- `scripts/check-cluster-model-scope.ts` keeps `@camstack/types` and the step
  registry agreeing on the cluster-scoped survivors.
- `removed-model-ids.spec.ts` (addon-pipeline) pins that every deleted id is
  absent from every catalog and resolves as a custom model;
  `clip-catalog-metadata.spec.ts` and `embedding-model-licences.spec.ts`
  (addon-post-analysis) pin SigLIP2 as the sole CLIP model.
- Nothing stops a future removal from leaving a live row pointing at the
  deleted id; that is the consequence above, and review is the only check.
