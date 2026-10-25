---
title: Cloud training
last-verified: 2026-10-14
applies-to:
  - packages/addon-training/src/orchestrator/**
  - packages/addon-training/src/providers/**
  - packages/addon-training/src/page/**
  - packages/types/src/capabilities/training.cap.ts
  - packages/types/src/capabilities/training-provider.cap.ts
  - packages/types/src/training/trainer-contract.ts
  - packages/addon-model-studio/src/bundle/**
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/**
  - packages/types/src/retrain-review.ts
  - hf/camstack-trainer/camstack_train/dataset.py
---

# Cloud training

Fine-tune the root detector (YOLOv9) on the operator's own annotated frames, on
a GPU in the operator's own cloud account, and bring the result back to Model
Studio — compared against the model the cameras run, and registered only when
the operator says so. The decisions: [D805](../decisions/adr-0805-cloud-training-is-one-orchestrator-over-a-provider-collection-and-never-registers-on-its-own.md)
(shape), [D806](../decisions/adr-0806-a-model-that-arrives-as-files-is-imported-as-one-verified-bundle-over-peer-bytes.md)
(the import), [D807](../decisions/adr-0807-the-trainer-lives-in-its-own-hugging-face-repo-and-modal-builds-it-from-its-dockerfile.md)
(the trainer and Modal), [D824](../decisions/adr-0824-a-training-job-selects-frames-live-and-addresses-a-provider-by-entry-id.md)
(live corpus selection + provider entries), [D849](../decisions/adr-0849-retrain-annotations-keep-their-origin.md)
(annotations keep their origin), [D828](../decisions/adr-0828-training-provider-entries-are-edited-via-updateentry-not-settings-array.md)
(Providers form = `updateEntry`, not settings array). Frozen dataset versions
(D796 / D808) are removed — they are not the job authority.

Admin UI redesign (Frames corpus grid, Jobs, Providers hub):
(planning repo: superpowers/specs/2026-10-10-training-admin-redesign-design.md).

## The pieces

| Piece | Where | Owns |
| --- | --- | --- |
| `training` cap (singleton, hub-only) | `addon-training` → `training` entry | base models, planning, the job state machine, reconcile, cost guard, retention, the return flow |
| `training-provider` cap (internal collection of **types**) | e.g. `training-modal` addon | creatable cloud kinds; each type owns zero or more **entries** (credentials + defaults) |
| Provider **entry** | keyed by `entryId` | one account / workspace under a type; jobs address this id (legacy single-account configs migrate to an entry named "Default") |
| The trainer | `hf/camstack-trainer/` → HF `camstack/camstack-trainer` (AGPL-3.0) | job.json → YOLO layout → train → evaluate → floors → export → result.json + bundle.tar |
| `pipelineAnalytics.offerRetrainArchive` | post-analysis | the dataset tar for a live selection, offered over `ctx.peerBytes` |
| `customModelRegistry.importModelBundle` | Model Studio | verifying and placing the result, registering it, distributing it |

The orchestrator never imports a provider and never imports the trainer. Every
cross-addon step is a cap call; every byte crosses `ctx.peerBytes` (D613); the
trainer is reached only through files and a process boundary in the cloud
(the AGPL boundary of D661/D703).

## One job, end to end

```
planJob ──► startJob / startJobBatch ─► uploading ──► submitted ─► starting ─► running ──► collecting ──► ready
             (refusals by name;           │ offerRetrainArchive      │ provider.getJob +      │ readResult, offerArtifact,
              batch = N sequential jobs)  │ → provider.uploadDataset │ listJobEvents (30 s)   │ sha256 vs result.json,
                                          │   (streamed, hashed)     │ cost / runtime caps    │ cleanupJob (dataset gone)
                                          └ submitJob(job.json)      └ CAMSTACK_EVENT → stage, epoch series, log tail
ready ──Register──► registered ──Canary──► canary ──Rollback──► registered
  └─Discard──► discarded         (importModelBundle, distribute)
any ──► failed{reason}   cancelling ──► cancelled   lost   expired (artefacts GC'd)
```

- **A canary pins ACCELERATORS, never a camera**
  ([D927](../decisions/adr-0927-a-model-is-chosen-by-the-accelerator-that-runs-it.md)).
  `canaryResult` takes `(node, deviceKey)` pairs from `listCanaryTargets` and
  pins the registered model (INT8 where that accelerator ran INT8) on each
  one's root detector; every camera balanced onto it runs the new model.
  Rollback restores each accelerator's previous pin exactly (none stays none).
- **Reconcile, not timers.** On boot and every 30 s the engine compares every
  live job with the provider. A job found `uploading` or `collecting` with no
  in-memory task was interrupted by a restart: an upload fails as
  `hub-restart-during-upload`, a collect simply restarts (it is idempotent).
- **Idempotency.** `startJob` takes an idempotency key; every cloud object is
  tagged with the job key, so a retried submit never starts a second GPU; one
  GPU job at a time. `startJobBatch` enqueues several jobs (same entry +
  selection, one `baseModelId` each) and runs them sequentially.
- **Money.** The provider enforces `maxRuntimeSec` (Modal's sandbox timeout);
  the orchestrator cancels at `maxCostUsd` and at the runtime plus a grace.
  Costs are runtime × list price (`costIsEstimate`) — Modal's SDK exposes no
  billing answer.
- **Orphans.** A daily sweep lists every provider's tagged jobs and stops any
  we hold no live record of.
- **Retention.** The cloud dataset is deleted as soon as the result is fetched
  and verified; a failed job's after the provider's grace (24 h default).
  Staged artefacts (`<dataDir>/training/jobs/<jobId>/`) expire 14 days after
  ready or registration.

## Admin surface (Training addon)

`/addon/training` — three tabs (`?tab=`):

| Tab | Owns |
| --- | --- |
| **Frames** | Corpus KPI, collections, work-state / camera / class filters, thumbnail grid, annotation overlay (`packages/addon-training/src/page/frames/**`) |
| **Jobs** | DataTable of jobs + **Add job** `ItemFormDialog` (same pattern as Providers). Default: one `baseModelId` (trainer exports ONNX / OpenVINO / CoreML). Advanced: several architectures → sequential `startJobBatch`. Caps: `planJob` / `startJob` / `startJobBatch`, live progress, register / canary / discard |
| **Providers** | DataTable of entries; one form (type → `configSchema` + `ConfigFormBuilder`) via `createEntry` + `updateEntry`; Delete = `deleteEntry`; secrets keychain (D787/D829), not D634 |

Legacy `/retrain` and Library `?tab=retrain` redirect here. Public operator
pages: `camstack/docs` → Detection → Training data / Training.

### The annotation editor

A thumbnail opens a modal that takes the whole safe viewport and **never
scrolls** (`CorpusAnnotateOverlay`): the dialog is a fixed-height flex column —
`DialogContent` is `md:h-auto` for a `scroll="body"` dialog, so the height is
restated at `md:` — and `RetrainWorkbench` fits the frame into whatever is left
(`displayedImageRect`, object-fit contain). Only the subject list scrolls, on its
own. Below `lg` the list is a drawer over the canvas, opened from the action bar.

| Piece | Rule |
| --- | --- |
| Box stroke | The **review diff** (`lib/retrain-box-look.ts`, tokens only): added = success, removed = danger (dotted ghost), reclassified = warning, adjusted = info, unchanged = neutral, model error = danger **outline** (dashed, outlined label — never confused with removed), draft = primary dashed. The same mapping as `retrainReviewBadgeLook`; a spec pins the two together. |
| Source | An icon (`RetrainSourceIcon`: pipeline, detector, AI vision, drawn) on the box label and the list row — never a colour. |
| Live diff | `lib/retrain-live-review.ts` runs `classifyRetrainReview` on the **editor state**, so a box turns adjusted when moved and removed when deleted, before Save. A clean frame's summary strip shows the server's saved `review`; legacy (origin-less) verdicts are `approximate` (`~`). |
| Hover | One `hover` (`lib/retrain-hover.ts`), **outside the undo history**. A list row emphasises its box (thicker stroke, the others dimmed) and a hovered box (pointermove, smallest box containing the point) scrolls its row into view. A changed box also shows where its proposal was, faintly. |
| Removed | Dismissed proposals and deleted pipeline / assist boxes are ghosts and list rows under the "Show removed" switch. |
| Rows | One line (chip, review badge, class, label, source, accept / delete); the selected row expands to class, label (suggestions from the corpus vocabulary of the open page, `lib/retrain-vocabulary.ts` — no server method), sub-label and the model-error switch. |
| Keys | 1–6 class, A / Shift+A accept, E model error, C complete, Tab / ↑ / ↓ select, ← / → frame, Ctrl+S save, Ctrl+Z undo. Boxes are focusable buttons. |
| Frame in the URL | `?frame=<id>` (`frame-url.ts`) beside the filter keys: the modal opens from it, a reload keeps it. ← / → walk the **whole filtered corpus** (`lib/retrain-frame-step.ts`): past a page's edge the next page loads and its edge frame opens. A frame the answered list does not hold closes the modal. |
| Unsaved edits | Dirty = a save would send something different (`lib/retrain-dirty.ts`). Close, Escape (the native `cancel` is taken over), ← / → and a reload ask first (`useUnsavedGuard`, the shared `useConfirm`, `beforeunload`). A background refetch never re-seeds a dirty editor. |
| Typing | Focus opens one undo step, blur (or Enter) closes it — Ctrl+Z undoes a label, not a letter. |
| Conflict | Save sends `expectedRevision`. A refused save keeps the operator's edits on screen with a banner and "Reload the latest version"; it never replaces them on its own. |

The `ui:shots` harness has a `training` fixture (a frame carrying every review
state plus a draft, a synthetic scene) and `--step click|mouse|key|wait|js` to
open the modal and hover before the shot:
`npm run ui:shots -- --route /addon/training --fixtures training --step "click:[data-testid=corpus-frame-demo-frame-1]"`.

## Corpus and annotation model

Owned by pipeline-analytics (`retrain-*` stores). A frame in the corpus is a
**copy** (D86 / D781), not a pointer into event media. Collections are named
sets over that corpus (D793).

### Annotation kinds

| `kind` | Meaning in the UI | In the YOLO layout (`dataset.py`) |
| --- | --- | --- |
| `subject` | Teach “this region is class X” (macro + optional label / subLabel) | Positive label line when the macro maps to COCO-80 (`person` / `vehicle` / `animal` with a mappable label). `package` / `face` / `plate` are ignored by the root trainer. |
| `model_error` | Teach “do not detect here” — a false positive the operator named | **Never** a positive line. The region is background by omission. The row keeps `assistModelId` / `assistScore` for audit. |

There is **no** “NOT person” class, no YOLO ignore region, and no background
macro. A jacket detected as a person is marked `model_error` (or the box is
deleted); real subjects stay `subject` with the correct macro. Relabel (wrong
class) stays `subject` with a corrected `macroClass` / `label`.

Machine proposals (pipeline boxes on the copy, detector assist, AI vision)
arrive as **drafts** until the operator accepts or corrects them (D790). AI
vision outside the house needs a confirmed run (D795).

### Frame completeness and hard negatives

`complete` is an operator flag on the frame row — “every real subject is
handled”, or the frame is intentionally empty. It is **not** derived from
annotation count.

| Case | Training effect |
| --- | --- |
| `complete` + ≥1 `subject` | Normal positives (+ any `model_error` omitted from labels) |
| `complete` + zero `subject` | **Hard negative** — empty YOLO `.txt` |
| incomplete + ≥1 annotation | Trainable for those boxes only; unboxed subjects can be learned as background (YOLO has no ignore) |
| incomplete + no annotations | Not trainable |

Work state for filters / job selection (`workStateOf`): `unannotated` (no
saved rows) → `annotated` → `complete`. KPI and the Frames grid use that
partition.

### What the operator did: origin, dismissed, revision

([D849](../decisions/adr-0849-retrain-annotations-keep-their-origin.md).) The row
used to keep only the final box, so "accepted as drawn" and "moved and relabelled"
looked the same. Now:

| Field | On | Meaning |
| --- | --- | --- |
| `origin` | annotation (nullable) | `{ source, ref, bbox, macroClass, label?, score?, modelId? }` — the proposal the box started from, snapshotted when it was offered. `ref` is `pipeline:<trackId>`, `assist:<n>`, `llm:<n>` or `operator:<n>`. `null` on a row saved before origins existed. |
| `dismissed[]` | frame | `{ ref, snapshot }` of every proposal the operator deleted. The editor never re-seeds a dismissed ref (before, a deleted pipeline box returned as a draft on every reopen). |
| `revision` | frame | Bumped by each annotation save. `saveRetrainAnnotations({ expectedRevision })` refuses a stale one with `retrain-revision-conflict` (`parseRetrainRevisionConflict`); absent, last write wins. |
| `review` | list answers | Server-computed by `classifyRetrainReview` (`packages/types/src/retrain-review.ts`): per box `added / removed / reclassified / adjusted / unchanged / model-error`, plus a summary. `model-error` is never counted as `removed`. |

A save is one `settings-store.transact`: old rows out, new rows in, `dismissed` and
`revision`, behind a guard on the revision read inside the transaction. A legacy
frame (rows without `origin`) is reviewed lazily against the pipeline boxes
re-derived now — exact rectangle first, then best overlap — and every such verdict
carries `approximate: true`; there is no backfill on boot.
`pipelineAnalytics.backfillRetrainOrigins` (driven by the MCP tool
`track_review_backfill_origin`, dry-run unless `confirm: true`) sets `origin` on
rows that have none and changes nothing else; it never overwrites one.

### Frame bytes

The admin UI no longer receives a frame as base64 in a cap answer. A wire frame
carries `imageUrl` and `thumbnailUrl` pointing at the admin data plane
`/addon/pipeline-analytics/retrain-frame/<frameId>?size=full|thumb` (JPEG, ETag,
immutable); the page fetches it with the admin bearer token into an object URL.
`getRetrainFrameImage` (base64) is deprecated and stays one release for callers
that cannot fetch a URL (the MCP frame tool reads track media, not this).

### Export → trainer

`offerRetrainArchive` / `writeRetrainArchive` stream `annotations.json`
(schema `camstack.retrain-export/v3`) + `frames/*.jpg`. The trainer converts
that archive to Ultralytics layout; evaluation prefers complete frames and
treats `model_error` regions as expected false positives.

## Planning and live selection

`planJob` / `startJob` take a live `TrainingCorpusSelection`: one or more
collection ids and a work-state rule (`complete` by default;
`annotated_or_complete` / `any_annotated` as overrides).
pipeline-analytics resolves the frame set at that moment
(`retrain-training-corpus.ts`) with the same keep rule the annotated archive
uses. The job stores the selection criteria and a count snapshot for audit —
not a frozen version id. There is no dataset-version store, freeze UI, or
`datasetVersionId` on the request (D824).

`planJob` is pure over that resolved set's stats: the split (≥ 6 cameras with
complete frames → the 2nd and 3rd largest held out whole; otherwise the last 3
days of every camera), held-out support per class (< 20 → that class's floor
inherits the baseline's, said as a warning), refusals (`unknown-provider`,
`provider-not-configured`, `dataset-too-large`, `no-training-subjects`, …), a
GPU-time estimate (an unmeasured first model in `planner.ts`), the provider
entry's USD range and defaults, and `dataNotice` — the sentence the confirm
step repeats. `startJob` runs the same plan, so a job never starts on terms
the operator was not shown.

## Provider entries

`training-provider` is a collection of **types** (addons). Each type exposes
`describeTypes` / `createEntry` / `updateEntry` / `listEntries` / `deleteEntry`;
job methods take `entryId` (plus the owning `addonId` as the collection
selector). `createEntry` input is only `{ typeId, name }` — the provider mints
and persists `entryId` (UUID for Modal). Credentials and per-entry defaults
(GPU, region, cost cap, runtime, grace) are written only through
`updateEntry` from Training → Providers (one form per entry, driven by
`describeTypes[].configSchema` + `ConfigFormBuilder` — D829). An omitted
`tokenSecret` on update means KEEP; `{ $secretClear: true }` clears. The
provider addon's `globalSettingsSchema` does not own an `entries`
editable-array — that would be a second authority beside the Providers
table. `describe()` surfaces `formValues` (password fields as keychain
views) and `defaults` for the form.

## The trainer contract

`packages/types/src/training/trainer-contract.ts` (zod) and the trainer's
pydantic models (`hf/camstack-trainer/schemas/*.schema.json`) are the two
halves; `trainer-contract.spec.ts` pins them field for field.

- `job.json` (`camstack.training/v1`): every field filled by the hub.
- `result.json` (`camstack.training-result/v1`): status, metrics for baseline,
  candidate and INT8 on the holdout, D739 floors, INT8 gate, files with sha256,
  the bundle's sha256, and a catalog draft the hub completes (labels, licence,
  the base's D741 floors, `camstack-local://` URLs).
- Progress: `CAMSTACK_EVENT {json}` lines on stdout.

## Modal

`training-modal` (`providers/modal/`): a job Volume `cst-ds-<jobKey>` holds the
dataset, `job.json` and `out/`; a CPU staging sandbox streams the dataset in
(no GPU billed during a home upload); one GPU sandbox runs the trainer, built
from the trainer's Dockerfile at the pinned HF commit
(`trainer-source.ts`); CPU collector sandboxes read results back; cleanup
deletes the job Volume and never the shared `camstack-training-cache`. The
`modal` SDK (0.11.0, exact) is imported only in `modal-sdk-gateway.ts`; the
provider and the shared contract suite run against a recorded gateway.
Credentials: a `password` field (keychain) per entry.

## What is not proven yet

Recorded as such, not assumed: CoreML conversion of YOLOv9 on Linux, the
image's first build time on Modal, region pinning on Modal's Starter plan,
`sandboxes.fromId` on a sandbox that has already exited, Volume commit timing
on sandbox termination, and the GPU-time model. The first real run answers all
of them.

## Deploy note

Addon edits under `packages/addon-training` (orchestrator page, Modal
provider) and `packages/addon-post-analysis` (corpus / archive) are not live
until `camstack deploy` of those packages (hub default). Cap / types changes
travel inside the `@camstack/server` closure — they need a server install that
contains them, not only an addon deploy. See
`docs/architecture/update-and-release.md`.
