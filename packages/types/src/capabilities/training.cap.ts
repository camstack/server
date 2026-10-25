import { z } from 'zod'
import { TrainingResultSchema, TrainingStageSchema } from '../training/trainer-contract.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import { RetrainExportLayoutSchema } from './pipeline-analytics.cap.js'
import { ProviderJobStateSchema, TrainerSourceRefSchema } from './training-provider.cap.js'

/**
 * `training` — the cloud-training orchestrator (D805). Hub-only singleton,
 * provided by `addon-training`.
 *
 * It owns what every provider must agree on, written once:
 *
 * - **Jobs.** A persisted state machine, a reconcile loop against the
 *   provider, a cost guard, a daily orphan sweep and the retention rules.
 * - **The return flow.** Verified artefacts → Model Studio
 *   (`custom-model-registry.importModelBundle`) → canary on accelerators →
 *   rollback. Nothing is ever registered automatically.
 *
 * Plan/start takes a live {@link TrainingCorpusSelection} (collections +
 * work-state rule); frame ids are resolved via pipeline-analytics at that
 * moment and snapshotted on the job. No frozen dataset version.
 *
 * Every method is `admin`.
 */

/**
 * Live corpus criteria for plan/start (design §5.2). Default is complete-only.
 * Frame ids are resolved at plan/start — never a frozen version id.
 */
export const TrainingCorpusSelectionSchema = z.object({
  collectionIds: z.array(z.string()).min(1),
  /** Default complete-only for v1 */
  workState: z.enum(['complete', 'annotated_or_complete', 'any_annotated']).default('complete'),
})
export type TrainingCorpusSelection = z.infer<typeof TrainingCorpusSelectionSchema>

// ── Targets ────────────────────────────────────────────────────────────

/** A base model a detector job can fine-tune, and the baseline it is judged against. */
export const TrainingBaseModelSchema = z.object({
  modelId: z.string(),
  label: z.string(),
  weights: z.string(),
  imgsz: z.number().int(),
  baselineOnnxUrl: z.string(),
  baselineFloors: z.record(z.string(), z.number()),
  /** The base the fleet runs most — the UI's default. */
  recommended: z.boolean(),
})
export type TrainingBaseModel = z.infer<typeof TrainingBaseModelSchema>

export const TrainingPresetSchema = z.enum(['quick', 'standard', 'thorough'])
export type TrainingPreset = z.infer<typeof TrainingPresetSchema>

export const TrainingJobRequestSchema = z.object({
  /** Live collection + work-state criteria; resolved at plan/start. */
  selection: TrainingCorpusSelectionSchema,
  /**
   * The provider **entry** that runs it (credentials + defaults).
   * Resolve to an owning addon via `training-provider.describe` / `listEntries`.
   */
  entryId: z.string().min(1),
  gpuType: z.string().min(1),
  region: z.string(),
  baseModelId: z.string().min(1),
  preset: TrainingPresetSchema,
  /** Freeze the backbone's first N layers; `null` = the preset's choice. */
  freeze: z.number().int().nonnegative().nullable(),
  /** Cameras held out whole for evaluation; `null` = the orchestrator's default. */
  holdoutCameras: z.array(z.number().int()).nullable(),
})
export type TrainingJobRequest = z.infer<typeof TrainingJobRequestSchema>

export const TrainingSplitPlanSchema = z.object({
  holdoutCameras: z.array(z.number().int()).readonly(),
  /** Used when no camera is held out: the last N days of every camera. */
  holdoutLastDays: z.number().int().nonnegative(),
  /** Holdout subjects per class (camera holdout only; `null` = known only after the split). */
  holdoutSupport: z.record(z.string(), z.number().int()).nullable(),
  trainSubjects: z.number().int(),
})
export type TrainingSplitPlan = z.infer<typeof TrainingSplitPlanSchema>

export const TrainingRefusalReasonSchema = z.enum([
  'unknown-dataset',
  'unknown-provider',
  'provider-not-configured',
  'unknown-base-model',
  'unknown-gpu',
  'dataset-too-large',
  'no-training-subjects',
  'job-already-running',
])
export type TrainingRefusalReason = z.infer<typeof TrainingRefusalReasonSchema>

export const TrainingJobPlanSchema = z.object({
  refusal: z.object({ reason: TrainingRefusalReasonSchema, detail: z.string() }).nullable(),
  warnings: z.array(z.string()).readonly(),
  split: TrainingSplitPlanSchema.nullable(),
  estimate: z
    .object({
      datasetBytes: z.number().int(),
      uploadMinutesAt20Mbps: z.number(),
      gpuSecondsLow: z.number(),
      gpuSecondsHigh: z.number(),
      usdLow: z.number(),
      usdHigh: z.number(),
      notes: z.array(z.string()).readonly(),
    })
    .nullable(),
  /** Pre-filled from the provider's settings; the operator may lower or raise them. */
  defaults: z.object({ maxCostUsd: z.number(), maxRuntimeSec: z.number().int() }).nullable(),
  /** The sentence the confirm dialog repeats: where the frames go and when they are deleted. */
  dataNotice: z.string(),
})
export type TrainingJobPlan = z.infer<typeof TrainingJobPlanSchema>

