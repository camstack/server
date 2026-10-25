---
title: Detector ↔ classifier label link
status: implemented
date: 2026-10-05
covers:
  - packages/addon-pipeline/src/detection-pipeline/registry/step-definitions.ts
  - packages/types/src/types/detection.ts
  - packages/addon-model-studio/**
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/**
---

# Detector ↔ classifier label link

> **Implemented 2026-10-06 — decided by
> [D715](../decisions/adr-0715-a-root-detector-that-declares-a-step-fills-it-and-tier-1-has-one-writer-per-effect.md).**
> What shipped differs from the proposal below: the policy is `run |
> skip-when-filled` only (the two `prefer-*` values keep two writers and were
> rejected); the schema is `fillsClassifierEffects: { stepId, labelToEffect,
> uncovered }[]` with `package-detection` as a fillable step and no
> `bird-classifier`; the linked label is attributed to
> `detector-link:<stepId>`. The record is the authority; this page is the
> history of the proposal.

## Intent

Some root detectors (plus catalog, SSDLite MobileDet, future CamStack builds)
already emit **fine labels** (`dog`, `deer`, `sedan`) that today only become
tier-1 / tier-2 via a second-stage classifier (`animal-classifier`,
`vehicle-classifier`, `bird-classifier`). Running the classifier anyway is
redundant and can disagree with the detector.

We need one declared way to say: **this detector already fills the effect of
these classifier steps**, and a per-camera policy for when the classifier still
runs.

## Current authority (why this is hard)

- Root OD maps raw → macro via `classMap` (`COCO_TO_MACRO`).
- Fine identity under a macro is a `ScoredLabel` with `stepId` + `labelTier`.
- Birth path uses `detector:raw-class` at **score 0**; a live classifier always
  wins on score.
- Q1 in `docs/design/training-beyond-the-root-detector.md` is still open:
  single authority for tier-1 (`detector:raw-class` vs `animal-classifier`).

## Proposed shape

### 1. Model catalog metadata (declaration)

On the **object-detection** `ModelCatalogEntry` (CamStack seed, plus catalog import,
custom registry):

```ts
fillsClassifierEffects?: {
  readonly stepIds: readonly (
    | 'animal-classifier'
    | 'vehicle-classifier'
    | 'bird-classifier'
  )[]
  /** Optional: raw label → effect vocabulary id (dog → animal-type dog). */
  readonly labelToEffect?: Readonly<Record<string, string>>
}
```

plus catalog / MobileDet import **auto-fills** `stepIds` when the labelmap
intersects the classifier vocabularies (document the intersection table once).

### 2. Classifier step setting (policy)

On each classifier's device / camera step settings:

```ts
labelLink: 'run' | 'skip-if-detector-fills' | 'prefer-detector' | 'prefer-classifier'
```

Default: `skip-if-detector-fills` when the active OD model declares that
`stepId` in `fillsClassifierEffects`; otherwise `run`.

### 3. Runtime

1. After root map: if `debug.originalClass` (or an own label) satisfies a filled
   effect → mark `effectSatisfied[stepId]`, promote a `ScoredLabel` with a
   **non-zero** score (detection score) and a stable step id
   (`detector:linked:<stepId>` or scored `detector:raw-class` — ADR picks one).
2. Detail announce: if `labelLink === 'skip-if-detector-fills'` and satisfied →
   do not enqueue the classifier; log with `tags: { deviceId }`.
3. `prefer-*`: both may run; `resolveTieredLabelWrite` remains the one writer
   (score / step precedence decided in the same ADR).

### 4. Where it is NOT

- Not a new Moleculer action.
- Not `jumpDeviceKey` (that is accelerator placement).
- Not a shadow registry of labels in admin-ui.

## UI

- Pipeline matrix / Installed: badge on OD models that declare fills.
- Classifier cell: show effective `labelLink` (inherited vs override).
- Model Studio Import (plus catalog): preview which effects will be filled.

## Ship list

- [x] ADR (closes training Q1 + score of linked raw-class) — D715
- [x] Schema on catalog + plus catalog/MobileDet auto-detect
- [x] Runtime skip + log
- [x] Pipeline / Model Studio surface
- [ ] Optional: bird `inputLabels: ['bird']` chaining

## Related

- `docs/design/training-beyond-the-root-detector.md`
- (planning repo: superpowers/specs/2026-09-26-plus-catalog-models-licenses.md)
