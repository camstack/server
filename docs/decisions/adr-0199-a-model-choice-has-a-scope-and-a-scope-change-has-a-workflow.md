---
id: D199
title: A model choice has a scope, and a scope change has a workflow
status: accepted
date: 2026-08-20
supersedes:
applies-to:
  - packages/types/src/pipeline/cluster-model-scope.ts
  - packages/addon-pipeline/src/detection-pipeline/cluster-model-resolution.ts
  - packages/addon-pipeline/src/detection-pipeline/step-resolution.ts
  - packages/addon-pipeline/src/shared/cluster-model-source.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-reembed-pass.ts
  - packages/addon-post-analysis/src/pipeline-analytics/cluster-model-pin.ts
---

## Context

Every pipeline step's model was a per-`(node, device)` choice, and for almost
every step that is right: two nodes may run two detectors because nothing
compares their outputs. A box is a box.

Two steps are not like that. `face-embedding` and `clip-embedding` produce
**vectors that land in ONE shared index** — `identity_samples` and
`vec_object_clip` — and are ranked against each other by cosine similarity.
Cosine similarity between two encoders is not a weak signal, it is a meaningless
number, and nothing inside a vector can reveal which encoder produced it. So a
per-node model for those two is not a flexible setting, it is a way to corrupt
an index silently.

[D52](adr-0052.md) already made this argument one level up, about the crop: the
rebuild and the live path each derived their own rectangle and every rebuild
poured a second feature space into the index it existed to keep consistent. The
crop was made a single cluster-wide value. The ENCODER was left per-node.

Two things then forced the issue on 2026-08-20:

1. **The protection everyone believed in did not exist.** `face-matcher`'s
   same-model gate was a tautology until that morning ([D196]): `DetailResult`
   carried no `embeddingModelId`, so `ingestFaceDetail` filled `probe.modelId`
   from `this.gallery[0].modelId` — the gate compared the gallery with itself
   and could not fail for any input. The repo said everywhere that flipping the
   face model would "unlink every enrolled face"; it would in fact have scored
   AuraFace vectors against ArcFace samples in one cosine space, in silence.

2. **Even with the stamp, there was no way to act on it.** A vector stamped with
   the old model is not corrupt, it is STRANDED: readable, matchable by nothing.
   `runDetailSubtree` requires an attach and is unusable over history;
   `runStatelessStep` runs ONE step, so `face-embedding` alone over a source
   frame becomes a synthetic root with no landmarks and no warp. There was no
   re-embedding path for faces at all, and the obvious one corrupts — the stored
   sample media is the ALREADY-ALIGNED 112×112 template, so re-running
   detection + alignment over it clears every gate and applies a second warp.

The first attempt at the rule here was stricter and wrong: a node that could not
serve the cluster model DROPPED the step. `dispatch-capability-gate.spec.ts`
caught it. On a Coral (`tflite`, and no face embedder has ever shipped a tflite
build) the existing node-local engine fallback rescues `face-embedding` onto the
node's own engine; dropping it would have removed that rescue and stopped
producing faces on every mixed-accelerator node — a regression wearing a safety
rule's clothes.

## Decision

A `StepDefinition` declares `modelScope: 'node' | 'cluster'` (absent = `'node'`).

For a `'cluster'` step the model comes from ONE `pipeline-orchestrator` global
row, read cluster-scoped — never with a `nodeId`, never off the attach config —
and any incoming per-`(node, device)` `modelId` is a leftover that the row
overrides. What the scope forbids is the SUBSTITUTION every other step gets: when
the chosen model has no build for a node's format, `resolveModelForFormat` would
hand back that format's default encoder, and the node must instead **refuse to
substitute** and say so with `tags: { deviceId }`. The step keeps the pinned id,
so the placement machinery that already exists (node-local engine fallback,
detail-plane device jump) still does its job, and only after those fail is the
configuration loud rather than quietly wrong.

And a change to that row is not complete when it is saved. Each cluster-scoped
step owns a **bounded, resumable re-embed pass** that brings the stored vectors
into the new space, skips what it cannot recover, and reports coverage — for
faces, per identity.

## Consequences

- **The defaults ARE today's behaviour.** `arcface-r100` and `mobileclip-s1`, so
  declaring the scope changed nothing at deploy. That property is what makes the
  change safe to ship ahead of any flip, and it is asserted in three suites.
- **The per-node model field for these two steps is now a leftover**, and the
  admin-ui matrix mirrors the cluster row instead of showing it — [D62] applied
  to a model choice: the editor stores nothing of its own, it writes the
  authority and names it.
- **A node can now contribute nothing to an index**, on purpose, and that has to
  be visible rather than inferred — hence the warning before the choice in the
  drawer and the deduped refusal line at dispatch.
- **`unrecoverable` can never be derived.** The obvious derivation — "no
  `mediaKey`, no pixels" — is wrong on this cluster: of the 28 real gallery rows,
  ONE has a null key and 27 carry a well-formed key whose blob is gone
  ([D197]). It is an OBSERVATION the pass returns from probing, and unmeasured
  means unmeasured, never "all fine".
- **A re-embed pass with an unchanged model must be a declared no-op.** "Read the
  right state" and "did nothing" leave an identical index behind, so the counter
  is the only difference and it has to be trusted.
- **The AuraFace flip is still blocked**, and this record does not unblock it.
  Nothing about the mechanism restores the 27 missing blobs; the flip waits for
  photo enrolment, and then runs THROUGH this workflow.

## Enforcement

- `scripts/check-cluster-model-scope.ts` (wired into CI) fails the build when the
  catalog's `modelScope: 'cluster'` declarations and the
  `CLUSTER_MODEL_SCOPED_STEPS` registry in `@camstack/types` disagree — on
  membership, on the default, or on the option list, in BOTH directions. The
  registry exists because the orchestrator, post-analysis and admin-ui all need
  the set and may not import an addon; a hand-copied list that stops matching is
  how a setting silently stops arriving while both sides still look correct.
  Verified to bite by breaking it.
- `cluster-model-settings.spec.ts` asserts no field on the section carries
  `perNode` — one word that would project a per-node value and put two encoders
  in one index, and that would read as an improvement in review.
- The refusal, the re-embed passes and the no-op are tested against the system's
  REAL rows (`__tests__/fixtures/`), which is what caught the `unrecoverable`
  bug above.

[D52]: adr-0052.md
[D62]: adr-0062.md
[D196]: index.md
[D197]: adr-0197-an-exemption-from-retention-is-void-on-the-footage-volume.md
