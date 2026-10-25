# Cloud training for CamStack: provider choice, capability design and plan

> **Status (2026-10-08):** implemented as described in [`docs/architecture/cloud-training.md`](../architecture/cloud-training.md) (D805–D808). Where the build differs from this plan — no GHCR image (Modal builds from the trainer's Dockerfile), the trainer in its own Hugging Face repo, dataset versions routed rather than moved, the detector as the first target — the decisions record why.

Research only. No code, docs, hub state or workflows were touched. Repo state is `camstack-server` main on 2026-10-08. I re-measured no live hub counts; the analysis's Q0 census still applies.

## Summary (~25 lines)

1. **First provider: Modal.** It is the only provider with a real recurring free tier: the Starter plan is $0 and includes $30 of credit every month.
   - An L4 costs $0.80/h, so $30 covers about 35 L4-hours a month. That is enough for dozens of classifier jobs, or about 10 YOLOv9-m fine-tunes.
   - It takes our public GHCR image via `images.fromRegistry`, and the hub can drive it from Node with the official `modal` JS SDK (Sandboxes).
   - The catch: that SDK is **beta** (0.11.0, the API still changes) and there is no plain REST API. We isolate it behind the provider cap and pin the version.
2. **Runner-up: RunPod**, using Secure Cloud pods through REST v2.
   - Plain HTTP with a Bearer key, the cheapest L4/4090 (about $0.44–0.74/h), per-second billing, EU datacenters, and an S3-compatible API on its network volumes.
   - It has no meaningful free tier, but a YOLO fine-tune costs about $1.
   - Hugging Face Jobs is a close third: clean REST and JS client, but billed per minute, no free credit without PRO, and GHCR and EU support unverified.
   - Rejected: GCP (the $300 trial can never be spent on GPUs), AWS (ECR and IAM friction), Replicate (Cog images only), Lambda and DigitalOcean (VMs only), Vast (community hosts hold your footage).
3. **Two capabilities.**
   - **`training`** is a hub-only singleton orchestrator. It owns dataset versions, job records, reconcile-on-boot, cost guards and the return flow to Model Studio.
   - **`training-provider`** is an `internal` collection cap that only talks to one cloud. Calls route to one provider by `addonId`, the same way the `llm` and `notification-output` caps do.
   - One new package, `addon-training`, with two manifest entries: `training` and `training-modal`. Later providers become new entries or packages.
4. **One trainer image**, `ghcr.io/camstack/trainer`. Its source is public and the AGPL Ultralytics code stays inside it.
   - It takes our retrain tar plus a versioned `job.json`.
   - It trains a YOLOv9 detector or a timm classifier, evaluates on a split held out by camera and by day, and derives D739 floors against the current model.
   - It exports ONNX, OpenVINO fp16/int8 (int8 calibrated on the user's frames) and CoreML fp16. Edge TPU is an optional second image tag.
   - It writes `result.json`, which contains a ready `ModelCatalogEntry`.
   - Progress is reported on stdout as `CAMSTACK_EVENT {json}` lines, so the protocol works on any provider.
5. **Return flow:** artefacts are verified by sha256, then a new `importModelBundle` call places them in modelsDir. Model Studio's current upload path only takes `.onnx`/`.tflite`, so OpenVINO IR and `.mlpackage` need this new path. The bundle is then registered with its catalog revision, distributed, and evaluated by batch replay (D646) and a canary pin. Auto-tune must skip custom pins (D745).
6. **Phases:**
   - **Phase 0:** prerequisites, about 6–8 days.
   - **Phase A:** a classifier fine-tune end to end on Modal's free credit, about 12–15 days.
   - **Phase B:** the root YOLOv9-m fine-tune, about 10–12 days plus training iterations.
   - **Phase C:** RunPod, batch-replay gating and Edge TPU.
7. **Biggest risks:**
   - The beta Modal SDK.
   - Detector evaluation on frames that are not fully annotated (needs a per-frame "complete" flag).
   - Floors that are noisy on a small held-out split.
   - The secret is stored in plaintext at rest today.
   - Auto-tune overwriting a custom pin.
   - Upload time from home connections.

---

## Part 1 — Provider choice

Figures are from the research pass on 2026-10-08, with sources at modal.com/pricing, docs.runpod.io and huggingface.co/docs/hub/jobs-pricing. Items marked (unverified) were not confirmed.

| | Modal | RunPod | HF Jobs | Vast.ai | GCP Cloud Run GPU | AWS SageMaker | Replicate |
|---|---|---|---|---|---|---|---|
| Free | **$30/month recurring** (Starter $0) | none flat; random bonus after the first $10 (EU: $5) | none (PRO $9/month includes credits) | none | $300 trial, **not usable on GPUs** | $100–200 credits; GPU eligibility unverified | none |
| L4 / A10 / 4090 / A100-80 | $0.80 / $1.10 / – / $2.50 | $0.44–0.49 / A40 $0.35–0.49 / $0.34–0.74 / $1.19–1.59 | $0.80 / $1.00 / – / $2.50 | market price, 4090 from about $0.31 | L4 about $0.67 plus CPU and RAM | ml.g5/g6 (unverified) | L40S $3.51, A100 $5.04 |
| Billing | per second | per second | per minute | per second | per second | per second | per second |
| Job API | JS SDK `modal` (beta): Sandbox create / poll / wait / terminate, stdout | **REST v2** `/v2/pods`: image, args, env, gpu, cloud, dataCenterIds, network mounts | REST `/api/jobs/{ns}` + `@huggingface/hub` JS (run, get, list, cancel) | REST v0 | REST + OAuth service account | REST with SigV4 | REST, but only for Cog models |
| Data in | `copyFromLocal` into a sandbox; volumes; `cloudBucketMounts` (S3/R2) | network volume + S3-compatible API (multipart, **no presigned URLs**, separate S3 key pair) | private HF bucket or dataset repo mounted as a volume | scp or volume | GCS | S3 | URL |
| Artefacts out | `copyToLocal`, or a volume read by a second sandbox | S3 API | bucket | scp | GCS | S3 | URL |
| Auth | workspace token id + secret; no scopes found | key types All / Restricted / Read-only; can a restricted key create pods? (unverified) | fine-grained HF token | **best scoping** (per-resource permissions) | service-account JSON | IAM | token |
| EU / privacy | regions selectable at 1.15x (`eu`) to 1.75x (one region); on Starter? (unverified) | EU-RO, EU-CZ, EUR-NO, IS; force `cloud: SECURE` | unverified | community hosts have physical access | BE / NL L4 | eu-* | US |
| Cold start | registry image converted once, then seconds (unmeasured) | pod pull: minutes for a large image | pull | pull | pull | pull | Cog |
| BYO container | yes, any public registry | yes | yes (GHCR unverified) | yes | Artifact Registry / Docker Hub | **ECR only** | **Cog only** |

### Recommendation: Modal first

1. **Free experimentation is the operator's explicit wish, and only Modal gives it every month.** At our job sizes the cost is:
   - classifier fine-tune: about 10–30 L4-minutes, roughly $0.15–0.40;
   - YOLOv9-m fine-tune on 2–3k frames: 1–3 L4-hours, roughly $0.80–2.40.

   So $30 a month is a real sandbox for every user, not a one-off trial.
2. **No Python on the user's side and no cloud-side code.** The hub creates a Sandbox from `ghcr.io/camstack/trainer:<digest>` with `gpu: 'L4'`, `timeoutMs`, an optional region, and a per-job Volume mounted.
3. **Privacy story.**
   - Data lives only in the user's workspace.
   - The dataset sits on a per-job Volume for the duration of the job and is deleted afterwards.
   - The sandbox's filesystem is ephemeral.
4. **Mitigating the beta SDK:**
   - pin the exact version;
   - wrap every call in a ~200-line adapter;
   - run a contract test against a recorded fake (see Testing);
   - keep RunPod as a ready second implementation of the same cap.

   Without a REST API, a breaking SDK change costs one adapter patch and an addon redeploy, not a framework publish.
5. **Things to verify in the first spike, before committing (half a day):**
   - Can Starter select regions?
   - Sandbox maximum lifetime (believed 24 h; we need 4 h or less).
   - Can a Sandbox be re-attached by id after a hub restart (`sandboxes.fromId`)?
   - Volume deletion from JS.
   - GHCR pull of a ~6–8 GB image.

### Runner-up: RunPod

- It is the cleanest HTTP API for production use and about 45% cheaper per GPU-hour.
- Its sequence is: create network volume → upload with S3 multipart → `POST /v2/pods` with `mounts.network` and `cloud: SECURE` → poll → download with S3 → delete the pod and the volume.
- It needs two credentials (the API key plus an S3 key pair) and has no free tier.
- Build only on v2: v1 is being retired around November/December 2026.

---

## Part 2 — Design

### 1. Capability shape

#### Where the code lives

- **`packages/addon-training`** is a new package, `execution.placement: hub-only`, with two manifest entries:
  - **`training`** (orchestrator) provides the `training` singleton cap plus an addon page (`addon-pages-source`) in the `detection` sidebar section.
  - **`training-modal`** (provider) provides the `training-provider` collection cap. Its settings hold the credentials.
- A second cloud is a second entry, `training-runpod`, with no change to either cap.
- Installing the package is the opt-in (add-addon §4.3). Each provider is otherwise inert until credentials are set (§4.1, `loki-logging` posture).
- Why split the orchestrator from the provider:
  - Every rule about datasets, splits, floors, cost caps, registering and canaries is written once.
  - A provider is a thin, mockable translation layer, which is what makes the fake provider and contract tests possible.
  - It follows the `calendars` / `calendar-source` and `llm` posture: the aggregator is a singleton, the sources are a collection.

#### `training-provider` (collection, `scope: system`, `internal: true`, every method `auth: 'admin'`)

- Single-row methods take `addonId` and route to one provider, as in `llm` and `notification-output`.
- `describe` concat-fans across providers.
- It is not `mount: 'skip'`: a forked provider must stay reachable over the transport, and D240 floors unannotated methods to admin anyway.

```ts
const ProviderDescriptor = z.object({
  addonId: z.string(), kind: z.string(), label: z.string(),
  gpuTypes: z.array(z.object({ id: z.string(), label: z.string(), usdPerHour: z.number(),
                               vramGb: z.number() })),
  regions: z.array(z.object({ id: z.string(), label: z.string(), priceMultiplier: z.number() })),
  maxDatasetBytes: z.number(), maxRuntimeSec: z.number(),
  freeTierNote: z.string().optional(),            // "$30/month included credit"
  configured: z.boolean(),                         // credentials present (never the values)
})
const CredentialCheck = z.object({ ok: z.boolean(), account: z.string().optional(),
  reason: z.enum(['missing','invalid','forbidden','network','quota']).optional(), detail: z.string().optional() })
const JobSpecRef = z.object({ addonId: z.string(), jobKey: z.string().uuid() })
const ProviderJobState = z.enum(['pending','starting','running','succeeded','failed','cancelled','lost'])
const ProviderJobStatus = z.object({
  jobKey: z.string(), providerJobId: z.string().optional(), state: ProviderJobState,
  startedAt: z.number().optional(), endedAt: z.number().optional(),
  exitCode: z.number().optional(), failureReason: z.string().optional(),
  gpuType: z.string(), region: z.string().optional(),
  billedSeconds: z.number(), costUsd: z.number(), costIsEstimate: z.boolean(),
  lastFetchedAt: z.number(),
})
methods: {
  describe:            method(z.object({}), z.array(ProviderDescriptor)),
  validateCredentials: method(z.object({ addonId }), CredentialCheck, { kind:'mutation' }),
  estimateJob:         method(z.object({ addonId, gpuType, region?, datasetBytes, estGpuSeconds }),
                              z.object({ usdLow, usdHigh, uploadSecAtMbps: z.number(), notes: z.array(z.string()) })),
  prepareDataset:      method(JobSpecRef.extend({ sizeBytes, sha256 }),
                              z.object({ datasetRef: z.string(), upload: UploadTarget }), { kind:'mutation' }),
  completeDataset:     method(JobSpecRef.extend({ datasetRef }), z.object({ ok: z.literal(true) }), { kind:'mutation' }),
  submitJob:           method(JobSpecRef.extend({ image: z.string() /* digest-pinned */, args: z.array(z.string()),
                              env: z.record(z.string()), gpuType, region?, datasetRef, maxRuntimeSec }),
                              ProviderJobStatus, { kind:'mutation', timeoutMs: 120_000 }),
  getJob:              method(JobSpecRef, ProviderJobStatus),
  listJobEvents:       method(JobSpecRef.extend({ cursor: z.string().optional(), max: z.number().max(500) }),
                              z.object({ lines: z.array(z.object({ ts: z.number(), text: z.string() })), cursor: z.string() })),
  cancelJob:           method(JobSpecRef, z.void(), { kind:'mutation' }),          // idempotent
  fetchArtifacts:      method(JobSpecRef, z.object({ files: z.array(z.object({
                              path: z.string(), bytes: z.number(), sha256: z.string(), localPath: z.string() })) }),
                              { kind:'mutation', timeoutMs: 15 * 60_000 }),
  cleanupJob:          method(JobSpecRef, z.object({ deleted: z.array(z.string()) }), { kind:'mutation' }),
  listJobs:            method(z.object({ addonId }), z.array(ProviderJobStatus)),  // recovery / orphan sweep
}
```

The schemas above are notes on the design:

- **`UploadTarget`** is a union:
  - `{ kind:'push-stream', uploadId }`: the hub streams chunks via an addon data-plane route of the provider addon. Used for Modal, where the provider copies into a staging CPU sandbox that writes to the Volume.
  - `{ kind:'s3-multipart', endpoint, bucket, key, partSize, credentialsRef }`: RunPod S3 and future buckets.
  - `{ kind:'http-put', url, headers }`: providers with presigned URLs.

  The dataset bytes are produced by the post-analysis export and written straight to the target.
- **`fetchArtifacts`** downloads into a hub staging directory the orchestrator owns, `<training storage>/jobs/<jobKey>/`, and verifies every file against the sha256 recorded in `result.json`.
- **No `streamLogs` subscription.** Polling `listJobEvents` with a cursor every 10 s is enough and survives hub restarts. The orchestrator parses `CAMSTACK_EVENT` lines out of the log, so providers never need to understand progress.
- **No `.default()` in these inputs.** Defaults do not run on the addon cap path ([[project_zod_defaults_addon_path]]); the orchestrator fills every field.

#### `training` (singleton, hub-only, `auth: 'admin'`)

Dataset versions:

- `listDatasetCandidates({ step?, deviceIds? })` returns counts per camera, class, day/night and completeness, read from `pipelineAnalytics`.
- `createDatasetVersion({ name, target, deviceIds, frameFilter, splitPolicy })` → `DatasetVersion`.
  - The version is immutable: frameIds, a frozen copy of the annotations, the split assignment (train / val / holdout per frame), an annotation hash, export params including padding 0.15, `bytesEstimate`, and `createdAt`.
  - Split rules: by camera and by whole days, never by random frame. By default two cameras are held out entirely when there are 6 or more, otherwise the last N days of every camera. The minimum support per class is enforced, and the version is refused with a named reason if it is missing.
- `listDatasetVersions()` and `deleteDatasetVersion(id)`.

Jobs:

- `estimateJob({ datasetVersionId, target, baseModelId, addonId, gpuType, region?, preset })` combines the provider's `estimateJob` with the orchestrator's GPU-seconds model, per target and preset, measured in Phase A/B and refined from actual runs.
- `startJob({ … same …, maxCostUsd, idempotencyKey })` → `TrainingJob`.
- `getJob(id)`, `listJobs({ state? })` and `cancelJob(id)`.
- `getJobLog({ id, cursor })` is a pass-through.
- `getJobResult(id)` returns `result.json` already parsed: metrics, floors, the baseline comparison and the catalog draft.

Return flow:

- `registerResult({ jobId, modelName?, formats? })` → `{ modelId }`.
- `canaryResult({ jobId, deviceIds })` pins the model on those cameras and records the canary.
- `rollbackCanary({ jobId })`.

**Job states, owned by the orchestrator and persisted:**

```
draft → exporting → uploading → submitted → starting → running{stage: prepare|train|eval|export|convert}
      → collecting → ready → registered → canary
any → failed{reason, stage}   any → cancelling → cancelled   lost (provider no longer knows it)   expired (artefacts GC'd)
```

**Idempotency and recovery.**

- The orchestrator mints `jobKey` (uuid v4) before any side effect. The provider tags every cloud object with it: Modal sandbox name `cst-<jobKey>`, Volume `cst-ds-<jobKey>`; RunPod pod name and S3 key prefix.
- `submitJob` first looks up an existing object by that tag. A retried submit therefore never starts a second GPU.
- The dataset upload is keyed by its sha256; `completeDataset` is a no-op if the data already landed.
- `startJob` with the same `idempotencyKey` returns the existing job.
- On boot and every 30 s, a reconcile loop compares every non-terminal job with `getJob`, the registry-driven posture from [[project_robust_dispatch_design]] rather than timers.
- Once a day, a sweep diffs `listJobs` against our records. It cancels and cleans up cloud jobs we have no record of, which stops an orphan from burning credit.

**Progress.**

- The container prints `CAMSTACK_EVENT {"type":"stage"|"epoch"|"metric"|"artifact"|"done"|"error", ...}`. For example, an epoch event carries `{epoch, epochs, box_loss, mAP50, mAP50_95, etaSec}`.
- The orchestrator stores the last event and a short series of up to 300 points per job, which is enough for a sparkline.

**Cost.**

- The provider reports `billedSeconds` and `costUsd`, with `costIsEstimate: true` when it comes from runtime × list price. Modal's JS SDK exposes no billing API that I could confirm.
- **Guards:**
  - `maxRuntimeSec` is passed to the provider, which enforces it (Modal `timeoutMs`, RunPod by orchestrator cancel).
  - `maxCostUsd` is checked on every poll; when reached, the orchestrator cancels the job and marks it `failed{reason:'cost-cap'}`.
  - Default cap: 1.5x the high estimate.

**Persistence.** Job records and dataset versions are small rows in the addon's `DurableState`, the Model Studio pattern. Dataset tars are never materialised on the hub; they are streamed. Artefacts are staged in a new `storageLocations` entry, `trainingArtifacts` (single), with 14-day retention after `registered`.

### 2. The training container

**Repository.** A public repo `camstack/trainer`, AGPL-3.0, separate from camstack-server so the AGPL scope is visibly bounded.

- It **vendors** `convert_lib.py` and the recipe logic from `scripts/build-camstack-models.py` via a git subtree or a copy pinned by sha, plus `edgetpu_toolchain.py`.
- It is built and pushed by GitHub Actions to `ghcr.io/camstack/trainer:<semver>`.
- The hub always submits it **by digest**, which is recorded in the job record and in `result.json`.

**Layout.**

```
/app/camstack_train/
  spec.py        job.json schema (camstack.training/v1), validated with pydantic; unknown version → exit 64
  dataset.py     annotations.json → YOLO layout (letterbox-free full frames + labels/*.txt, COCO-80 ids)
                 or classifier layout (crops via derived.subjectCrop @ padding 0.15, resized per model)
  split.py       honours the split in the manifest (never re-splits)
  replay.py      COCO replay: downloads a pinned COCO subset (val2017 + train sample by class) into the
                 provider volume cache; mixes N images (default 1500) for detector jobs; OI subset for D711
  train_det.py   Ultralytics YOLO(base).train(...)   — the only AGPL import
  train_cls.py   timm EfficientNet-Lite0 / given arch, Apache
  evaluate.py    pipeline-identical preprocess (letterbox 114 grey, /255) + decode; P/R/AP50 per class,
                 per camera, day/night, small subjects; runs BOTH baseline and candidate on the holdout
  floors.py      D739: per class, lowest floor whose FP count ≤ baseline FP at the baseline's shipped floor;
                 requires ≥ K positives (default 20), else inherits baseline floor; clamp ±0.15 of baseline
  export.py      .pt → ONNX (opset 17) → OpenVINO fp16 + int8 (NNCF, calibrated on ≤300 TRAIN-split frames
                 of the user, letterboxed exactly like runtime) → CoreML fp16 (coremltools on Linux)
                 → optional tflite int8 + edgetpu_compiler (image tag :edgetpu)
  manifest.py    result.json (camstack.training-result/v1)
  events.py      CAMSTACK_EVENT emitter
```

**Inputs.**

- `/data/dataset.tar`, the hub's retrain export with two new fields per frame (see Prerequisites): `capturedAt` and `complete`.
- `/data/job.json`:

```json
{ "schema":"camstack.training/v1", "jobKey":"…", "target":{"kind":"detector","step":"object-detection"},
  "base":{"modelId":"camstack-yolov9m-640","weights":"yolov9m.pt","imgsz":640},
  "baseline":{"modelId":"camstack-yolov9m-640","floors":{"person":0.55,…}},
  "hyper":{"epochs":40,"batch":16,"lr0":0.002,"freeze":10,"seed":1},
  "replay":{"source":"coco2017","count":1500},
  "exports":["onnx","openvino-fp16","openvino-int8","coreml-fp16"],
  "catalog":{"idPrefix":"custom-","name":"…"} }
```

**Outputs.** In `/out`, which is the job Volume:

- the `.pt`, `.onnx`, the OpenVINO `.xml`/`.bin` pairs and the `.mlpackage` (tarred into a single file for transfer);
- `result.json`, which holds:
  - every file with its sha256 and bytes;
  - metrics for baseline vs candidate, per class, per camera and for day vs night;
  - the floors;
  - a `catalogEntry` draft: a `ModelCatalogEntry` with `labels`, `inputSize`, `postprocessor`, `defaultClassFloors`, `suppliedLabelFloors` copied from the base, and `formats` with **relative paths** that the hub rewrites to `camstack-local://`;
  - toolchain versions, the image digest, the dataset version id, and `licence: "AGPL-3.0 (Ultralytics derivative)"` or `"Apache-2.0"`.

**Licensing.**

- Ultralytics (AGPL) is imported only inside this image.
- The image's source is public, with the Dockerfile, so every published image ships its Corresponding Source. This is the same posture as D661 for the hosted weights.
- The hub talks to the image only through files and a process boundary: `job.json` in, files out. It never imports the trainer, so the "no AGPL library runs in CamStack" rule (D661/D703) holds.
- Fine-tuned detector weights are an AGPL derivative. Private use carries no obligation. The catalog entry carries the licence string, so the generated licence surfaces (D661) label it correctly.
- Classifier jobs never import Ultralytics. They could later move to an Apache-only image if the operator wants a clean classifier path.

**CoreML on Linux.**

- coremltools *conversion* runs on x86 Linux; only `predict()` needs macOS.
- The container therefore exports fp16 (D743) and skips `verify_coreml_batch`.
- Verification moves to the hub side: after distribution, the Mac node loads the model once through the existing format-status path.
- Fallback if Linux conversion of a YOLOv9 graph fails in the spike: drop `coreml-fp16` from `exports`, and Model Studio's existing `ensureEngineFormats` converts the ONNX on the Mac node via `model-convert`.

**Edge TPU.**

- The `edgetpu_compiler` 14.1 binary is x86_64 and runs natively in an amd64 container.
- It needs TensorFlow plus onnx2tf, about 2–3 GB, so it lives in a separate tag, `:edgetpu`, run as a second CPU-only step to keep the main image smaller and faster to start.
- It is realistic for classifiers (EfficientNet-Lite0 compiles well). For YOLOv9-m it is optional and likely to fall back largely to the CPU, so it is off by default.

**Image size.** CUDA torch, Ultralytics, timm, OpenVINO, NNCF and coremltools come to about 6–8 GB. Modal caches the converted image after the first pull. Publish `linux/amd64` only.

### 3. Dataset flow

**Hub → cloud.**

1. The orchestrator creates the dataset version.
2. It calls `prepareDataset` and receives an `UploadTarget`.
3. It asks `pipelineAnalytics` to **stream** the tar of that version to the target. A new cap method, `writeRetrainArchive({ versionId, target })`, reuses the body of `retrain-export-handler.ts` (manifest first, one JPEG in memory, a 25 ms yield) with a `write(chunk)` sink instead of an `http.ServerResponse`.
4. The bytes never touch the orchestrator's disk and never cross the tRPC body limit.

For Modal, the provider addon:

1. starts a CPU-only Sandbox (cheap) with the job Volume mounted;
2. receives the stream through its addon data-plane route;
3. pipes it to the sandbox with `copyFromLocal` or a stdin pipe into `cat > /vol/dataset.tar`, the transport chosen in the spike;
4. terminates the sandbox.

This avoids paying for an idle L4 during a slow home upload.

**Sizes.**

| Dataset | Rough size |
|---|---|
| Detector, 1080p–4K full frames | 150–600 KB each; 2–3k frames ≈ 0.5–1.8 GB |
| Classifier | crops pre-cut on the hub (`layout:'crops'` export variant at padding 0.15 and 256 px): 200–2k crops ≈ 5–80 MB |
| COCO replay | never uploaded; the container fetches it from the public source and caches it on a persistent `camstack-cache` Volume in the user's workspace |

At 20–40 Mbit/s upstream, 1.5 GB takes 5–10 minutes. The UI shows that figure in the estimate.

**Privacy.**

- Frames go only to the user's own account.
- They travel over TLS end to end (hub → provider API).
- At rest they sit on a per-job Volume that is deleted by `cleanupJob` once the artefacts are fetched, and also on `cancelled` and `failed` (after a 24 h grace period for debugging, which the user can disable).
- The job record shows "dataset deleted at …".
- No frame is ever put in `job.json`, environment variables or logs.
- The container logs aggregate metrics only, never file names containing camera names.
- Optional later: client-side AES encryption of the tar with a per-job key passed as a provider secret. This is only worth doing for providers whose storage outlives the job. It is low priority for Modal (per-job Volume) and medium for RunPod (network volume).

### 4. Return flow

1. **`collecting`.** `fetchArtifacts` downloads into `trainingArtifacts/jobs/<jobKey>/` and checks every sha256 against `result.json`. Then `cleanupJob` runs.
2. **`ready`.** The UI shows the metrics comparison. Nothing is registered automatically.
3. **Register.** `training.registerResult` calls a **new `custom-model-registry.importModelBundle`** method (admin; the cap is hub-only and provided by Model Studio). The method:
   - validates the catalog draft against `ModelCatalogEntrySchema`;
   - moves the files into modelsDir under `<modelId>/` (directory formats included);
   - rewrites the format URLs to `camstack-local://<modelId>/<file>`;
   - sets `revision = sha256` on every format, so that D743/D744 stale-detection works when a later retrain replaces the artefact in place;
   - upserts the registry with `nameOrigin: 'operator'`;
   - marks hub availability;
   - optionally calls `ensureFormatsThenDistribute`.

   This replaces calling a Model Studio custom action across addons. Custom-action inputs also go stale after a redeploy ([[project_addon_redeploy_schema_stale]]), so a cap method is the robust contract.
4. **Batch replay (D646).**
   - `training.evaluateResult({ jobId, deviceIds, days })` runs session replay over N recorded sessions per target camera, comparing candidate and production.
   - It reports tracks passing the floor and matching a live NC rule, per day.
   - This needs batching on top of `addon-benchmark/src/session-replay/compare.ts`.
   - It is a Phase C gate. Phases A and B show the offline holdout metrics only.
5. **Canary.**
   - `canaryResult` pins the step on the chosen cameras (D208 device pin) and records `{ jobId, previousModelId, since }`.
   - The UI shows a 7-day before/after panel.
   - `rollbackCanary` restores the previous pin.
6. **Auto-tune (D745) must skip custom pins.** `recommend.ts` considers only catalog `yolov9*`, and Apply rewrites `inferenceDevices[device].steps['object-detection'].modelId`. The rule:
   - The plan builder marks a node or device whose current pin is a registry (custom) id as `kept: custom-pin` and never includes it in Apply.
   - The UI warns: "custom model pinned; auto-tune skips this node".
   - This is a hard prerequisite for any canary.

### 5. UI — the Admin "Training" page

This is a Module Federation page of `addon-training`, mounted at `/addon/training` in the Detection sidebar section. It has six parts.

1. **Provider.**
   - A list derived from `training-provider.describe`, with a "configured / not configured" badge.
   - "Configure" opens the generic addon settings form of the provider addon. For Modal that is two `type:'password'` fields, token id and token secret, with `showToggle`, following the plus catalog precedent.
   - "Test" calls `validateCredentials` and shows the account or workspace name, plus the free-tier note.
   - The key never round-trips to the browser.
2. **Dataset.**
   - Dataset versions with frame counts per class, camera and day/night, a completeness percentage and split sizes.
   - "New version" opens a wizard: pick cameras, step or target, and the holdout policy. Named refusals (for example "person: 8 held-out positives, need 20") appear inline.
3. **Target.**
   - Choose detector (base model chosen from the catalog family running on the fleet, by default the model pinned on most cameras) or classifier (step with its base model).
   - Choose a preset: quick, standard or thorough (epochs and imgsz).
4. **Estimate and confirm.**
   - GPU type and region (with the multiplier), estimated USD range, upload time, "free credit remaining: unknown — check your provider dashboard", and a cost-cap field.
   - A confirm dialog repeats where the data goes and when it is deleted.
5. **Job.**
   - A state timeline, the current stage, an epoch progress bar, a mAP sparkline, a log tail (`getJobLog`), elapsed time and cost, and Cancel.
6. **Result.**
   - A comparison table of baseline vs candidate: per-class P/R at their respective floors, day/night, small subjects, and per-camera deltas (red where worse by more than 0.01 recall).
   - The proposed floors, sizes per format, and the licence line.
   - Actions: **Register**, **Register + Canary on…** (camera picker), **Discard** (deletes the staged artefacts).
   - After a canary: the before/after panel and **Rollback**.

### 6. Prerequisites (Phase 0/1 items that land first)

| # | Item | Why it blocks | Effort |
|---|---|---|---|
| P1 | Durable retrain storage: a dedicated `retrain` location instead of `eventMedia` (`retrain-frame-store.ts:54`) | Dataset versions point at frames that eviction can delete | 1–1.5 d |
| P2 | Export padding fix, 0.2 → 0.15 (`retrain-export.ts:37` vs `types/src/pipeline/detail-crop.ts`) | Classifiers would be trained on crops they never see | 0.25 d |
| P3 | Manifest fields `capturedAt`, a day/night flag and per-frame `complete` (operator ticks "all subjects boxed"); a `layout:'crops'` variant; a filter by version / frameIds; a `writeRetrainArchive` sink | Time-blocked split, day/night metrics, and honest detector evaluation (an unboxed person counts as a false positive) | 1.5–2 d |
| P4 | "YOLO export" lives as `dataset.py` in the trainer, also runnable locally with `python -m camstack_train.dataset`. A hub-side YOLO/COCO adapter stays optional for users who train by hand | One converter, not two that drift | 1 d (inside A1) |
| P5 | Evaluation harness checked in (`camstack_train/evaluate.py` + `floors.py`, mirrored as `scripts/eval/` for local use); the 409-frame harness moved out of the scratchpad | Floors and the comparison come from it | 2–3 d |
| P6 | `build-camstack-models.py --checkpoint <path>`: the ad-hoc recipe takes a local `.pt` instead of appending `.pt` to an id (`:306-307`), plus `--calib-dir` pointing at the user's frames | The container's export path, and the local path for hand training | 0.5–1 d |
| P7 | Auto-tune skips custom pins (§4.6) | A canary would be overwritten | 1 d |
| P8 | A shared `secret-codec` (promote `addon-mqtt-broker/src/secret-codec.ts` AES-GCM `enc:v1` into `@camstack/core` or a kernel helper) so provider keys are encrypted at rest | Today password fields are stored in plaintext in the settings store | 1 d |
| P9 | Q0 census (read-only) | Decides whether Phase A uses user crops or a smoke dataset | 0.25 d |

### 7. Phased plan

**Phase 0: prerequisites P1–P3, P5–P9.** About 7–9 days, no cloud. Can run in parallel with the Phase A spike.

**Phase A: minimal end to end on Modal's free credit, classifier target.** About 12–15 days.

| Task | Effort | Depends on |
|---|---|---|
| A0 Modal spike: JS SDK sandbox with a GHCR image, L4, Volume, stdout, `fromId` re-attach, timeout, Volume delete, region on Starter (answers the unverified items) | 0.5–1 d | — |
| A1 Trainer repo: `spec`, `dataset` (classifier layout), `train_cls` (timm Lite0), `evaluate` (classifier variant), `floors` (classifier `minConfidence`), `export` (ONNX, OV fp16/int8 own-frame, CoreML fp16), `manifest`, `events`; Dockerfile; GHCR CI; smoke dataset fixture | 4–5 d | P5, P6 |
| A2 `training-provider` and `training` cap files + codegen + `AnyCapability` hand-edits + cap-router specs | 1 d | — |
| A3 `addon-training`: orchestrator (DurableState rows, state machine, reconcile, cost guard, orphan sweep), `training-modal` adapter, fake provider | 3–4 d | A0, A2 |
| A4 `pipelineAnalytics.writeRetrainArchive` + version filter + crops layout | 1 d | P3 |
| A5 `custom-model-registry.importModelBundle` in Model Studio (directory formats, revision, availability, distribute) | 1.5 d | — |
| A6 Training page: provider, dataset version, target, estimate, job progress, result, register | 2–3 d | A3 |
| A7 First real run on the user's vehicle or animal crops (or the OI smoke set if Q0 = empty); register; verify on hub and Mac | 0.5–1 d | all of the above |

**Shipping Phase A** is a framework change:

- publish `@camstack/types` and force-publish `@camstack/system`, `@camstack/server` ([[project_cap_change_needs_system_force_publish]]);
- then `applyServerUpdate`;
- then `camstack deploy` for `addon-training`, `addon-model-studio` and `addon-post-analysis`;
- then verify with `listCapabilities` ([[project_deploy_capability_reregistration]]).

**Phase B: root detector fine-tune.** About 10–12 days, plus 2–3 days of training and evaluation iterations.

| Task | Effort | Depends on |
|---|---|---|
| B1 `train_det.py` (Ultralytics YOLOv9-m from `yolov9m.pt`, freeze backbone option), YOLO layout, COCO replay cache Volume | 2–3 d | A1 |
| B2 Detector evaluation: per camera, day/night, small subjects, baseline run on the holdout, D739 floors with support thresholds | 2 d | P5 |
| B3 Detector exports: ONNX → OV fp16/int8 with user calibration; CoreML fp16 on Linux (fallback: Mac `ensureEngineFormats`); `suppliedLabelFloors` copied from the base (D741) | 1.5 d | P6 |
| B4 Dataset wizard additions: hard-negative share, held-out cameras, completeness gate | 1 d | P3 |
| B5 Canary + rollback + 7-day before/after panel | 2 d | P7 |
| B6 Batch replay gating MVP (N sessions, candidate vs production, raw track counts) | 2–3 d | D646 |
| B7 First real m-640 run on the 101 phantom plus night frames; promotion gate from the analysis §6 | 1 d + training | all of the above |

**Phase C (later).**

- `training-runpod` (REST v2 + S3), about 3 days.
- Rule-aware false alerts per day in the replay.
- The `:edgetpu` image for classifiers.
- Per-job encryption.
- A separate s-320 variant for the N100.
- A local NVIDIA provider (a provider that runs the same image through `docker run --gpus` on an agent node, so the same cap is reused).

### 8. Testing strategy

- **Fake provider (`training-fake`, test-only manifest entry or injected):**
  - an in-memory state machine with controllable transitions (`pending → running → succeeded|failed|lost`);
  - it replays a canned `CAMSTACK_EVENT` log and serves a canned artefact bundle with a real small ONNX classifier.
  - Orchestrator specs cover:
    - idempotent `startJob` and a retried `submitJob`;
    - reconcile after restart;
    - the cost cap firing a cancel;
    - an orphan sweep;
    - an sha256 mismatch (the job is refused);
    - cleanup running on every terminal path;
    - a dataset refused for low support.
- **Contract tests:** one suite parameterised over provider adapters. It runs against the fake in CI, and against Modal only on a manual, credentialed `workflow_dispatch` in the trainer repo, never the Checks workflow. A recorded-HTTP or SDK-mock layer pins the Modal SDK calls we make, so a version bump that changes signatures fails `tsc` and the contract test. Adapters are typed against the generated client, not hand-written interfaces ([[project_handwritten_cap_interfaces_rot_silently]]).
- **Cap router specs** in `server/backend/src/__tests__/cap-routers/` for both caps. The output shape is owned by the provider.
- **Trainer:** a pytest unit suite (spec validation, annotations → YOLO/crops conversion including padding 0.15 and boxes that cannot be derived, split honoured, the D739 floor rule on synthetic score tables, `result.json` schema).
- **Container smoke test in the trainer CI on a CPU runner:**
  - 1 epoch, a 40-image fixture, `yolov9t` at imgsz 160 and Lite0 at 96;
  - export ONNX, OV fp16 and int8 (8 calibration images) and CoreML;
  - validate `result.json` with the same zod schema the hub uses (exported to JSON Schema from `@camstack/types`).
- **Round trip:** a hub-side spec feeds the smoke output into `importModelBundle`, then runs `listModels` and checks that format revisions are set.
- **Export spec:** padding 0.15, `capturedAt` and `complete` present, the version filter, and the crops layout.
- **Auto-tune spec:** a node with a custom pin is excluded from Apply.

### 9. Risks

| Risk | Mitigation |
|---|---|
| Modal JS SDK is beta and changes | Pinned version, a thin adapter, contract test, RunPod as second implementation |
| Starter may not allow region pinning; data residency in the US | Show the region in the confirm step; EU at 1.15x when allowed; RunPod EU as the alternative |
| Detector evaluation corrupted by frames that are not fully annotated | `complete` flag; evaluation uses only complete frames; assist pre-annotation |
| Small held-out set → noisy floors, overfit to cameras | Support threshold, clamp, held out by camera and day, promotion gate, canary |
| Upload time and bandwidth from home hubs | Staging on a CPU sandbox, crops layout for classifiers, ETA in the estimate, resumable chunks (`prepareDataset` is keyed by sha256) |
| Runaway cost or orphaned GPU | Provider-enforced timeout, `maxCostUsd`, daily orphan sweep tagged by jobKey |
| CoreML conversion of YOLOv9 fails on Linux | Mac `ensureEngineFormats` fallback (already exists) |
| INT8 accuracy drop with a small calibration set | Report fp16 vs int8 metrics in the result; refuse int8 if mAP drops more than 0.02 |
| Plaintext secrets at rest | P8 secret-codec |
| AGPL perception | Separate public trainer repo; a process/file boundary; the licence carried in the catalog entry |
| Large image → slow first start | amd64 only, multi-stage build, Edge TPU split out, Modal image cache |
| Framework publish traps for new caps | Follow the force-publish of `@camstack/system` and verify with `listCapabilities` |
| Auto-tune clobbering a canary | P7 lands before Phase B |

### 10. Open questions for the operator

1. **Q1: Modal first despite the beta SDK, or RunPod first despite no free tier?** Recommendation: Modal, with RunPod in Phase C. The free tier is the point of experimenting.
2. **Q2: Data residency.** Require an EU region (1.15x+, if Starter allows it) or accept the provider default? Recommendation: default to "any", with an EU toggle shown in the confirm step. Frames stay in the user's account and are deleted after the job either way.
3. **Q3: Where does the trainer live?** A separate public AGPL repo `camstack/trainer`, or `tools/trainer/` inside camstack-server? <!-- drift-ok: an option the plan weighed; the trainer lives in hf/camstack-trainer --> Recommendation: a separate repo, which keeps the AGPL boundary visible and gives it its own CI.
4. **Q4: Phase A target.** Which classifier? Recommendation: a vehicle-type fine-tune from the D711 Lite0 recipe if that model exists by then, otherwise the animal classifier on the user's crops. Use an OI smoke set if the Q0 census finds no annotations.
5. **Q5: Edge TPU in scope for Phase A/B?** Recommendation: no. Classifiers only, in Phase C, as a separate `:edgetpu` image.
6. **Q6: Retention of staged artefacts and of the provider-side dataset.** Recommendation: cloud dataset deleted immediately after a successful fetch (24 h after a failure); hub artefacts kept 14 days after registration.
7. **Q7: Shared secret-codec (P8) as a prerequisite, or ship with plaintext like the plus catalog key does today?** Recommendation: land P8 first. It is one day, and these keys can spend money.
8. **Q8: Does registering ever happen automatically when the promotion gate passes?** Recommendation: never automatic. Register and canary stay explicit operator clicks; at most, a result is labelled "gate passed".

---

## Operator decisions (2026-10-08)

1. **Provider:** Modal first.
2. **Region, GPU, cost cap, retention, …:** they depend on the user's provider account. Every one of these is a **per-provider setting** in the provider addon's settings schema (defaults sensible, all overridable), not a hard-coded choice.
3. **Trainer source:** host it on Hugging Face (e.g. under a `source/` folder of the camstack HF org/repo) rather than a separate GitHub repo. The image still needs a registry Modal can pull from (GHCR), or Modal builds it from that source — decide in the A0 spike.
4. **First target:** the **YOLOv9 root detector** (Phase B becomes the first real target). The classifier-first Phase A is dropped. The vehicle classifier stays `vehicle-type-v1` (NC is acceptable: CamStack is free forever); no replacement, no zero-shot for now.
5. **Edge TPU:** later.
6. **Retention:** cloud dataset deleted right after a successful fetch (24 h after a failure); hub artefacts kept 14 days after registration.
7. **Secrets (P8 replaced):** design a **CamStack-managed keychain** for passwords/secrets, with migration of existing secrets on the operator's hub, and the ability for a config schema field to send its value straight to the keychain instead of the settings DB.
8. **Registration:** never automatic.