// ── Jobs ───────────────────────────────────────────────────────────────

/**
 * Orchestrator-owned states, persisted. `uploading` covers exporting the
 * archive (it is streamed, never staged). Terminal: `failed`, `cancelled`,
 * `lost`, `expired`, `discarded`. `registered` and `canary` are where a
 * result lives after the operator acted on it.
 */
export const TrainingJobStateSchema = z.enum([
  /** Waiting in a sequential multi-model batch; not holding a GPU. */
  'queued',
  'uploading',
  'submitted',
  'starting',
  'running',
  'collecting',
  'ready',
  'registered',
  'canary',
  'failed',
  'cancelling',
  'cancelled',
  'lost',
  'expired',
  'discarded',
])
export type TrainingJobState = z.infer<typeof TrainingJobStateSchema>

export const TrainingFailureReasonSchema = z.enum([
  'cost-cap',
  'runtime-cap',
  'upload-failed',
  'submit-failed',
  'trainer-failed',
  'result-invalid',
  'checksum-mismatch',
  'fetch-failed',
  'provider-error',
  'hub-restart-during-upload',
])
export type TrainingFailureReason = z.infer<typeof TrainingFailureReasonSchema>

export const TrainingProgressPointSchema = z.object({
  epoch: z.number().int(),
  map50: z.number().nullable(),
  map50_95: z.number().nullable(),
})
export type TrainingProgressPoint = z.infer<typeof TrainingProgressPointSchema>

/** One accelerator: a `(node, inference device)` that runs the root detector. */
export const TrainingAcceleratorRefSchema = z.object({
  nodeId: z.string(),
  deviceKey: z.string(),
})
export type TrainingAcceleratorRef = z.infer<typeof TrainingAcceleratorRefSchema>

/**
 * A canary pins the registered model on chosen ACCELERATORS — a model is
 * chosen by the accelerator that runs it (D927); every camera balanced onto
 * one runs it. `previous` is the root-detector pin each one had (`null` = it
 * ran its default), exactly, so rollback restores it.
 */
export const TrainingCanarySchema = z.object({
  accelerators: z.array(TrainingAcceleratorRefSchema).readonly(),
  since: z.number(),
  previous: z
    .array(TrainingAcceleratorRefSchema.extend({ modelId: z.string().nullable() }))
    .readonly(),
})
export type TrainingCanary = z.infer<typeof TrainingCanarySchema>

/** An accelerator a canary may pin: it runs the root detector, on this model now. */
export const TrainingCanaryTargetSchema = TrainingAcceleratorRefSchema.extend({
  pinnedModelId: z.string().nullable(),
})
export type TrainingCanaryTarget = z.infer<typeof TrainingCanaryTargetSchema>

