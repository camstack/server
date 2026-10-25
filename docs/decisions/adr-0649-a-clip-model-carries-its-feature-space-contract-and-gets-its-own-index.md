---
id: D649
title: A CLIP model carries its own feature-space contract on its catalog entry, and every model family gets its own vector index — a write, a search and a count name one index, a delete reaches all of them
status: accepted
date: 2026-09-26
supersedes:
last-verified: 2026-10-01
applies-to:
  - packages/types/src/types/clip-model.ts
  - packages/types/src/capabilities/embedding-encoder.cap.ts
  - packages/addon-post-analysis/src/shared/clip/clip-model-registry.ts
  - packages/addon-post-analysis/src/pipeline-analytics/clip-space-plan.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/object-embedding-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/embedding/embedding-dispatcher.ts
  - packages/addon-post-analysis/src/embedding-encoder/addon/active-clip-model.ts
  - packages/addon-post-analysis/src/embedding-encoder/addon/clip-text-engines.ts
  - packages/addon-post-analysis/src/embedding-encoder/addon/crash-budget.ts
  - packages/addon-post-analysis/src/embedding-encoder/addon/model-engine-slot.ts
  - packages/addon-post-analysis/src/embedding-encoder/addon/model-requirements.ts
  - packages/addon-post-analysis/src/embedding-encoder/addon/failed-models-report.ts
  - packages/system/src/download/model-downloader.ts
  - scripts/build-siglip2-model.py
---

## Context

MobileCLIP S1, the semantic-search model, is Apple research-only. The
licence-clean replacement picked by the 2026-09-26 spike
(planning repo: superpowers/specs/2026-09-26-replacement-models-spike.md) §1) is SigLIP2 <!-- drift-ok: the spike spec is committed separately, from the main checkout -->
B/16-224 (Apache-2.0): caption R@1 0.708 vs 0.622, crop mAP 0.942 vs 0.857.
The model converted cleanly. Putting it behind the existing code did not: every
fact about "a CLIP model" was hard-coded where it was used, and each one failed
**silently** for a second model.

- `isClipObjectEmbedding` tested `embeddingModelId.startsWith('mobileclip-')`:
  every SigLIP2 vector would have been dropped before the store with no log line.
- `getModelMeta` answered an unknown id with MobileCLIP S1's meta, so the
  encoder's `output.slice(0, 512)` would have cut a 768-d query to 512 dims and
  ranked noise.
- `text_encoder_inference.py` hard-coded a 77-token window, pad 0; SigLIP2's
  tower has 64 positions and was trained lower-cased.
- `object-clip` is declared at 512; `vector-store` refuses to redeclare it at
  768 even empty (deliberately — a dim change is the signal the encoder
  changed), and has no drop.
- The search floor was a cap default of 0.2. Measured through the shipped
  formats on 300 COCO caption-image pairs, 0.2 keeps 96.3% of matched pairs on
  MobileCLIP S1 and **4.3%** on SigLIP2 (whose 96% threshold is 0.099–0.101).
- The text encoder took its model from its own addon config, while every writer
  of the index pins the cluster row (`clusterModel:clip-embedding`).

And one the spike did not list, found while writing the catalog entry:
`ModelDownloadService` puts every model's sibling files in ONE flat directory,
and MobileCLIP's CLIP BPE is already `tokenizer.json`. A SigLIP2 tokenizer under
the same name would have overwritten it (or been overwritten), and whichever
model downloaded second would have tokenised with the other's vocabulary.

## Decision

**A CLIP model is a catalog entry with a `clip` block** (`ClipModelMetaSchema`
in `@camstack/types`): its text model, dimension, vector index, tokenizer file,
token window, pad id and search floor. A model without one is not a CLIP model
to any consumer, and there is no fallback: an unknown id resolves to `null` and
every caller refuses by name. The encoder and pipeline analytics read the block
through one registry (`clip-model-registry.ts`); a user CLIP model from Model
Studio joins by carrying the same block.

**One vector index per feature space.** MobileCLIP S1 and S2 keep the
historical 512-d `object-clip` (separated by each row's `modelId`, as before);
any other model gets `object-clip-<model>`. A write, a search and a
model-space count go to the index of the model they name; **a delete, a scan
and a wipe reach every index**, so a track's vector cannot outlive it in the
index nobody searches today. Every index is declared from the metadata before
it is read, written or deleted from, so a delete on an install that never ran a
model is a declared no-op, not a `never declared` throw.

**The text encoder encodes in the cluster row's model** (re-read every 30 s; a
failed read keeps the last value read, D49), or in the model a caller names:
`searchObjectEvents({ modelId })` searches any model's index, which is how the
MobileCLIP index stays searchable through a cutover and its rollback window.

