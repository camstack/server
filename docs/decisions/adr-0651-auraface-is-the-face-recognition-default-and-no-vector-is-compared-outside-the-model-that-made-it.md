---
id: D651
title: AuraFace is the face-recognition default, its threshold moves with it, and no vector is ever compared outside the model that produced it
status: accepted
date: 2026-09-26
supersedes:
applies-to:
  - packages/addon-pipeline/src/detection-pipeline/registry/step-definitions.ts
  - packages/types/src/pipeline/cluster-model-scope.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/identity-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/embedding-vector-index.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-recognizer.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-settings.ts
  - packages/addon-post-analysis/src/pipeline-analytics/cluster-model-pin.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-reembed-trigger.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-reembed-pass.ts
  - packages/addon-pipeline-orchestrator/src/cluster-model-choice.ts
  - packages/types/src/capabilities/pipeline-orchestrator.cap.ts
  - scripts/face-threshold-calibration.ts
---

## Context

`face-embedding` defaulted to `arcface-r100`: a re-upload with no author, no
dataset and no licence (`license: 'UNKNOWN'`), and a ResNet34 despite its id.
CamStack is going public, and the default is what every new install downloads
and runs. `auraface-r100` (fal.ai AuraFace v1, Apache-2.0, a real iResNet-100)
has been in the catalog since 2026-08-21, with builds for onnx, openvino and
coreml, and this hub has run it through the cluster row since that day. A
read-only census on 2026-09-26 found the row `clusterModel:face-embedding =
auraface-r100` and all 97 enrolled vectors in `identity-arcface` stamped
`auraface-r100`.

Matching is per `modelId` (D196, D199), so a model switch is safe only if no
path can put two models' vectors in one comparison. Reading that path end to
end found two places where one could:

1. **A torn restamp.** `restampSample` writes the new vector to the index and
   then the row's `modelId`. If the row update fails, or the process dies
   between the two, the index holds an AuraFace vector behind a row still
   stamped ArcFace. `loadGallery` paired the index vector with the ROW's
   stamp, and the matcher trusts that stamp. After a rollback, an ArcFace
   probe would have been scored against an AuraFace vector.
2. **The unnamed probe.** A runner that predates `embeddingModelId` sends no
   model id, and the recognizer borrowed `gallery[0].modelId`. That is a safe
   guess only while the gallery holds one model. Mid-switch it holds two, and
   the guess can name the model that did not produce the probe.

The threshold is the third leg. `similarityThreshold` defaulted to 0.55,
ArcFace's least-bad value. At 0.55 AuraFace auto-matched 1 probe in 496
(2026-08-21). fal's model card publishes benchmarks and no threshold.

## Decision

- **Default.** `auraface-r100` is the `face-embedding` `defaultModelId` in the
  step catalog and in its `@camstack/types` mirror (`CLUSTER_MODEL_SCOPED_STEPS`,
  AuraFace listed first). onnx, openvino and coreml each resolve to it; no
  per-format override is declared. `arcface-r100` stays selectable, not
  legacy, as the rollback target.
- **One model per comparison.** A gallery sample is served only when the model
  its VECTOR carries equals the model its ROW carries. A torn sample sits out,
  logged, until the next re-embed pass restamps it. A probe with no model id
  is not compared at all when the gallery holds more than one model, and that
  refusal is logged with `tags: { deviceId }`.
- **Re-embed.** No new mechanism. The existing pass of D199
  (`face-reembed-pass.ts`) is reused. It is triggered by the operator's flip of
  the cluster row: the `shouldAutoReembed` timer (60 s) starts it, and
  `embedding.reembedFaces` (admin) starts it by hand. Before it starts, the
  target model must be read successfully twice in a row, and the two reads
  must agree (`ClusterPinConfirmer`, `readClusterModelPinStrict`).
