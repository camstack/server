---
id: D196
title: A face probe names its OWN model — a gate fed by the gallery is a tautology
status: accepted
date: 2026-08-20
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/face-recognizer.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-gallery-provider.ts
  - packages/addon-pipeline/src/pipeline-runner/detail-subtree.ts
---

## Context

The cutover to `auraface-r100` was authorised as three ordered steps: flip
`face-embedding`'s `defaultModelId`, re-embed the gallery, recalibrate. Every
piece of writing in the repo said the ORDER was the whole risk — flipping before
re-embedding "strands every enrolled face", because `identity-samples` rows are
only ever compared against samples sharing their `modelId`. `model-catalogs.ts`
says it, `face-model-provenance.spec.ts` pins it, the 2026-08-19 session entry
repeats it.

**It was false, and false in the dangerous direction.** `face-matcher` does hold
the guard — `sample.modelId !== probe.modelId` skips the sample. But
`DetailResult`, the two-plane wire shape, carried no `embeddingModelId`, so
`FaceRecognizer.ingestFaceDetail` had nothing to fill `probe.modelId` with. It
used `this.gallery[0].modelId`: the probe's id was copied FROM the collection it
was about to be compared against. The gate compared the gallery with itself and
could not fire, for any input, ever.

So a flip would not have stranded anybody. It would have scored AuraFace vectors
against ArcFace samples in one cosine space, with nothing in the data to say so
— and the operator would have read the result as a threshold problem. This is
the same shape as the dead `assignUniquePerFrame` margin (2026-08-18): a guard
that exists in the source and is dead exactly where it matters. That one cost a
37% divergence rate and a re-tune of two thresholds that were never the fault.

The enrolment side had the mirror defect. `assignFace` stamped a hardcoded
`MODEL_ID = 'arcface-r100'` on every sample regardless of what the pipeline had
actually run, so the first flip would have filled the gallery with AuraFace
vectors labelled ArcFace — a lie that defeats the guard permanently, because
nothing in a stored vector can contradict its own label.

## Decision

**A face probe is matched only in the feature space it was MEASURED in, and it
names that space itself.** The model that produced an embedding travels with the
embedding across every boundary it crosses — `DetailResult.embeddingModelId`
beside `embedding`, exactly as `labelModelId` travels beside `label` — and the
consumer never re-derives it, least of all from the collection it is about to
compare against. An enrolled sample is stamped with the model the FACE ROW
recorded, never with a constant. A row that names no model is assumed
`arcface-r100`, which is a statement about history (it was the only face model
the step had ever defaulted to) and not a default for new work.

## Consequences

- Changing `face-embedding`'s model now does what the docs always claimed:
  probes find no sample in their space and NOBODY is recognised — loud,
  reversible, and visible in one log line — instead of silently cross-matching.
- The drop is audible. `face: probe model has no gallery sample` fires throttled
  per model id, carrying `deviceId`, the probe's model and the gallery's. It is
  the observable that distinguishes "the cutover is half-done" from "recognition
  broke", and it is the line to watch on the day of any flip.
- `Face.embeddingModelId` is a new nullable column; legacy rows read back
  undefined and take the historical fallback.
- The fallback to `gallery[0]` survives for a runner that predates the field, so
  version skew degrades to the OLD behaviour rather than to a blanket refusal.
  It must not be removed until no such runner can exist.
- **What this does not fix**: the gallery still cannot be re-embedded. 28 of 32
  identity samples have no retrievable pixels, and no re-embed path exists for
  faces at all (`runDetailSubtree` requires a live attach; `runStatelessStep`
  runs one step and produces an UNALIGNED vector). Both are prerequisites for
  the cutover and neither is addressed here.

## Enforcement

`detail-embedding-model-id.spec.ts` pins that the id crosses the wire and that
it never travels without its vector. `face-probe-model-id.spec.ts` pins the
refusal at cosine 1.0 against a foreign-model gallery — the case that passed
before this change — plus the audible drop and the skew fallback.
`face-gallery-provider.spec.ts` pins the enrolment stamp in both directions.

Nothing yet forbids a NEW consumer from re-deriving a probe's model from the
gallery. That is review-only, and it is the thing to look for.
