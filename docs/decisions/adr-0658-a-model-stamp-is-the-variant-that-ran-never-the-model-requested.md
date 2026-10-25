---
id: D658
title: A model stamp is the pool variant that ran, never the model requested — an engine is looked up by (step, model), and a result that names no model is refused
status: accepted
date: 2026-09-27
supersedes:
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/pipeline/tree-builder.ts
  - packages/addon-pipeline/src/detection-pipeline/engine/pipeline-model-manager.ts
  - packages/addon-pipeline/src/detection-pipeline/engine/engine-factory.ts
  - packages/addon-pipeline/src/detection-pipeline/cluster-model-switch-log.ts
  - packages/addon-pipeline/src/pipeline-runner/stateless-step.ts
  - packages/addon-pipeline/src/shared/cluster-model-source.ts
  - packages/addon-pipeline/src/detection-pipeline/step-resolution.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-embedding-audit.ts
  - packages/addon-post-analysis/src/pipeline-analytics/clip-detail-route.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/embedding-refusal-report.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/object-embedding-store.ts
---

## Context

2026-09-27, the day D649 shipped (server 1.2.394). At 09:38 the operator
flipped `clusterModel:clip-embedding` from `mobileclip-s1` to
`siglip2-b16-224`. Every runner read the row within seconds (`cluster step model
changed` on hub, agent-a and the Mac) and every node loaded SigLIP2
(`Step variant loaded {step=clip-embedding modelId=siglip2-b16-224
poolIndex=9|10}`). For the next twenty minutes `ObjectEmbeddingStore` refused
EVERY object embedding that reached it — 178 lines, all `modelId=siglip2-b16-224
dim=512 expected=768`. Neither index grew (`object-clip` stayed at 33 382, the
SigLIP2 index at 0). The dimension guard worked: nothing crossed spaces. The
operator rolled back.

The first hypothesis was that sessions attached before the flip kept their
provisioned model (D650 provisions at attach) while the stamp came from the
row. The logs and the code say otherwise. Cluster-scoped steps never carry an
attach-provisioned model to the executor: `resolveInputSteps` overwrites their
`modelId` from the row on EVERY dispatch (TTL `CLUSTER_MODEL_TTL_MS`, 60 s), and
the "Benchmark: models to load clip-embedding/siglip2-b16-224" lines at 09:38:28
are the running sessions following it. The request was right. The engine was
not.

**The root cause.** A pool keeps up to four variants of a step warm, and ONE of
them is "active" — the first one loaded after boot; `loadAdditional` never moves
it. `provider.ts` built the executable tree with
`(stepId) => dispatchFactory.getEngine(stepId)`, a lookup BY STEP, which answers
the active variant. `buildNode` then paired that handle with `modelId:
step.modelId`, the REQUESTED id, and the result assembler stamped
`embeddingModelId = childStep.modelId`. MobileCLIP was active (poolIndex 5 since
boot); SigLIP2 was loaded as a warm extra that nothing addressed. So the runner
asked for SigLIP2, ran MobileCLIP, and stamped SigLIP2. It is not specific to
CLIP: any step whose requested model differed from the pool's active variant
ran the wrong model under the right name — a face-embedding flip (ArcFace and
AuraFace are both 512-d) would have filed ArcFace vectors as AuraFace with no
guard able to see it, and `runStatelessStep` (the rebuild) would have done the
same under its pin.

Two more places trusted a model id they had not observed:

- `runStatelessStep` returned `modelId: input.modelId` — the pin echoed back —
  so the rebuild's "did the node run my pin?" check (`readRebuildStepOutcome`)
  compared the pin with itself.
- post-analysis `routeClipDetail` filed a detail that named no model under
  `embeddingEncoder.getInfo().modelId`, cached a minute: the cluster row as a
  second process read it.

And the refusal that saved the index was one WARN per track: 178 identical
lines, none of which said "no CLIP vector has been stored since 09:38".

## Decision