- **The OWNER answers which model was chosen.** The orchestrator owns
  `clusterModel:*`, so it answers through a cap method,
  `pipelineOrchestrator.getClusterModelChoice({ stepId })`, which returns:
  - `{ kind: 'stored', modelId }`: the key was written with a catalog id;
  - `{ kind: 'absent', defaultModelId }`: the store answered and nobody wrote
    the key, so the cluster runs the default **by absence**;
  - `{ kind: 'unreadable', reason }`: `owner-not-ready`, `store-read-failed`,
    `three-way-read-unavailable`, `invalid-stored` or `not-cluster-scoped`.

  It is built on a THREE-WAY read of the owner's own store:
  `BaseAddon.readStoredGlobalKey` over the new optional
  `ctx.settings.readAddonStoreResult()`. The forked view forwards the
  kernel's `readBlobResult`, and the in-process view wraps its throwing
  backends. Never on `readAddonStore()`, which folds a failed read into `{}`.
  The owner answers `owner-not-ready` from the first line of `onShutdown`.
  (Before `onInitialize` returns nothing can reach the method — the provider
  is registered from what it returns — so that state is not a claim.) Both
  views answer `failed`, never `missing`, while no store is wired at all
  (fix round 4): the in-process view's bootstrap fallback held no addon key
  and read as "never written" for the whole D294 window.

  **One interpretation of the stored value** (fix round 4), shared by the
  owner and the runtime (`interpretStoredClusterModel`, `@camstack/types`):
  `null` and `''` are ABSENT (the form clears a field with a `null` patch,
  and every hydrated surface reads a stored `null` as the default); any
  non-empty string is the choice, verbatim; only a non-string is
  `invalid-stored`. The id is NOT checked against the dropdown: the runtime
  pins an id the catalog does not list on purpose (a custom encoder from
  `custom-model-registry`, `cluster-model-resolution.ts`), and an owner that
  called it invalid would refuse a pass on the model the fleet is running —
  the same stored key with two meanings. On `invalid` the runtime runs the
  catalog default and logs it (`ClusterModelSource`), because a live row is
  total; the owner refuses, so no pass rewrites an index on it.

  Rejected, in this order:
  - the hydrated view (`addonSettings.getGlobalSettings`) answers
    `value ?? default`, and `BaseAddon` hydrates `{}` while its context is not
    wired, so two reads during a restart agree on a default nobody chose;
  - post-analysis reading the orchestrator's raw store
    (`settingsStore.get pipeline-orchestrator/addon-settings/root`, fix round
    2) is a shadow read of another addon's private layout. That layout
    differs between a forked addon (one namespaced blob) and an in-process
    one (prefixed rows in `addon-settings`).

  post-analysis's `readClusterModelPinStrict` calls the method through
  `ctx.api`. An orchestrator that predates it (a rolling release) answers
  `method-unavailable`: no pass runs.
- **The steady state reads once.** The automatic pass asks the owner once a
  tick; only when that answer shows a sample outside its space does it pay for
  the second read that must agree. `embedding.reembedFacesStatus` counts
  against the same owner answer and names an unreadable one
  (`modelUnreadable`) instead of counting against a guessed model.
- **A refusal that does not go away is escalated.** The same refusal reason for
  `PERSISTENT_REFUSAL_ESCALATE_AFTER` (30) consecutive reads is logged ONCE at
  warn, with the reason. A read that answers resets the count.
- **The CLIP rebuild** (`rebuildObjectEmbeddings`) overwrites every track's
  vector, so its model choice takes the same confirmation. It refuses by name in
  the rebuild's one `refusal` field, whose vocabulary carries the confirmer's
  reasons verbatim beside D649's `not-a-clip-model`. The search gate and the read-only surfaces still use
  `resolveClusterModelPin`.
- Each caller (`face-reembed-auto`, `face-reembed-operator`, `clip-rebuild`)
  owns its own confirmer and logs once per change of ITS outcome, not every
  tick. An automatic pass
  rewrites at most `FACE_AUTO_REEMBED_MAX_SAMPLES` (200) samples, logs when
  that budget stops it, and the next tick resumes. The pass pins the confirmed
  `modelId` for the whole pass, and embeds each
  stored 112×112 template through `pipelineRunner.runStatelessStep` on a named
  node (D54). A node that cannot serve that exact model ends the pass by name
  (`no-capable-node`) before any more media is read. The pass restamps
  `modelId` and `dim` only, so the D643 alignment stamp, `sourceMediaId` and
  `sourceBbox` survive it (pinned by a spec).
