---
id: D730
title: A step takes its result from the root model when its flag is on and the current root declares it — every root, crop steps included
status: accepted (the default enablement of the animal and vehicle classifiers, and the supply of a step the camera does not run, superseded by D736)
date: 2026-10-06
supersedes: D715
applies-to:
  - packages/types/src/catalogs/root-model-supply.ts
  - packages/types/src/catalogs/plus-catalog-classmap.ts
  - packages/addon-pipeline/src/pipeline-runner/root-supply.ts
  - packages/addon-pipeline/src/detection-pipeline/pipeline/root-child-boxes.ts
  - packages/addon-pipeline/src/detection-pipeline/pipeline/linked-label.ts
  - packages/addon-post-analysis/src/pipeline-analytics/detail-dispatcher.ts
  - packages/ui-library/src/composites/root-model-source.tsx
---

## Context

[D715](adr-0715-a-root-detector-that-declares-a-step-fills-it-and-tier-1-has-one-writer-per-effect.md)
let a root detector's labels stand in for a classifier, with three parts the
operator rejected once it was in use:

- **A COCO exception.** `isCocoLabelmap` made every COCO root declare nothing,
  and the code called that an operator decision. It was not one. CamStack's own
  YOLOv9 / YOLO26 name `dog`, `cat`, `bus`, `truck` exactly like a plus catalog
  model names `deer`: the exemption only hid what the root can do.
- **A policy select that blocked.** `labelLink: run | skip-when-filled` applied
  only once every class the root could NOT produce was switched off in the
  step's class list. A plus catalog root lacks `sheep`, so out of the box nothing
  was ever skipped; the operator had to discover the gate and give up a class
  to get the feature.
- **A chip that could never show.** The cluster/node matrix asked whether the
  step was ON by its catalog default before saying "filled by"; every fillable
  step is opt-in, so the chip never rendered there.

And it stopped at labels, while the same plus catalog model draws `license_plate`
and `face` boxes that CamStack threw away as unmapped classes.

## Decision

**A step takes its result from the root model exactly when its own
`useRootModel` flag is on AND the current root model declares the step.
`resolveRootSupply` is the one function that says so — the runner, the detail
dispatcher and the admin UI all call it.**

1. **Every root declares what it can supply, from its own labelmap.**
   `deriveRootSupplies(labels, classMap)` — no exemption for any family. A
   COCO root supplies `animal-classifier` 6/8 (bird, cat, cow, dog, horse,
   sheep) and `vehicle-classifier` 5/8 (Bicycle, Bus, Car, Motorcycle, Truck);
   the plus catalog base Coral model (2026.1) supplies animals 7/8, vehicles 4/8,
   package, plates and faces. plus catalog imports compute the declaration at import
   (`suppliesSteps`, every builder through `plusCatalogLabelFields`); a row without
   it — a built-in entry, or a row imported under D715 — is derived on read by
   `rootSuppliesOf`. Nothing is assumed per family or per format.
2. **Two kinds.** `label`: the root's raw class is the step's answer
   (`animal-classifier`, `vehicle-classifier`, `package-detection`). `crop`:
   the root draws the step's box (`plate-detection` from `license_plate`,
   `face-detection` from `face`). The declaration type is a discriminated union
   on `kind`.
3. **The flag is an intent, kept beside the step's model.** `useRootModel`
   lives in the step's existing settings at every level (per node/device step
   settings, per-camera step overrides). It never changes or clears the step's
   `modelId`, and changing the root never rewrites it. When the root cannot
   supply the step the step runs its own model unchanged — no model is picked
   or activated — and the UI shows the flag as inactive; switching back to a
   root that can re-activates it with no write. Defaults: ON for the label
   kinds, OFF for plates and faces. A stored D715 `labelLink` reads as the flag
   when no flag is stored (`skip-when-filled` → on, `run` → off) — the read
   path, not a migration; none was found stored on the hub on 2026-10-06.
4. **Effective ⇒ the step is not dispatched.** For a label supply the root's
   linked label is authoritative at the detection's score, and the step's
   `enabledClasses` decides which root labels become the fine class: a
   switched-off class is dropped and the detection stays at its macro
   (`animal`). A class the root cannot produce is shown as unavailable and
   never blocks. For `package-detection` D715's runtime stays: the package root
   is not dispatched, the camera root admits `package` at the package step's
   `minConfidencePackage`, every frame it ran counts as a package look.