**The search floor is the model's.** An absent `minScore` resolves to the
model's `searchMinScore` (MobileCLIP 0.2, SigLIP2 0.1) scaled by a
model-relative `strictness` (1× / 1.25× / 1.5× — exactly the admin UI's old
0.20 / 0.25 / 0.30 on MobileCLIP). An explicit `minScore` is honoured verbatim:
the same URL must not mean different things on two installs.

**The rebuild pins one model and refuses by name** (D54), before any node is
asked or key frame read, in ONE field, `refusal`
(`RebuildObjectEmbeddingsRefusalSchema`). The model is the one the OWNER
confirmed by two agreeing reads (D651's `ClusterPinConfirmer`); an unconfirmed
choice refuses under the confirmer's own reason (`owner-not-ready`,
`method-unavailable`, `reads-disagree`, …), and a confirmed id with no CLIP
metadata refuses as `not-a-clip-model`. It never starts by itself — the
operator runs it.

**Scene monitors refuse with a reason rather than re-capture.** A reference
embedded by another model is gated out and the scene reports `unknown` /
`encoder-model-changed` while its held state survives (tested in
`scene-engine.spec.ts`). Automatic re-capture was rejected: the operator's
threshold is a cosine in the OLD model's band, and the stored reference is a
downscaled thumbnail, not the crop the live check encodes.

**Vehicle type from the CLIP vector is a seam, not a label source**
(`clip-zero-shot.ts`): prototypes, a margin-gated argmax and named refusals.
Wiring it would make it a second writer of the tier-2 vehicle subtype next to
the `vehicle-type` step; which one wins per camera is its own decision.

SigLIP2 ships **selectable, not the default**. Artefacts:
`scripts/build-siglip2-model.py` (hosted under `clip/siglip2/`, add-only).

Rejected:

- **A `dropIndex` on `vector-store` and a rebuild in place.** It destroys the
  rollback: for the whole pass search would rank a half-empty index, and the
  MobileCLIP vectors of tracks whose key frame is gone would be lost for good.
- **Rescaling a caller's `minScore` per model.** The viewer and share URLs send
  0.2 explicitly; silently turning that into 0.1 would make one number mean two
  things. The viewer instead stops sending a default (a viewer release).
- **Deriving the index from the dimension** (`object-clip-768`). Two 768-d
  models (SigLIP2, jina-clip) are still two spaces.
- **An int8 text tower** (283 MB, 37 ms, min cos 0.93 to fp32) instead of fp16
  (565 MB, 121 ms, cos 1.0000). Kept as the size fallback; not hosted.