- **The switch window.** Between the flip and the end of the pass, a probe in
  the new model is compared only with samples already in the new model. An
  identity with fewer than `minIdentitySamples` samples there is not a match
  target, so a known face is reported unknown or as a suggestion. It is never
  matched to the wrong person. The window is bounded by one pass (25 ms pacing
  plus one inference per sample: seconds for a gallery of about 100). It is
  logged by the recognizer's `probe model has no gallery sample` line and the
  pass's start and finish lines, and `embedding.reembedFacesStatus` reports it
  per identity.
- **Threshold.** The threshold belongs to the recognizer, which generates the
  identity event. It is `FaceSettings.similarityThreshold`: a global value with
  a per-camera override. Its schema default moves with the model, from 0.55 to
  **0.45**. That is the operating point measured on AuraFace's own gallery on
  2026-08-21 (inter-identity max 0.361; (planning repo: sessions/sessions.md)), and it <!-- drift-ok: moved to the private planning repo -->
  sits above the impostor p99 of 0.33 from the 2026-09-26 gallery-shift
  measurement. The live value is set from a measurement of the live gallery,
  never by feel. **The operator authorized the recalibration** (2026-09-26):
  after release, the controller sets the global `similarityThreshold` to the
  script's value at a false-accept target of 0.001 (0.411 on 2026-09-27). The
  worst impostor pair, Dave~Carol at 0.492, sits above that bar; the
  margin (0.12) and the per-identity best-sample rule are what keep it from
  assigning. Per-camera tuning stays available as an override. `scripts/face-threshold-calibration.ts` computes the genuine
  and impostor pairwise cosines of one model's samples, read only with GET
  queries, and returns the lowest 0.001 step that lets at most the stated
  false-accept fraction of impostor pairs through. It says when the target is
  finer than 1/n. A measurement it cannot take is `null` with a reason.

## Consequences

- **This hub.** The flip changes nothing: the row is stored as
  `auraface-r100`, and every vector is already AuraFace. The global threshold
  is stored at 0.40, so the schema default does not reach it. Measured on the
  live gallery on 2026-09-26 (97 samples, 4 identities, 3,369 impostor and
  1,287 genuine pairs): impostor p99 0.309, max 0.492 (Dave~Carol).
  0.40 lets 4 impostor pairs through, and 0.45 lets 1 through. At a
  false-accept target of 0.1% the answer is 0.411. At 0% it is 0.493. The
  pairwise false-reject rates are high (0.77 at 0.411) because every weak
  detected sample is paired with every other. The matcher scores a probe
  against an identity's BEST sample, so per-probe recall is higher than the
  pairwise figure. No camera stores its own `similarityThreshold` (a
  read-only `settingsStore.get` of every camera's pipeline-analytics device
  blob, 2026-09-27: 6 blobs, none carrying the key; 26 cameras with no blob),
  so none falls to the schema default through a null or out-of-range
  override.
- **An install that never stored the row** follows the new default on
  upgrade, and its gallery re-embeds on its own (the D199 timer). Samples with
  no stored template cannot be re-embedded. They are counted as
  `unrecoverable` per identity and must be re-enrolled.
- **An install that keeps ArcFace** (row stored as `arcface-r100`) now gets
  the 0.45 default unless it stored its own threshold. The threshold is not
  keyed per model. Such an install should keep 0.55 in its global settings.
- Download per node for an install that switches: ONNX 261 MB, OpenVINO and
  CoreML 131 MB (the ArcFace builds are 130 and 65 MB).
- Formats: AuraFace has onnx, openvino and coreml builds, which covers the
  three nodes (hub: OpenVINO GPU/NPU; agent-a: OpenVINO GPU; Mac:
  CoreML). Neither face model has a tflite build, so a Coral-only node could
  not run face-embedding before this change either. Nothing moves there.
- `@camstack/types` changes, so the default reaches an unconfigured cluster
  only through a `@camstack/server` release.

**Rollback.**

