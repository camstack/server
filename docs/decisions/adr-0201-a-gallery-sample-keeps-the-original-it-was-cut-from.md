---
id: D201
title: A gallery sample keeps the ORIGINAL it was cut from
status: accepted
date: 2026-08-20
supersedes:
applies-to:
  - packages/addon-post-analysis/src/pipeline-analytics/photo-enrollment.ts
  - packages/addon-post-analysis/src/pipeline-analytics/photo-enroll-actions.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/identity-store.ts
  - packages/addon-admin-ui/src/lib/photo-enroll.ts
  - packages/addon-admin-ui/src/components/detection-intelligence/PhotoEnrollDialog.tsx
---

## Context

Until now an enrolled face sample carried exactly one artefact: the 112×112
aligned template the embedder was fed. That is precisely the right thing to
store for MATCHING — it is 1:1 with the vector — and it is the wrong thing to
store for SURVIVING, and both halves were learned the hard way inside four days:

- [D197](adr-0197-an-exemption-from-retention-is-void-on-the-footage-volume.md):
  those templates lived on the footage volume, which was wiped on 2026-08-17.
  28 of 32 samples lost their bytes while their rows and their `coverMediaKey`
  survived, so the gallery kept *claiming* images it no longer had.
- [D199](adr-0199-a-model-choice-has-a-scope-and-a-scope-change-has-a-workflow.md):
  a model change requires re-embedding every sample, and re-embedding requires
  pixels. The pass exists, it is correct, and against the real rows it answers
  `noPixels: 28` — it has done everything it can, and the answer is nothing.

The obvious repair was tried and is wrong. Re-running detection + alignment over
a stored template passes every gate (SCRFD upscales it, finds a face well over
the landmark floor) and applies a SECOND warp to pixels that are already a
template — a plausible, useless vector with nothing on screen to say so. And
the source frames it was originally cut from left on ordinary retention weeks
before the wipe, so there was nothing behind the template either.

What is left is the thing the OPERATOR still has: the photograph. So the
question stopped being "how do we recover the pixels" and became "why does a
sample not keep an original that outlives everything".

## Decision

**An enrolled sample stores the original it was derived from, alongside the
template, under the same owner.** A photo-enrolled sample writes two blobs owned
by the identity — `faceCrop` (the exact aligned model input, which `mediaKey`
points at and which a re-embed pass sends as a whole frame) and `fullFrame` (the
photograph, verbatim, named by the new `sourceMediaKey`). Both therefore land on
`galleryMedia`, derived from the retention exemption, never on footage.

Two constraints on how such a sample is produced, because each has an obvious
cheaper version that is wrong:

1. **Analysis and confirmation are separate, and analysis enrols nothing.** The
   server finds every face and holds their vectors; the operator names them. A
   family photograph is several people and one of them may be a stranger.
2. **The pixels are cut by the pipeline, and the stamp is read back.** The photo
   goes to `pipelineExecutor.runPipeline` on the `'full'` plane as a
   `face-detection` root with `face-embedding` nested — the same executor code
   the live detail plane runs — so the alignment stays the single derivation of
   [D52](adr-0052.md) and the model comes
   from the cluster row by construction (D199). Nothing in the enrolment path
   names a model; it stamps the `embeddingModelId` the run reported.

## Consequences

- The gallery becomes rebuildable. A model flip is now: change the row → the
  re-embed pass converts every photo-enrolled sample from its stored template →
  `faceReembedProgress` says per identity when it is safe. A photo the pass
  cannot handle can still be re-uploaded, forever.
- Storage grows by one photograph per sample instead of one 112² JPEG. The
  gallery is tens of rows, so this is tens of megabytes on the DATA volume, and
  it is the volume with no quota — a real cost, accepted deliberately, and the
  reason `identity` blobs are exempt from every sweep is the same reason nothing
  else will reclaim them.
- Therefore **every path that removes a sample must remove BOTH blobs.**
  `removeSample` does; an orphan under `identity` would live forever.
- A detected-face sample still has no original, and nothing here changes that:
  its source frame is footage and footage ages out. The two sources are now
  materially different in what they survive, so the UI marks a photo sample on
  its tile rather than leaving the two indistinguishable.
- The 24 px landmark-precision floor is NOT relaxed for photographs and must not
  be. It is measured in the space the detector ran in, which for a photograph is
  the photograph, so it is cleared by construction — a photo-only floor would be
  a second knob disagreeing with the first.

## Enforcement

- `photo-enrollment.spec.ts` pins all of it: analysis enrols nothing; the stamp
  is the model that ran (sabotaged to a constant, the test goes red); the
  promiscuity gate runs before any byte is written; a failed row reclaims both
  blobs; and `locationForOwnerKind('identity')` is asserted against the REAL
  derivation rather than restated, so the D197 claim cannot become prose again.
- `photo-enroll.test.ts` pins the client half: a face the server refused is
  never planned for enrolment.
- The single-crop-derivation half is already guarded by
  `scripts/check-clip-crop-single-owner.ts`, and the model-scope half by
  `scripts/check-cluster-model-scope.ts`. Nothing new was needed for either,
  because this path goes THROUGH them rather than around them.
- Nothing guards "a sample keeps its original" for future sample SOURCES —
  review only. A third source would have to make the same choice by hand.