**An engine is looked up by `(step, model)`, and the model id the tree carries
is the variant's.** `PipelineModelManager.getVariant(stepId, modelId)` returns
the handle bound to that pair's pool index AND the model loaded there
(`StepVariantHandle`); it has no active-variant fallback and throws, naming
both, when the pair is not warm. `buildExecutableTree` takes a
`StepEngineLookup` `(stepId, modelId) => { engine, modelId }` and sets
`ExecutableStep.modelId` from the result, so every stamp the assembler writes
(`embeddingModelId`, a label's `modelId`) is the executed model. The step-only
lookups (`EngineFactory.getEngine`, `PipelineModelManager.getHandle`) are
deleted, and the pool fast paths name their model too: `getPoolIndex(stepId,
modelId)` has no active fallback, and `pipelineExecutor.inferCached` REQUIRES
`modelId` (a cap change — the synthetic benchmark passes the `rootModelId` its
warmup reported; a server closure that strips the field is refused by name). A
lookup that can answer "some variant of this step" is the trap.

**A missing variant drops that step, not the frame** (round 1; one vocabulary
with D657 since the merge). The tree is built from D657's `runSteps` — what
survived the per-step loads — never from the request, so a step whose LOAD
failed never reaches the build and is said once, by D657. A CHILD whose
`(step, model)` variant is still not warm at build time (evicted after its
load) is the same loss: a `DispatchStepLoadFailure`, reported by the same
per-camera line (`model load for dispatch failed`, `state: not-warm`,
`outcome: step-dropped`, once per camera per state), dropped with its subtree
on a live dispatch and failing the whole call (`DispatchStepsNotLoadedError`) on
an all-or-nothing one. A missing ROOT variant fails the dispatch. The frame's
`rootModelId` is read from the built tree's roots (`resolveTreeRootModelId`),
so it names the variant that ran after loads and drops.

**Composition with D657's placement.** The unanswered-cluster-step refusal lives
in the executor's `resolveInputSteps`, applied to every dispatch whatever its
pool: a step `stepsForElectedPool` kept on the elected pool and a step the
detail plane jumped to a target are refused alike, before any load, so no pool
loads a default. An all-or-nothing call naming an unanswered step fails by name
(`cluster-model-unknown`) rather than running a smaller tree.

**A cluster-scoped step runs only a model its owner ANSWERED** (round 1). The
runner reads the model through `pipelineOrchestrator.getClusterModelChoice`
(the owner's three-way answer, D651): `stored` and `absent` (the default BY
ABSENCE) are answers; `unreadable` and a throw are not. Before the first answer
the step is UNKNOWN and is refused by name, per camera once per episode
(`cluster-scoped step refused for this camera — the owner has not answered`),
re-asked every 5 s; once known, no answer keeps the last known model (D49). The
step knobs still come from the hydrated global view, where a `null` view now
changes nothing. Keeping the last row alone was rejected: at boot there is no
last row, and the boot window is exactly where the default leaked in.

**A result reports the model that ran.** `runStatelessStep` takes
`FrameResult.rootModelId` (stamped after resolution): a result that names none
is refused `execution-failed`, and one that names a model OTHER than the pin is
refused `model-not-servable` (D54, round 1) — never `ran` under another model,
so a caller that does not check (the retrain runner) cannot be fooled. post-analysis files a CLIP detail
only under the model the runner stamped (`routeClipDetailToStore`); a detail
with no `embeddingModelId` is refused by name (`no-model-id`) and nothing is
asked to guess — the `resolveClipModelId` fallback and its cache are deleted.

**A refusal is counted, not logged per track.** `EmbeddingRefusalReport` keys
refusals by (camera, model, reason: `dimension-mismatch` | `no-clip-metadata` |
`no-model-id`): the first refusal of a key logs at once, then at most one line
per 5 min with the count since the previous line; every write sweeps keys whose
interval passed, and shutdown flushes what is left.

**A running session follows a row change without a re-attach**, as it already
did for the request; now the engine follows too. Each camera says when it
starts running the new model: `cluster-scoped step re-provisioned for this
camera — now runs the new model {deviceId, stepId, from, to}`, written from the
EXECUTABLE tree once per change (not per frame; the first model a camera is seen
with after boot is recorded silently; a `replay` is not a switch).

Rejected:

- **An orchestrator re-attach of every camera on a row change**, through
  `resolveAttachPipeline`, skipping per-camera overrides. The premise was that
  running sessions keep their provisioned model; they do not — the runner
  replaces a cluster-scoped step's model from the row on every dispatch, and a
  cluster-scoped step has no per-camera or per-device override to skip
  (`resolveInputSteps` overwrites it). A re-attach would buy a second authority
  for the same fact and a detach/attach (a frame gap) per camera per flip, and
  it would not have fixed the incident: the attach's steps were never the
  problem.
- **Making the flip switch the pool's ACTIVE variant.** It would have hidden
  this incident and kept the trap: a benchmark, a replay or a second camera on
  another model would still run whichever variant happened to be active. The
  active designation now matters only to nothing on the dispatch path.
- **Keeping the post-analysis fallback for runners that predate
  `embeddingModelId`.** Every runner shipped since 2026-08-20 stamps; one that
  does not is exactly a runner whose stamp cannot be trusted.

## Consequences

- An `addon-pipeline` release fixes the incident; it is what stamps and what
  runs.
- An `addon-post-analysis` release brings the counted refusal and the
  `no-model-id` refusal. Order is free: an old post-analysis behind a new runner
  stores correctly (the stamp is now true); a new post-analysis behind an old
  runner refuses the mislabelled vectors as today, counted instead of flooded.
- Until the runner fix is on every node that runs the detail subtree, the row
  must not be flipped live: an unfixed node runs its active variant.
- **A respawn does NOT avoid the bug** (the first draft of this record said it
  did, and that was wrong). The active variant is whatever loads FIRST, and
  before round 1 the first load after boot could be the registry default:
  `ClusterModelSource` started at `DEFAULT_CLUSTER_STEP_MODELS`,
  `pickClusterStepModels(null)` answered the defaults and was trusted for the
  60 s TTL, and `getGlobalSettings` hydrates `{}` while the owner restarts. The
  `face-embedding` default was `arcface-r100` until D651 (2142a9411). So a runner
  that dispatched a face inside that window kept ArcFace active for its whole
  life while stamping the row's `auraface-r100`. **The 97 enrolled gallery
  samples stamped `auraface-r100` may include ArcFace vectors** — plausible, not
  proven. ArcFace and AuraFace are both 512-d, so no guard could have seen it,
  and the matcher's same-model gate trusts the stamp. A forced audit
  (`faceGallery.auditEmbeddings`, below) and a re-embed follow this release.
- **The forced gallery audit** (`faceGallery.auditEmbeddings`, admin, a query):
  per sample stamped with the audited model (default `auraface-r100`), re-embed
  its stored aligned template through `runStatelessStep` pinned to that model
  (the re-embed pass's own `FaceReembedEmbedder`) and take the cosine against
  the stored vector: `ok` ≥ 0.98, `mismatch` < 0.9, `inconclusive` between,
  `unmeasurable` with a named reason (`stamped-other-model`, `no-pixels`,
  `no-stored-vector`, `embed-failed`, `no-capable-node`, `dimension-differs`).
  It WRITES NOTHING.
- **The forced repair** (`faceGallery.reembedSamples({ sampleIds, modelId })`,
  admin, a mutation, ≤ 200 ids): `embedding.reembedFaces` skips a sample
  already stamped with its target, so it cannot repair what the audit accuses.
  This re-embeds EXACTLY the named samples, sequentially, one pinned model per
  call (D54), through the audit's pinned path (`FaceReembedEmbedder` →
  `runStatelessStep`, where a node that ran another model is refused
  `model-not-servable` and leaves the rotation), and REPLACES the vector even
  when the stamp already names the model. The stamp written is the model the
  node reported it RAN (`FaceReembedOutcome.modelId`); an embed that names none
  is refused `no-model-stamp`. The write is `IdentityStore.restampSample`:
  vector first, row second, read-back (D58/D651) — the stamp never moves
  without its vector, the D643 alignment stamp and the source fields are not
  touched, and `loadGallery`'s torn-stamp gate keeps a half-written sample out
  of the gallery. It shares the gallery-job exclusion (re-embed pass, photo
  pass, reset) and names every sample it could not do.
- `pipelineExecutor.inferCached` gained a required `modelId`: a
  `@camstack/server` release. Until it ships, the new runner's benchmark fast
  path is refused by name (the old closure strips the field); the `runPipeline`
  bench path is unaffected.
- The runner now needs an orchestrator that answers `getClusterModelChoice`
  (D651). Against an older one every cluster-scoped step stays refused — loudly,
  once per change and once per camera.
- The old model's variant stays warm (LRU, cap 4) after a flip until the next
  respawn: memory, not correctness.
- A child pair evicted between `ensureModelsForSteps` and the tree build is
  dropped from that dispatch (said per camera); the next dispatch reloads it.
- Vectors stored under a wrong stamp before this fix: the incident window wrote
  none (every one was refused by dimension). A same-dimension flip on an unfixed
  runner (MobileCLIP S1 ↔ S2, ArcFace ↔ AuraFace) would have been accepted with
  the wrong name; no such live flip without a respawn was found in the logs
  searched (6 h, three nodes).

## Enforcement

- `clip-stamp-is-the-model-that-ran.spec.ts` drives the REAL
  `runPipeline` over the real model manager and executor (only the pool's
  `loadModel` and handles are faked, each answering its model's dimension):
  a session attached with MobileCLIP stamps MobileCLIP at 512 until the row
  changes; after the flip the SAME attached session stamps SigLIP2 at 768; over
  a row sequence changing mid-session both ways the stamp always equals the
  executed model; `getStepVariant` refuses a non-resident pair; each camera
  writes one tagged re-provisioned line at the switch and none per frame.
- `stateless-step.spec.ts`: a node that ran another model is refused
  `model-not-servable`; a result with no model is refused.
- `cluster-model-source.spec.ts` (round 1): before any answer every cluster
  step is unknown; `owner-not-ready` keeps it unknown; `stored` and `absent`
  are answers; once known, unreadable or a throw keeps the last model; an
  unknown step is re-asked after 5 s, a known row after the TTL.
  `clip-stamp-is-the-model-that-ran.spec.ts`: in the owner's boot window the
  clip step is refused by name, NO model is loaded, and the first model loaded
  once the owner answers is the operator's.
- `missing-variant-drops-the-step.spec.ts`: a missing child variant drops that
  subtree only, a missing root throws, and through `runPipeline` the root runs
  on every frame while the camera is told once.
- `clip-stamp-is-the-model-that-ran.spec.ts`: `getPoolIndex` never answers the
  active variant for another model; `inferCached` without a model is refused.
- `face-embedding-audit.spec.ts`: ok and mismatch by cosine; every
  unmeasurable sample is named; a node that ran another model is never measured
  against and the audit stops asking once no node can serve; its dependencies
  have no write; bounded by `maxSamples`.
- `clip-detail-route.spec.ts`: a SigLIP2-stamped vector lands in the SigLIP2
  index; a detail with no model id is refused by name, writes nothing, guesses
  nothing.
- `object-embedding-refusal-report.spec.ts`: fifty refusals on one camera are
  one line; the next line after the interval carries the count and nothing is
  lost; cameras and models are separate keys; a tail is reported by the next
  write on any camera; flush reports the rest; no-CLIP-metadata is counted the
  same way.
- Each gate was disarmed and its test went red, then restored: the provider
  lookup back to by-step (2 red), `getVariant` with an active fallback (1 red),
  the per-track WARN back (5 red), no sweep on write (2 red), a route that
  guesses a model (1 red), the stateless step echoing the pin (2 red), the
  switch log unwired (1 red) and its per-frame dedup removed (1 red). One
  change stayed green, by construction: the tree taking `step.modelId` instead
  of `variant.modelId` — `getVariant` is keyed by that id, so the two are equal
  whenever the lookup succeeds. The variant's id is kept as the source so the
  stamp stays structural if the lookup ever resolves an alias.
- Round 1, each disarmed and red, then restored: an unknown cluster step not
  refused (1 red); an unanswered owner falling back to a default (2 red); the
  stateless step returning `ran` under another model (1 red); `getPoolIndex`
  falling back to the active variant (1 red); a missing child variant thrown
  instead of dropped (2 red); the provider passing no drop handler (1 red); the
  per-camera drop line not deduped (1 red); the audit never comparing (1 red);
  the audit measuring samples stamped with another model (1 red); the audit
  asking again after no node could serve (1 red, once the spec asserted the
  audit's own call count — the embedder's rotation had kept it green).
- Merge onto D657, each disarmed and red, then restored
  (`missing-variant-drops-the-step.spec.ts`, `clip-stamp-is-the-model-that-ran.spec.ts`):
  the tree built from `benchmarkSteps` instead of `runSteps` (2 red — the
  failed load is said twice); a not-warm drop on its own message instead of
  D657's line (1 red); an all-or-nothing call running without a not-warm step
  (1 red); `rootModelId` from the request instead of the tree (1 red — a
  surviving `package-detection` root was stamped with the detector that never
  loaded); an all-or-nothing call running without an unanswered cluster step
  (1 red).
- `face-sample-reembed.spec.ts` (over the real `IdentityStore` and
  `FaceReembedEmbedder`): an accused sample already stamped `auraface-r100`
  gets the new vector, stamped from what ran, alignment and source kept, the
  unnamed sample untouched; a refusing node and an old node that ran another
  model both write nothing and are named; an embed with no model is not
  written; a failed row update leaves the sample out of the gallery; a vector
  that did not reach the index never moves the stamp; unknown ids, duplicates
  and missing pixels are named. Disarmed and red, then restored: the no-model
  check removed (1), the embedder's ran-another-model check removed (1), a
  sample already stamped skipped as unforced (4), the vector gate of the write
  removed (1 — green until the vector-first spec was added), `loadGallery`'s
  torn gate removed (1), a write that did not land reported as done (1),
  duplicates re-embedded (1).
