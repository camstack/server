---
id: D209
title: A hosted embedding-model artifact is not verified until its embedding SPACE is — and an unverified format is withheld from the catalog
status: accepted
date: 2026-08-21
supersedes:
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/registry/model-catalogs.ts
  - packages/addon-post-analysis/src/embedding-encoder/catalogs/embedding-models.ts
  - packages/addon-post-analysis/src/shared/clip/clip-model-registry.ts
---

## Context

Task #8 asked to prune "the worse of the two clip models". The census found the
premise false — there was no v1/v2 pair anywhere (repo, git history, HF, the
deployed hub, the vector index). What the catalog actually had was the Apple
MobileCLIP tier family S0/S1/S2, each hosted on HF in three formats: fp16
OpenVINO, fp16 CoreML, and int8 ONNX.

Measuring the tiers on 150 real fleet crops (the D52 crop convention, the
production preprocessing byte-for-byte) surfaced something worse than a bad
tier: **the int8 ONNX vision exports were never in the same feature space as
their text encoders**. Matched image↔text cosine ≈ 0.01 for S1/S2 (0.09 for
S0) where the fp16 OpenVINO/CoreML builds of the *same checkpoints* score
≈ 0.22 — and the S1 onnx image space had collapsed (mean pairwise cosine 0.73
across unrelated crops; the fp16 space averages 0.47 across *related* ones).
CoreML was cross-checked against OpenVINO at cos 0.99 per image: one space.
The int8 *text* onnx encoders are fine — live search proved it daily.

Nothing had ever caught this because every catalog check verifies that an
artifact **downloads and loads** (URL 200, session opens, shapes match).
Nothing verifies what the numbers *mean*. And a broken embedding model doesn't
crash: the hub's cpu/onnx fallback engine had `clip-embedding/mobileclip-s1`
loaded and was writing collapsed junk into `object-clip` at ~170 vectors/day —
provable live, because junk-space and real-space vectors are nearly orthogonal
(cross-space cosine caps at 0.15) while a junk-produced probe matched the live
index at 0.94. Those vectors match no text query ever; the symptom is "this
track never shows up in search", per camera, with nothing in any log.

The measured tier comparison, on the healthy fp16 engines, for the record:
S0 mAP .792 / zero-shot .940, S1 .794/.933, S2 .811/.980 (12 NVR-style
queries). S0 collapses on fine-grained queries ("a cat" AP .37 vs .62 for S1)
and has no niche — every fleet node serves S1. S1 stays default; S2 is the
upgrade option; a rename of `mobileclip-s1` was declined: the id carries
Apple's tier name, not a version suffix, and a cosmetic rename costs a full
13.7k-vector re-embed.

## Decision

An embedding model format enters (or stays in) a catalog only after its
embedding space is verified: matched image↔text cosine in the expected band on
reference images, and same-image cosine ≈ 1 against an already-trusted build
of the same checkpoint. An artifact that fails this is not shipped as a lesser
option — it is **withheld from the catalog entirely**, because for a
cluster-scoped step the format entry is what lets an engine of that format
serve the model, and D199's refusal machinery only protects against models a
node *cannot* load, not against models it can load and shouldn't. Concretely:
the clip vision entries ship openvino + coreml and no onnx; `mobileclip-s0`
is retired; re-adding an onnx build requires a new export verified as above
BEFORE upload.

## Consequences

- A pure-onnx engine cannot serve `clip-embedding` at all now; the node-local
  engine fallback rescues the step onto openvino/coreml, which every fleet
  node has. A future onnx-only node would simply not contribute clip vectors
  (D54 semantics) — visible, not corrupting.
- The `object-clip` index carried the junk vectors until the full rebuild
  completed; anything embedded through cpu/onnx between the int8 upload and
  2026-08-21 was invisible to search until re-embedded.
- The `embeddingEncoder.encode` image leg (the legacy dispatcher's encoder,
  OpenAI mean/std preprocessing MobileCLIP never used, output discarded by its
  only caller) lost its model: `embeddingEnabled` now defaults OFF and the
  live row was flipped OFF. Excising the dispatcher + `encode` is follow-up
  work; the cap method stays until a cap change can ride an image release.
- The int8 vision onnx files (and the s0 tree) still exist on HF until the
  operator deletes them — no catalog references them, so they are inert, but
  `hf repos delete-files camstack/camstack-models "clip/mobileclip-s0/*"
  "clip/mobileclip-s1/onnx/camstack-mobileclip-s1-vision.onnx"
  "clip/mobileclip-s2/onnx/camstack-mobileclip-s2-vision.onnx"` finishes the
  job.

## Enforcement

`model-catalogs-clip.spec.ts` and `mobileclip-text-models.spec.ts` pin the
surviving tiers and assert `formats.onnx` is undefined on every clip vision
entry, with the misalignment numbers in the comment;
`scripts/check-cluster-model-scope.ts` keeps the operator dropdown equal to
the catalog. The space-verification step itself is procedure (review only):
it lives in this record and in the sessions log entry of 2026-08-21.
