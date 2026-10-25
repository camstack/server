---
id: D715
title: A root detector that declares a step fills it, and tier 1 has one writer per effect
status: superseded
date: 2026-10-06
applies-to:
  - packages/types/src/catalogs/root-model-supply.ts
  - packages/types/src/catalogs/plus-catalog-classmap.ts
  - packages/addon-pipeline/src/pipeline-runner/root-supply.ts
  - packages/addon-pipeline/src/detection-pipeline/pipeline/linked-label.ts
  - packages/addon-post-analysis/src/pipeline-analytics/detail-dispatcher.ts
---

## Context

A plus catalog detector already emits `deer`, `car`, `package` — the very effect
`animal-classifier`, `vehicle-classifier` and `package-detection` exist to
produce. Two things went wrong with that:

- **The labels were lost before anyone could use them.** A plus catalog import
  carried no classMap, inherited `COCO_TO_MACRO` (`preserveOriginal: false`) and
  the executor dropped every label COCO does not name: deer, raccoon, fox,
  squirrel, goat, rabbit, skunk, kangaroo, possum, rodent, school_bus,
  garbage_truck — and `package`. Fixed first, on its own
  (`PLUS_CATALOG_TO_MACRO` / `buildPlusCatalogClassMap`).
- **Tier 1 had two authorities.** The root's raw class (`detector:raw-class`,
  only under `traceVerbosity: 'full'`, score 0) and the classifier's answer both
  wrote the sub-class slot; Q1 of
  [training-beyond-the-root-detector.md](../design/training-beyond-the-root-detector.md)
  was open on exactly this. Running the classifier on a subject the detector had
  already named was also redundant and could disagree with it.

The first sketch ([detector-classifier-label-link](../design/2026-10-05-detector-classifier-label-link.md))
offered four policies (`run`, `skip-if-detector-fills`, `prefer-detector`,
`prefer-classifier`); the two `prefer-*` keep both writers and let score decide,
which is the two-authority state this record exists to end. Rejected.

## Decision

**Tier 1 has ONE writer per effect, chosen by the root model's declaration plus
the step's policy.**

1. A root model DECLARES the steps it fills: `ModelCatalogEntry.fillsClassifierEffects`
   (`stepId` ∈ `animal-classifier | vehicle-classifier | package-detection`,
   `labelToEffect`, `uncovered`), derived from its labelmap by
   `deriveClassifierFills`, never hand-written. **A COCO model never fills a
   step** (`isCocoLabelmap`: ≥ half the COCO-80 classes).
2. Effects are spelled in the step's own vocabulary — `FILLABLE_STEP_VOCABULARIES`,
   the one constant the step definitions also consume.
3. The step's `labelLink` setting (`run | skip-when-filled`, default
   `skip-when-filled`) lives in the step's existing settings
   (`DeviceStepConfig.settings` / `CameraStepOverridePatch.settings`, D62). It
   does nothing unless the root model declares the fill.
4. `resolveLabelLink` is the one decision: the step not running ⇒ the detector is
   the writer; the step running with `skip-when-filled` AND every `uncovered`
   class switched off in its `enabledClasses` ⇒ the detector is the writer and
   the step is skipped; otherwise the step is the writer. A coverage gap (plus catalog
   has no `sheep`) must be switched off EXPLICITLY before the skip applies.
5. The detector's answer is a `ScoredLabel` attributed to
   `detector-link:<stepId>`. The executor writes it at score 0 (it cannot see the
   whole tree — a delegated detail step is pruned from its dispatch); the runner,
   which holds the attach config, raises it to the detection's score when the
   detector is the writer. Score 0 is the fallback any scored answer outranks, and
   it still lands when nothing else answers — at every verbosity.
6. A skipped classifier is still announced, with `DetailStepAnnounce.filledBy`;
   the detail dispatcher skips it only for a track whose frame carries the linked
   label, and logs that once per (track, step) with `tags.deviceId` (D391). A
   subject the detector cannot name (a plus catalog `bear`) still gets the
   classifier.
7. `package-detection` filled and skippable ⇒ the package root is not dispatched;
   the camera root's own `package` boxes ARE the package result — its gate admits
   `package` at the package step's `minConfidencePackage`, and every frame it ran
   is stamped `packageLooked`. One package authority, fed by whichever root the
   policy names.

`detector:raw-class` stays as the last-resort candidate for a model that
declares nothing.

## Consequences

- An operator who wants the classifier back sets `labelLink: run` on that step;
  nothing else changes.
- `debug-track-analysis` names a linked label as the detector's: score 0 is
  `UNSCORED_LABEL`, a low score is the DETECTION's confidence.
- The package root's crop-zone view is lost while the camera root stands in for
  it; small parcels the full-frame root misses stay missed. Set `labelLink: run`
  on `package-detection` to restore it.
- Rows registered before the plus catalog classMap existed are re-registered by hand,
  once (operator decision: no migration code).
- Q1 of the training plan is closed: a dataset of `dog` corrects whichever writer
  the camera's policy names, and the attribution says which. D517 stays reserved
  for that plan's own architecture record.

## Enforcement

- `scripts/check-label-link-vocabulary.ts` (CI `checks.yml`): every declared
  `labelToEffect` value and `uncovered` entry is in the step's vocabulary; the
  plus catalog base set fills at least one step; the classifiers' `enabledClasses`
  offer IS the vocabulary.
- Tests: the derivation table (`classifier-fill.spec.ts`), the executor's linked
  label, `planLabelLinks` / `deriveDetailSteps` / package fill (also through
  `runInference`), the dispatcher skip + single log line, and tier precedence
  (`label-link-tier.spec.ts`).