1. Set `clusterModel:face-embedding` to `arcface-r100` (Pipeline → Enrichment
   models).
2. The re-embed pass moves every templated sample back. It needs no download
   on nodes that still hold `camstack-arcface-*`.
3. Set the global `similarityThreshold` back to 0.55, or to a value
   re-measured with the script and `--model arcface-r100`.
4. If the default itself must go back, revert this commit and release it.

**Release order.**

1. A `@camstack/server` release carrying the `getClusterModelChoice` cap
   method (router and access map) and the kernel's `readAddonStoreResult`
   settings view. `cluster-model-scope.ts` and `BaseAddon.readStoredGlobalKey`
   live in `@camstack/types`, which self-contained addons BUNDLE, so they
   travel with the addons. Out of order is safe: every skew cell refuses by
   name (`three-way-read-unavailable` or `method-unavailable`).
2. `git pull`.
3. `camstack deploy packages/addon-pipeline-orchestrator` (the owner method),
   then `packages/addon-post-analysis` and `packages/addon-pipeline`, then
   `packages/addon-admin-ui`.

Out of order is safe, not silent: a post-analysis that reaches an
orchestrator without the method reads `method-unavailable`, runs no pass, and
after 30 reads says so at warn.

## Enforcement

- `face-model-provenance.spec.ts`: the step default, and each of the onnx,
  openvino and coreml defaults, is AuraFace; ArcFace stays selectable.
- `cluster-model-scope.spec.ts` and `scripts/check-cluster-model-scope.ts`: the
  registry default equals the catalog default.
- `identity-store.spec.ts`: a torn restamp is not served, a restamp whose row
  update throws leaves the sample out, and a restamp keeps the alignment stamp.
- `face-probe-model-id.spec.ts`: an unnamed probe against a mixed gallery is
  not compared, and the refusal is logged with its `deviceId`.
- `face-settings.spec.ts`: the 0.45 default.
- `cluster-model-choice.spec.ts` (orchestrator): stored, absent, invalid and
  unreadable answers; `owner-not-ready` from the first line of shutdown; a
  failed store read is never absent; and a table over every value the store
  can hold on which the owner's answer and `readClusterStepModels` agree.
- `cluster-model-scope.spec.ts` (types): the shared interpretation, case by
  case. `cluster-model-source.spec.ts` (pipeline): an `invalid` row runs the
  default and warns.
- `base-addon-stored-key.spec.ts` (types), `settings-view-three-way-read.spec.ts`
  and `forked-settings-view-unwired.spec.ts` (system): a failed read stays
  failed, and no wired store is a FAILED read on both views.
- `cluster-model-pin.spec.ts`: the owner's answers map through, an
  orchestrator without the method is `method-unavailable`, and a `TypeError`
  thrown inside the owner is `read-failed`.
- `face-reembed-trigger.spec.ts`: a disagreeing second read refuses, stored
  and absent never agree, two absences confirm by absence, the log fires once
  per change (a recovery and a relapse each count as a change), and a
  persistent refusal warns once.
- `face-reembed-auto-pin.spec.ts` boots the addon with a hydrated view that
  always answers defaults. Every refusal is asserted on the confirmer's own
  line and reason, with no `auto re-embed failed`: owner not ready, a failed
  call, an invalid value, a missing method, disagreeing reads. One bounded pass
  on a stored choice, the default by absence, one owner read in the steady
  state, the status against the same answer, the operator's refusal, and the
  CLIP rebuild's refusals.
- `face-reembed-pass.spec.ts`: the per-pass budget stop is logged.
- `identity-store.spec.ts`: an unstamped vector is still served.
- `scripts/__tests__/face-threshold-calibration.spec.ts`: pair counts, the
  exact k-of-n target, the resolution flag, one model per measurement,
  zero-norm and non-finite vectors skipped and counted, `null` with a reason,
  and no hub address in the script (URL from `CAMSTACK_HUB_URL` or the
  gitignored `scratchpad/.hub`).

Each gate was disarmed once, and its spec went red. Nothing stops a future
default flip from shipping without a threshold measurement; that is review
only.