5. **Crop supplies are children, never tracks (D683).** `license_plate` and
   `face` stay out of every classMap. The executor holds a declared crop box
   aside and attaches it, as a `detail` with `rootSupplied`, to the smallest
   first-level detection of the right macro that holds ≥ 90 % of it
   (`containingParentIndex`); a box nothing contains is discarded. The runner
   keeps those details only while the crop supply is effective.
6. **Plates.** An effective plate supply sends the root's box to the plate
   reader: the dispatcher calls `runDetailSubtree` with `supplied` boxes, the
   runner maps them into the vehicle crop, and the executor uses them as
   `plate-detection`'s output (`suppliedRoot`) instead of inferring. The reader
   cuts the box from the native frame through its own crop policy, with
   `ROOT_SUPPLIED_PLATE_MARGIN_FRACTION` (0.15) in place of the reader's
   detector-specific margin. A vehicle with no root plate on its freshest frame
   waits, retried per the step's cadence.
7. **Faces.** An effective face supply feeds the root's face box to the
   person's face box and its media (`faceBbox`, the overlay, face-bearing for
   L2). `face-detection` is not dispatched and **recognition is unavailable with
   root faces**: `CROP_SUPPLY_SOURCES['face-detection'].servedChildSteps` is
   empty, so `face-embedding` never runs on an unaligned root crop. That list is
   one half of the extension point: a recognition path for root faces lands by
   naming `face-embedding` there, which also removes the UI's "recognition
   unavailable" line and makes the dispatcher send the box to the embedder. The
   other half is `RootSupplyState.inactiveReason`: a gate on the root itself
   (a minimum root input size for root faces is the candidate) adds a reason,
   and the editor already shows the flag as inactive with it.

## Consequences

- **A camera whose root is a CamStack COCO model stops dispatching the animal
  and vehicle classifiers by default.** Its animals and vehicles are named by
  the detector's own class at the detection's score; `deer`, `squirrel`,
  `Ambulance`, `Taxi`, `Van` are no longer produced on those cameras. An
  operator who wants the classifier back unchecks "Use the root model" on the
  step. The runner logs ONE info line per (camera, step) when a step becomes
  supplied by the root (`root model supplies a pipeline step`), so the change
  is readable per camera instead of inferred from missing dispatches.
- Uncovered classes cost nothing to switch on: a plus catalog camera gets
  `animal-classifier` from the root out of the box, `sheep` simply never comes.
- The package root's crop-zone view is not used while the root supplies the
  package step; small parcels the full-frame root misses stay missed. The
  editor says so.
- The root-plate margin is **uncalibrated for plus catalog boxes** and needs a
  ground-truth measurement before it is trusted; plates default off for that
  reason.
- `DetailStepAnnounce.filledBy` keeps its meaning (the supplying model) and
  gains `filledAs: 'label' | 'crop'`; an announce without it reads as a label
  supply, so an older runner behind a newer post-analysis still skips only
  classifiers.
- Deploy order: `@camstack/types` (framework, via a published
  `@camstack/server`), then `addon-pipeline` (it produces the root child boxes,
  the new announce and honours `supplied`), then `addon-post-analysis`, then
  `addon-model-studio` and the admin UI. The two cap additions
  (`runDetailSubtree.supplied`, `runPipeline.suppliedRoot`) are additive.

## Enforcement

- `scripts/check-label-link-vocabulary.ts` (CI `checks.yml`): every declared
  label supply speaks its step's vocabulary, the plus catalog base set supplies a
  label step, and every built-in root supplies the animal and vehicle
  classifiers — an exemption for any family fails it.
- Tests: the derivation, effectiveness across a root switch (CamStack COCO →
  plus catalog → plugin catalog → back), defaults and the retired-key read
  (`root-model-supply.spec.ts`); every plus catalog import path including the real
  Coral labelmap and the re-derived stored row (`plus-catalog-classmap.test.ts`);
  the runner plan, authority, class filter, package fill and the one-line log
  (`root-supply*.spec.ts`); containment and the supplied plate margin
  (`executor-root-supply.spec.ts`, `detail-subtree.spec.ts`); dispatch by kind
  (`detail-dispatcher-root-supply.spec.ts`); child boxes never tracked
  (`frame-processor.spec.ts`); the editor checkbox and the matrix chip
  (`agent-step-editor-root-model.test.tsx`, `NodeDeviceStepsMatrix.spec.tsx`).