**A tower's `failed` state is per NODE, in memory, and only the ENGINE stage
spends it.** The crash budget (D6) counts a spawn that fails, a process that
dies before ready, a crash after load — and nothing else. The stage before the
engine (the model download, the embedded Python, its requirements) is a
different failure with a different owner, and its own bound (round 5): refused
per request by the shared code `EMBEDDING_REQUIREMENTS_UNAVAILABLE`, logged
once when it starts and once when it ends (with how many requests it refused),
never counted against the crash budget — a 30 s hub outage used to burn the
three attempts in seconds and leave CLIP `failed` until an operator noticed,
for a model that had never been spawned. The split is structural: `build()`
resolves requirements and constructs the engine, the slot calls
`initialize()`, so the slot knows which stage threw. **A failed attempt starts
a cooldown** — 5 s, doubling per failure to 5 min — consulted on demand
(`RequirementsGate.check`) before any build, never by a timer: a request inside
it is refused at once and downloads nothing, so a caller asking at request rate
costs one download attempt per cooldown, not one per request. **A
requirement that can NEVER be met** — an id the catalog does not know, a
catalog entry with no onnx build (read from the entry's STRUCTURE before any
download, never from the downloader's "has no onnx format" wording), a model
URL answering 404/410 (typed `ModelDownloadHttpError` in `@camstack/system`,
classified by STATUS, never by wording), a declared sibling that is not there
— is marked `PermanentRequirementsFailure` by the one place that can tell, and
after 3 such PERMANENT attempts (D6's bound, which round 4 had removed for this
path) the model is terminally `requirements-failed` — a transient attempt in
the same episode lengthens the cooldown but is not counted toward the bound, so
two outages and one 404 are not terminal (`model-requirements.spec.ts`): refused by `EMBEDDING_REQUIREMENTS_FAILED`,
ONE error logged, listed in `getInfo().failedRequirements` beside
`failedModels` with its node, cleared by the same `resetFailedModels` or model
change. A transient failure never goes terminal — it only cools down. Both
states live in the encoder process of the node concerned, so a runner respawn
clears them; every row of `getInfo().failedModels` / `failedRequirements` and
every `resetFailedModels` result names its node; `embedding-encoder` is a
global collection with one provider per node and a call that names no node is
the HUB's answer (no global collection fans out across nodes), so a fleet view
is one `getInfo({ nodeId })` per node, and a node the reader could not ask is
UNKNOWN (D315) — as is `failedModels === undefined`, which only a pre-budget
encoder answers. Every refusal is ONE of three shared codes (`@camstack/types`,
the `VECTOR_INDEX_DIM_CONFLICT` pattern), carrying code, model, tower and node
in its token; the post-analysis embedding dispatcher classifies on the token
(`embeddingRefusalOf`) and counts refusals per (camera, code, model), one line
per interval with `tags.deviceId` and the code's recovery, instead of one WARN
per track; a camera that embeds again reports what was still counted at once.
A model change clears the state of the model the row now NAMES, not every
model: a rollback to a model that crashed three times must not buy three more
spawns nobody asked for, and a search still naming it is refused with the hint.

**Which of this is live.** The TEXT tower is the live path: every semantic
search encodes its query there. The IMAGE leg (`embeddingEncoder.encode` →
`PythonRawTensorEngine`) has no working caller today. Its call sites remain
(the post-analysis embedding dispatcher, which discards the vector, and the
scene monitors). But `embedding-models.ts` retired the onnx vision builds on
2026-08-21 and the image catalog carries none, so every call is refused. Since
this record's final commit that refusal is a permanent requirement, decided by
structure. The vectors in the object index come from the pipeline runner's
`runDetailSubtree` (addon-pipeline), not from this cap. The image-side
hardening above (slot, budget, cooldown, refusal counting) guards that dormant
path so it cannot fail loudly or expensively if it is ever revived. It is not
what serves the fleet.

**The active model's text tower is never idle-evicted.** Before D649 the one
tower lived for the whole process, and the steady-state search must not start
paying a Python spawn plus a model load after a quiet quarter hour. So the
idle sweep exempts the model the encoder currently follows
(`ActiveClipModel.known()`, the last row read). It lets go only the OTHER
towers once they have been idle for `TEXT_ENGINE_IDLE_MS`: SigLIP2 after an
admin comparison, or the old model after a flip. When the active model is
unknown (no read has ever succeeded), the sweep evicts nothing, which keeps
memory as before.

## Release order

THREE packages, in this order, each **with, or right after**, the one before —
never long apart, never skipped:

1. the `@camstack/server` closure that carries these types;
2. `addon-post-analysis` (the encoder, the store, the search floor);
3. `addon-pipeline`, which carries the runner's `CLIP_EMBEDDING_MODELS` entry
   for SigLIP2 — the runner is what embeds tracks (`runDetailSubtree`).

Why:

- The new server drops the cap default `minScore: 0.2`. An OLD post-analysis
  behind it would pass `undefined` to the vector store and search with no
  floor at all. The new post-analysis resolves the floor itself when the input
  carries neither `minScore` nor `strictness` (`resolveClipSearchPlan` →
  the model's `searchMinScore`), so MobileCLIP gets exactly 0.2 whichever
  server it runs behind (`clip-space-plan.spec.ts`).
- `searchObjectEvents` is `caller: 'required'`: a non-admin naming a model other
  than the cluster row's is refused as `model-override-requires-admin`.
- The SigLIP2 cluster option exists in the new TYPES, so the new server alone
  lets the operator flip the row to it. A new server with an OLD pipeline would
  accept the flip and leave the runner unable to load the model it names, so
  no track embeds. Until step 3 has shipped on every node that runs the detail
  subtree, the row must not be flipped.

## Rollback

- **Rolling back `addon-post-analysis` alone, behind the new server**, is the
  forward hazard mirrored: the new server no longer defaults `minScore`, and
  the old post-analysis does not resolve the model's floor, so admin search
  runs with NO floor. Roll the server back with it, or not at all.
- **A model rollback** (the row back to MobileCLIP) is executable: `object-clip`
  is never dropped, so the MobileCLIP index is still there and still searched.
  But the tracks embedded ONLY during the SigLIP2 window are missing from it.
  Run `rebuildObjectEmbeddings` after the row is back on MobileCLIP (the pass
  pins the row's model) with `since` set to the time of the flip TO SigLIP2.

## Consequences

- A `@camstack/server` release is required (`ModelCatalogEntry.clip`, the
  cluster option, the optional `minScore`, `strictness`/`modelId` on
  `searchObjectEvents`, `modelId` on `encodeText`, the rebuild refusal fields).
- After a flip, live search reads only the new index: until a rebuild fills it,
  results are the tracks already re-embedded. A track whose key frame is gone is
  never in the new index; it stays in `object-clip` until that is wiped.
- The viewer (`semanticMinScore: 0.2`, `sscore`) sends an absolute floor and
  keeps doing so until a viewer release drops the default; before SigLIP2
  becomes the default that release must ship, or viewer search returns ~4% of
  matches.
- `OBJECT_CLIP_INDEX` is gone; the only literal left is
  `LEGACY_OBJECT_CLIP_INDEX`, kept so the orphan audit resumes its persisted
  cursor. Retiring MobileCLIP must keep `object-clip` in the registry (a delete
  must still reach it) until the index is wiped.
- Every retention delete now reaches EVERY CLIP index. On a MobileCLIP-only
  install the SigLIP2 index is declared (empty) on the first cascade. From then
  on each track batch costs 2× `deleteByIds` + 2× `getByIds` (the verify
  read-back) instead of one of each, on the sqlite thread D447 is about, and
  each orphan-audit pass adds one scan of the empty index. It is bounded by
  the number of catalog CLIP spaces (two today) and accepted: a vector
  outliving its track in an unsearched index is the failure this prevents.
- Per-node download for SigLIP2: vision 186 MB (OpenVINO) or 185 MB (CoreML),
  text 565 MB + 34 MB tokenizer where the encoder runs; MobileCLIP S1 was
  55/65 MB and 61 MB.

## Enforcement

- `clip-catalog-metadata.spec.ts`: every vision entry's `clip` block parses, its
  text model and tokenizer exist, two tokenizers never share a file name, index
  names are unique sqlite-vec tables, and an unknown id has no fallback.
- `object-embedding-index-per-model.spec.ts`: writes/search/count stay in one
  index; `deleteByTracks`, `deleteVerified`, `pruneOrphans`, `wipeAll` reach
  both; a delete failing in one index reports the track still present; an
  index that cannot be declared is reported by name (`undeclaredIndexes`,
  `failedIndexes`), never as every id surviving.
- `clip-space-plan.spec.ts`: a non-admin model override is refused by name; a
  failed encode throws with its cause instead of reading as "no results".
- `python-text-encoder-engine.spec.ts`, `encoder-follows-cluster-row.spec.ts`,
  `model-engine-slot.spec.ts`: an engine disposed mid-encode rejects it, a busy
  engine is never evicted, one image build per model.
- `track-resident-state.spec.ts`: the best-embedding selector ranks per model.
- `python-text-encoder-engine.spec.ts` (via `framed-python-process.ts`): after
  a crash or EPIPE the engine is dead by name and rejects at once;
  `encoder-follows-cluster-row.spec.ts` / `model-engine-slot.spec.ts`: a dead
  tower is dropped and rebuilt, NON-active idle towers are evicted after
  `TEXT_ENGINE_IDLE_MS` (never prefetched — the encoder is `any-node` and
  cannot know locally that it serves text queries), the active model's tower
  survives ten times the bound, an unknown active model evicts nothing, a
  slot `dispose()` cancels builds in flight.
- `embedding-encoder-addon-permanent-requirements.spec.ts`: an image entry
  with no onnx build is terminal after three attempts and the downloader is
  never asked.
- `object-embedding-index-per-model.spec.ts`: an UNREACHABLE provider leaves
  the ids `stillPresent`; only a dimension REFUSAL is `undeclaredIndexes`,
  classified by the ONE code `VECTOR_INDEX_DIM_CONFLICT` the provider throws
  (`vector-index-vec.spec.ts` asserts it) — never by matching its wording.
- **Crash budget (D6):** a tower that crashes after loading, or whose
  `initialize()` fails, `MAX_CRASHES` times within `CRASH_WINDOW_MS` goes
  terminally `failed` (`crash-budget.ts`): refused before anything is spawned
  by the ONE code `EMBEDDING_MODEL_FAILED` (`embedding-model-failed.spec.ts`
  in `@camstack/types`: built and read through the helpers, a transport
  re-wrap survives, prose about a failed model is not the refusal), ONE error
  logged, listed in `embeddingEncoder.getInfo().failedModels` with its node,
  cleared only by `embeddingEncoder.resetFailedModels`, by the cluster row
  naming that model, or by a runner respawn (it is in memory) — never by a
  timer. `python-text-encoder-engine.spec.ts` drives it through a real engine
  over a mocked spawn; `model-engine-slot.spec.ts` for the image tower.
- **Requirements are not crashes:** `model-engine-slot.spec.ts` and
  `encoder-follows-cluster-row.spec.ts` throw from `build()` five times against
  a budget of two — `budget.failed()` stays empty, the refusal carries
  `EMBEDDING_REQUIREMENTS_UNAVAILABLE`, ONE warn at the transition, one info at
  recovery carrying the refused and attempt counts, and nothing is constructed;
  with fake timers an hour passes and no attempt happens without a request.
  `embedding-encoder-addon-node-and-requirements.spec.ts` boots the REAL addon
  with `ensurePython → null` and sees both towers refused by name,
  `failedModels: []`, `failedRequirements: []`, no budget line — and
  `ensurePython` called ONCE per tower across eight requests.
- **Cooldown and terminal requirements (round 5):** `model-requirements.spec.ts`
  — the cooldown starts at the base, doubles per attempt, stops at the cap, is
  consulted on demand (a request inside is refused at once, one past it may
  build), a transient failure never goes terminal after ten attempts, a
  permanent one is terminal on the third with ONE error and a row naming the
  node, no cooldown ever ends the terminal state, reset clears both and names
  only what was terminal, per model. `model-engine-slot.spec.ts` — twenty
  requests inside the cooldown call `build()` zero times; a permanent failure
  builds three times then never again until `reset`. `embedding-model-failed.spec.ts`
  — both new codes round-trip through the token and are NOT the crashed-tower
  refusal. `failed-models-report.spec.ts` — a terminal requirement is reported
  beside `failedModels` with its node and shares `resetFailedModels` and the
  model-change clear.
- **Node attribution:** `failed-models-report.spec.ts` — every row names the
  node the budget stamped (never re-derived), a reset result names its node,
  a node with the budget answers `[]`, never `undefined`; the addon spec sees
  `getInfo().nodeId` and `resetFailedModels().nodeId` equal the LOGICAL node
  (a forked child's `agent-b/embedding-encoder` is `agent-b`).
- **The detail plane counts, not logs, every refusal by code:**
  `embedding-dispatcher.spec.ts` — three refused tracks on one camera are ONE
  `Embedding refused` line with `tags.deviceId`, the code, model, tower, node
  and that code's recovery (a FAILED model: the reset; requirements: the
  cooldown); two cameras are two lines; a requirements refusal is counted the
  same way; a camera that embeds again reports its pending count at once
  (`closing: 'ended'`); `stop()` reports the rest (`closing: 'stopped'`), in a
  `finally`; any other embed failure keeps its per-track WARN.
- **A model change clears the model it names:** `failed-models-report.spec.ts`
  — after a rollback the model left behind is still refused by name.
- **Two gates are deliberately double-guarded**, and the disarm table says
  exactly how (D649 round 4, measured): the image slot's `budget.check` runs
  before the in-flight lookup AND inside the switching chain — removing either
  alone keeps `model-engine-slot.spec.ts` green, removing both goes red. The
  idle eviction's busy test is a FILTER over the candidates and a per-tower
  RE-CHECK before each dispose — removing the filter alone stays green (the
  re-check catches everything it catches), the re-check alone goes red on its
  own test, both removed goes red. Each site carries the same note.
- `clip-space-plan.spec.ts`: the wipe button turns a partial wipe into a named
  `wipe-incomplete` error; an unavailable store is `wipe-store-unavailable`.
- `encoder-follows-cluster-row.spec.ts`, `clip-space-plan.spec.ts`,
  `clip-model-meta.spec.ts`, `python-text-encoder-engine.spec.ts`,
  `test_text_encoder.py` (SigLIP2 ids against the reference processor).
- `scripts/build-siglip2-model.py` exits non-zero on any cross-format,
  tokenizer-parity or embedding-space (D209) miss.
- Each gate was disarmed once and went red (D649 report; round 4's disarm
  table is in its commit).