export const TrainingJobSchema = z.object({
  id: z.string(),
  idempotencyKey: z.string(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  state: TrainingJobStateSchema,
  /**
   * Shared by every job enqueued together via `startJobBatch`.
   * `null` for a lone `startJob`. The engine advances queued siblings by this id.
   */
  batchId: z.string().nullable().default(null),
  stage: TrainingStageSchema.nullable(),
  failure: z
    .object({
      reason: TrainingFailureReasonSchema,
      stage: z.string().nullable(),
      detail: z.string(),
    })
    .nullable(),
  request: TrainingJobRequestSchema,
  maxCostUsd: z.number().nonnegative(),
  maxRuntimeSec: z.number().int().positive(),
  trainer: TrainerSourceRefSchema,
  datasetLayout: RetrainExportLayoutSchema,
  /** Frame count snapshotted when the job started (audit; equals `frameIds.length`). */
  frameCount: z.number().int().nonnegative(),
  /** Resolved frame ids at start — the archive ships exactly these. */
  frameIds: z.array(z.string()).max(20_000).readonly(),
  /** Hash of what those frames taught at start (trainer `dataset.annotationHash`). */
  annotationHash: z.string(),
  dataset: z
    .object({ bytes: z.number().int(), sha256: z.string(), uploadedAt: z.number() })
    .nullable(),
  split: TrainingSplitPlanSchema,
  provider: z.object({
    state: ProviderJobStateSchema.nullable(),
    providerJobId: z.string().nullable(),
    startedAt: z.number().nullable(),
    endedAt: z.number().nullable(),
    billedSeconds: z.number(),
    costUsd: z.number(),
    costIsEstimate: z.boolean(),
    lastPolledAt: z.number().nullable(),
  }),
  progress: z.object({
    epoch: z.number().int().nullable(),
    epochs: z.number().int().nullable(),
    etaSec: z.number().nullable(),
    series: z.array(TrainingProgressPointSchema).readonly(),
  }),
  /** The last lines of the job's output (≤ 200), newest last. Never frame paths. */
  logTail: z.array(z.string()).readonly(),
  logCursor: z.string().nullable(),
  artifacts: z
    .object({
      bundleBytes: z.number().int(),
      bundleSha256: z.string(),
      fetchedAt: z.number(),
      /** When the staged artefacts are deleted from the hub. */
      expiresAt: z.number(),
    })
    .nullable(),
  /** When the provider-side copy of the frames was deleted; null while it exists. */
  cloudDatasetDeletedAt: z.number().nullable(),
  /** A failed job's dataset is kept until then (the provider's grace), then deleted. */
  cloudCleanupDueAt: z.number().nullable(),
  /** Model ids registered from this job (base, and int8 when kept). */
  registeredModelIds: z.array(z.string()).readonly(),
  canary: TrainingCanarySchema.nullable(),
})
export type TrainingJob = z.infer<typeof TrainingJobSchema>

const IdInput = z.object({ id: z.string().min(1) })

export const trainingCapability = {
  name: 'training',
  scope: 'system',
  mode: 'singleton',
  mount: { kind: 'hub-only' },
  methods: {
    // ── Targets and planning ─────────────────────────────────────────
    listBaseModels: method(z.object({}), z.array(TrainingBaseModelSchema).readonly(), {
      auth: 'admin',
    }),
    /** Split, estimate, defaults and any named refusal — nothing is started. */
    planJob: method(TrainingJobRequestSchema, TrainingJobPlanSchema, {
      auth: 'admin',
      timeoutMs: 60_000,
    }),

    // ── Jobs ─────────────────────────────────────────────────────────
    /**
     * Start a job. The same `idempotencyKey` returns the job it already
     * started. Answers at once (`uploading`); the upload and the submit run in
     * the background and the job record says how far they got.
     */
    startJob: method(
      TrainingJobRequestSchema.extend({
        name: z.string().min(1).max(120),
        maxCostUsd: z.number().positive(),
        maxRuntimeSec: z.number().int().positive(),
        idempotencyKey: z.string().min(8).max(80),
      }),
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('started'), job: TrainingJobSchema }),
        z.object({
          kind: z.literal('refused'),
          reason: TrainingRefusalReasonSchema,
          detail: z.string(),
        }),
      ]),
      { kind: 'mutation', auth: 'admin', timeoutMs: 120_000 },
    ),
    /**
     * Enqueue one job per base model (same selection, entry, caps). The first
     * becomes `uploading`; the rest stay `queued` until the prior job settles.
     * One ACTIVE job at a time — a parallel `startJob` still gets
     * `job-already-running`. The same `idempotencyKey` returns the batch it
     * already started.
     */
    startJobBatch: method(
      TrainingJobRequestSchema.omit({ baseModelId: true }).extend({
        baseModelIds: z.array(z.string().min(1)).min(1),
        name: z.string().min(1).max(120),
        maxCostUsd: z.number().positive(),
        maxRuntimeSec: z.number().int().positive(),
        idempotencyKey: z.string().min(8).max(80),
      }),
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('started'),
          batchId: z.string(),
          jobs: z.array(TrainingJobSchema).min(1).readonly(),
        }),
        z.object({
          kind: z.literal('refused'),
          reason: TrainingRefusalReasonSchema,
          detail: z.string(),
        }),
      ]),
      { kind: 'mutation', auth: 'admin', timeoutMs: 120_000 },
    ),
    listJobs: method(z.object({}), z.array(TrainingJobSchema).readonly(), { auth: 'admin' }),
    getJob: method(IdInput, TrainingJobSchema.nullable(), { auth: 'admin' }),
    cancelJob: method(IdInput, TrainingJobSchema, {
      kind: 'mutation',
      auth: 'admin',
      timeoutMs: 120_000,
    }),
    /** The verified `result.json` of a job in `ready` or later; null before. */
    getJobResult: method(IdInput, TrainingResultSchema.nullable(), { auth: 'admin' }),

    // ── Return flow (never automatic) ────────────────────────────────
    /** The accelerators a canary may pin: every enabled one that runs the root detector. */
    listCanaryTargets: method(z.void(), z.array(TrainingCanaryTargetSchema).readonly(), {
      auth: 'admin',
    }),
    /** Hand the verified bundle to Model Studio; optionally canary right after. */
    registerResult: method(
      IdInput.extend({ canaryAccelerators: z.array(TrainingAcceleratorRefSchema).readonly() }),
      TrainingJobSchema,
      { kind: 'mutation', auth: 'admin', timeoutMs: 30 * 60_000 },
    ),
    /** Pin the registered model on these accelerators, remembering what it replaced. */
    canaryResult: method(
      IdInput.extend({ accelerators: z.array(TrainingAcceleratorRefSchema).min(1).readonly() }),
      TrainingJobSchema,
      { kind: 'mutation', auth: 'admin', timeoutMs: 120_000 },
    ),
    /** Put every canary accelerator back exactly as it was. */
    rollbackCanary: method(IdInput, TrainingJobSchema, {
      kind: 'mutation',
      auth: 'admin',
      timeoutMs: 120_000,
    }),
    /** Delete the staged artefacts of an unregistered result. */
    discardResult: method(IdInput, TrainingJobSchema, { kind: 'mutation', auth: 'admin' }),
  },
} as const satisfies CapabilityDefinition

export type ITrainingOrchestrator = InferProvider<typeof trainingCapability>
