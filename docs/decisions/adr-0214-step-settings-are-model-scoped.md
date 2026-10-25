---
id: D214
title: A step setting declares its per-model applicability, and Model Studio has ONE registration flow
status: accepted
date: 2026-08-21
supersedes:
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/registry/model-knob-applicability.ts
  - packages/addon-pipeline/src/detection-pipeline/engine/engine-factory.ts
  - packages/ui-library/src/composites/model-picker.tsx
  - packages/ui-library/src/composites/pipeline-step.tsx
  - packages/addon-model-studio/src/plus-catalog/registration.ts
  - packages/addon-model-studio/src/plus-catalog/plus-catalog-catalog.ts
  - packages/addon-model-studio/src/plus-catalog/plus-catalog-api.ts
---

## Context

After D208 made custom models runnable, the operator asked the load-bearing
question: *do our step settings even apply to a custom model?* The audit
(knob × model/postprocessor) answered "not uniformly", and found one knob that
applies to NOTHING:

| Knob (step) | Applied where | plain yolo | yolonas / ssd (fused NMS) | custom labelmap | verdict |
| --- | --- | --- | --- | --- | --- |
| `minConfidence<Macro>` (object/package-detection) | executor `macroFilterVerdict`, per detection | ✅ | ✅ | only for macros the labelmap REACHES | depends on labelmap |
| `enabledMacroClasses` | executor, post-`classMap` | ✅ | ✅ | labels not in `COCO_TO_MACRO` are dropped BEFORE the filter (`preserveOriginal: false`) | depends on labelmap |
| `fullFrameGuardHardAreaRatio` | executor, geometry on survivors | ✅ | ✅ | ✅ | generic |
| `nmsIouThreshold` (object-detection) | Python decode (`yolo`/`yolo-seg`/`rfdetr`/`scrfd` only) | ⚠️ see below | ❌ NMS fused in graph | n/a | postprocessor-dependent — **and dead for everyone, see below** |
| `enabledClasses` / `minConfidence` (classifiers) | `result-assembler` on the model's OWN label strings | ✅ | — | allow-list only matches if the OFFER is the model's labelmap | options must be model-scoped |
| `rectify` (plate-ocr) | executor crop policy, keyed by postprocessor | `ctc` only | — | — | inapplicable for `plate-slots` (catalog `cct-s-v2-global` included) |
| `minLandmarkFaceSize` (face-embedding) | executor landmark gate | requires a 5-landmark detector (`scrfd`) | — | a landmark-less custom face detector starves it | cross-step, review-only |
| preprocess (inputSize / normalization / letterbox) | pool preprocess from the ENTRY | ✅ | ✅ | ✅ (D208) | generic |

Two silent-failure classes fell out:

1. **A reference detector+ labelmap loses most of its value silently.** The executor maps
   every root detection through the step `classMap` with
   `preserveOriginal: false`; `deer`, `fox`, native `package`, delivery logos —
   anything not in `COCO_TO_MACRO` — is dropped upstream of every setting, with
   only the per-frame discard trail as evidence. Nothing at configuration or
   load time said so.
2. **A control can render for a model it cannot affect.** The NMS slider on a
   fused-NMS model, `rectify` on the fixed-slot plate reader, a species
   allow-list offering the CATALOG's labels against a custom model's logits (a
   filter that can never match — everything is dropped as `class-not-enabled`).

The audit also found `nmsIouThreshold` is **dead for every model**: the slider
writes step settings, but no `EngineFactory` construction site ever passes
`nmsIouThreshold`, so the pool always runs the 0.45 default (the D62 class of
knob — writes a store nobody reads). Fixing it needs settings→pool threading
plus a reload trigger in `PipelineModelManager` (its diff is `(stepId,
modelId)` only) — deliberately NOT bundled into this change.

Separately, Model Studio had grown a second registration surface: a "the reference detector"
tab (upload + presets) beside "Register" (URL only, no postprocessor field —
so a URL-registered yolonas model silently decoded as `yolo`, the exact D208
failure).

## Decision

1. **A step setting declares its per-model applicability.**
   `annotateConfigSchemaForModels` computes, from the SAME model union the
   picker offers (static ∪ custom), a `ConfigFieldBase.modelApplicability`
   annotation: `inapplicable[modelId] = reason` and
   `optionsByModel[modelId]` for labelmap-derived multiselects. The editors
   (`ConfigSchemaField`) disable an inapplicable knob WITH its reason and swap
   in the model's own options — never a live control that silently does
   nothing. The annotation rides the existing `z.custom<ConfigField>()` bridge,
   so no cap change and no framework train is needed (same compile-time-only
   pattern as D208's `yolonas`).
2. **Dropped labels are reported at load time.** `buildPoolModelConfigForStep`
   invokes `onClassMapDrop` when the resolved entry declares labels the step's
   dropping classMap removes; the factory logs it once per (step, model).
3. **The picker is mutually exclusive.** A pinned custom model hides the
   grouped catalog selector entirely; the custom list sits behind an explicit
   affordance while a catalog model is pinned (`ModelPicker` view state).
4. **One registration flow.** the reference detector tab is deleted; Register hosts model
   TYPE (the reference detector presets as default templates, or `custom` with explicit
   format + decode) × SOURCE (chunked upload, remote URL, the curated PUBLIC
   The reference detector catalog, or the operator's the reference detector+ account) through the single
   `buildRegistrationDescriptor` builder. The URL path gained the
   postprocessor declaration it was missing.
5. **the reference detector source shows the ACCOUNT's truth, never an invented list.**
   With a configured key it renders exactly `GET /v1/model/list` — whose REAL
   shape is `{ "list": [...] }` with entries `{ id, name, type, isBaseModel,
   baseModel, supportedDetectors[], trainDate, width, height }` (verified
   against the reference detector's API and the reference detector web UI's `ReferencePlusModel`
   type) — grouped Base/Custom on `isBaseModel`, the same split the reference detector's own
   settings UI draws; engine compatibility and input dimensions come from
   each entry's metadata. Import resolves `model/{id}` + `signed_url`
   server-side. Without a key, the ONLY honest offer is the publicly
   downloadable the reference detector default (SSDLite MobileDet EdgeTPU,
   `google-coral/test_data`, COCO-91 labelmap) plus key onboarding — no
   invented, non-downloadable families. The key is an addon-settings password
   field (also editable inline, write-only, same authority), used ONLY
   server-side, in no log line and no action response. The first fake-fetch
   test suite had baked in a BARE-ARRAY `model/list` response — the fake
   supplied the shape production never returns (the repo's known trap); the
   contract tests now pin the wrapped shape.

## Consequences

Any NEW step knob whose effect depends on the model must be added to
`model-knob-applicability.ts` or it reintroduces the silent-no-op class this
removes. The annotation is computed against the OFFERED union — a model
registered after the schema fetch is annotated on the next `getSchema`.
`nmsIouThreshold` remains dead at runtime until the settings→pool threading is
built (train-note; UI now at least explains fused-NMS models). The
`minLandmarkFaceSize` cross-step dependency (custom face detector without
landmarks) stays review-only.

## Enforcement

`model-knob-applicability.spec.ts` pins the matrix rules (fused-NMS, macro
reachability, model-scoped options, rectify). `custom-model-pool-config.spec.ts`
pins the classMap-drop report. `model-picker-custom-exclusive.test.tsx` pins
picker exclusivity; `config-schema-field-model-applicability.test.tsx` pins
disable-with-reason. `registration-flow.test.ts` pins the unified builder
(byte-parity with the legacy the reference detector builder included).
