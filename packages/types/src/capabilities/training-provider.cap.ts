import { z } from 'zod'
import { PeerBytesTicketSchema } from '../interfaces/addon-peer-bytes.js'
import type { ConfigUISchema } from '../interfaces/config-ui.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * `training-provider` — ONE cloud that can run the CamStack trainer.
 *
 * A thin, mockable translation layer: it knows how to run a container with a
 * GPU, move a dataset in, read the job's stdout and hand artefacts back. It
 * knows nothing about datasets, splits, floors, cost policy or Model Studio —
 * those are the `training` orchestrator's (D805). Every rule written there
 * once is what makes a second provider (RunPod, a local NVIDIA node) a new
 * manifest entry and nothing else.
 *
 * Collection of provider **types** (addons). Each addon owns zero or more
 * **entries** (credentials + defaults). Concat-fans: `describe`,
 * `describeTypes`, `listEntries`, `listJobs`. Single-row work is keyed by
 * `entryId`; callers also pass the owning `addonId` as the collection
 * selector (broker posture). Every method is `admin`: these spend money.
 *
 * Every cloud object a provider creates is tagged with the orchestrator's
 * `jobKey`, so a retried submit finds the job it already started instead of
 * starting a second GPU, and `listJobs` can find orphans.
 *
 * Bytes never ride a cap field: the dataset arrives as a `ctx.peerBytes`
 * ticket the producer (pipeline-analytics) minted, and artefacts leave as a
 * ticket the provider mints (D613).
 */

export const TrainingGpuOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** List price, USD per GPU-hour, before any region multiplier. */
  usdPerHour: z.number().nonnegative(),
  vramGb: z.number().nonnegative(),
})
export type TrainingGpuOption = z.infer<typeof TrainingGpuOptionSchema>

export const TrainingRegionOptionSchema = z.object({
  /** `''` = any region (the provider's choice). */
  id: z.string(),
  label: z.string(),
  priceMultiplier: z.number().positive(),
})
export type TrainingRegionOption = z.infer<typeof TrainingRegionOptionSchema>

/**
 * The provider's per-entry settings, as the orchestrator reads them. They
 * live on the PROVIDER addon's entry (operator decision 2026-10-08: they
 * depend on the user's account), never hard-coded in the orchestrator.
 */
export const TrainingProviderDefaultsSchema = z.object({
  gpuType: z.string(),
  region: z.string(),
  costCapUsd: z.number().nonnegative(),
  maxRuntimeSec: z.number().int().positive(),
  /** Hours a FAILED job's cloud dataset is kept for debugging; 0 = delete at once. */
  failedDatasetGraceHours: z.number().nonnegative(),
})
export type TrainingProviderDefaults = z.infer<typeof TrainingProviderDefaultsSchema>

/**
 * Entry form schema for a provider type — same seam as notification
 * `TargetKind.configSchema` (`z.unknown()` at the wire; callers tighten to
 * {@link ConfigUISchema}). Drives `ConfigFormBuilder` on Training → Providers.
 */
const ConfigSchemaPassthrough = z.unknown()

/** One creatable provider type, for the Add-entry dialog. */
export const TrainingProviderTypeSchema = z.object({
  typeId: z.string(),
  label: z.string(),
  /** Path under the addon package (e.g. `assets/training-modal/icon.svg`). */
  iconAsset: z.string(),
  /** Owning `training-provider` addon — collection selector for createEntry. */
  addonId: z.string(),
  /**
   * Fields for one entry of this type (credentials + defaults). Absent on a
   * type that only needs a name. Password fields are keychain-backed on the
   * provider addon (`secretStatePaths`), not D634 plaintext.
   */
  configSchema: ConfigSchemaPassthrough.optional(),
})
export type TrainingProviderType = Omit<
  z.infer<typeof TrainingProviderTypeSchema>,
  'configSchema'
> & {
  readonly configSchema?: ConfigUISchema
}

/** One configured account / workspace under a provider type. */
export const TrainingProviderEntrySchema = z.object({
  entryId: z.string(),
  typeId: z.string(),
  name: z.string(),
  addonId: z.string(),
  /** Credentials are present — never the values. */
  configured: z.boolean(),
})
export type TrainingProviderEntry = z.infer<typeof TrainingProviderEntrySchema>

export const TrainingProviderDescriptorSchema = z.object({
  addonId: z.string(),
  entryId: z.string(),
  typeId: z.string(),
  /** Operator-chosen entry name. */
  name: z.string(),
  iconAsset: z.string(),
  /** `modal`, `runpod`, `fake`, … — same as typeId for current providers. */
  kind: z.string(),
  label: z.string(),
  gpuTypes: z.array(TrainingGpuOptionSchema).readonly(),
  regions: z.array(TrainingRegionOptionSchema).readonly(),
  maxDatasetBytes: z.number().int().positive(),
  maxRuntimeSec: z.number().int().positive(),
  freeTierNote: z.string().optional(),
  /** Where the data goes, in one sentence the confirm dialog repeats. */
  dataResidencyNote: z.string(),
  /** Credentials are present — never the values. */
  configured: z.boolean(),
  defaults: TrainingProviderDefaultsSchema,
  /**
   * Values for {@link TrainingProviderTypeSchema}'s `configSchema` — password
   * fields are keychain {@link SecretFieldView} or `null` / `''` (create),
   * never plaintext. Same hydrate contract as settings forms (D789).
   */
  formValues: z.record(z.string(), z.unknown()).optional(),
})
export type TrainingProviderDescriptor = z.infer<typeof TrainingProviderDescriptorSchema>

/**
 * Patch one entry's name, credentials and defaults. Pin with owning `{ addonId }`.
 * An omitted or empty `tokenSecret` means KEEP the stored secret (D787).
 * `{ $secretClear: true }` clears it.
 */
export const TrainingProviderUpdateEntryInputSchema = z.object({
  entryId: z.string().min(1),
  name: z.string().min(1),
  tokenId: z.string().optional(),
  tokenSecret: z.union([z.string(), z.object({ $secretClear: z.literal(true) })]).optional(),
  environment: z.string().optional(),
  gpuType: z.string().optional(),
  region: z.string().optional(),
  costCapUsd: z.number().nonnegative().optional(),
  maxRuntimeSec: z.number().int().positive().optional(),
  failedDatasetGraceHours: z.number().nonnegative().optional(),
})
export type TrainingProviderUpdateEntryInput = z.infer<
  typeof TrainingProviderUpdateEntryInputSchema
>

export const TrainingCredentialCheckSchema = z.object({
  ok: z.boolean(),
  /** Workspace / account name, when the provider says. */
  account: z.string().optional(),
  reason: z.enum(['missing', 'invalid', 'forbidden', 'network', 'quota']).optional(),
  detail: z.string().optional(),
})
export type TrainingCredentialCheck = z.infer<typeof TrainingCredentialCheckSchema>

export const ProviderJobStateSchema = z.enum([
  'pending',
  'starting',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  /** The provider has no record of the job any more. */
  'lost',
])
export type ProviderJobState = z.infer<typeof ProviderJobStateSchema>

export const ProviderJobStatusSchema = z.object({
  jobKey: z.string(),
  providerJobId: z.string().optional(),
  state: ProviderJobStateSchema,
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  exitCode: z.number().int().optional(),
  failureReason: z.string().optional(),
  gpuType: z.string(),
  region: z.string().optional(),
  billedSeconds: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  /** True when `costUsd` is runtime × list price, not a billing answer. */
  costIsEstimate: z.boolean(),
  lastFetchedAt: z.number(),
})
export type ProviderJobStatus = z.infer<typeof ProviderJobStatusSchema>

/**
 * The trainer the job runs, by SOURCE revision: the provider turns it into an
 * image its own way (Modal builds the published Dockerfile at that revision;
 * a registry-pull provider maps it to a tag). Recorded on the job and echoed
 * in `result.json`.
 */
export const TrainerSourceRefSchema = z.object({
  /** Hugging Face repo id, e.g. `camstack/camstack-trainer`. */
  repo: z.string().min(1),
  /** A commit sha (never a branch) — the job must be reproducible. */
  revision: z.string().regex(/^[0-9a-f]{7,64}$/),
})
export type TrainerSourceRef = z.infer<typeof TrainerSourceRefSchema>

/** Cloud job identity — route with the owning addon's `addonId` selector. */
const JobRef = { entryId: z.string().min(1), jobKey: z.string().uuid() }

export const TrainingLogLineSchema = z.object({ ts: z.number(), text: z.string() })
export type TrainingLogLine = z.infer<typeof TrainingLogLineSchema>

export const trainingProviderCapability = {
  name: 'training-provider',
  scope: 'system',
  mode: 'collection',
  internal: true,
  methods: {
    /** Every entry's offer and settings. Concat-fans across providers. */
    describe: method(z.object({}), z.array(TrainingProviderDescriptorSchema).readonly(), {
      auth: 'admin',
    }),

    /** Creatable types for the Add-entry dialog. Concat-fans. */
    describeTypes: method(z.object({}), z.array(TrainingProviderTypeSchema).readonly(), {
      auth: 'admin',
    }),

    /** Configured entries (pills). Concat-fans. */
    listEntries: method(z.object({}), z.array(TrainingProviderEntrySchema).readonly(), {
      auth: 'admin',
    }),

    /**
     * Create an entry under this provider type. Pin with `{ addonId }` of the
     * type's owning addon (from describeTypes).
     */
    createEntry: method(
      z.object({ typeId: z.string().min(1), name: z.string().min(1) }),
      z.object({ entryId: z.string() }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /** Delete an entry. Pin with the owning `{ addonId }`. */
    deleteEntry: method(
      z.object({ entryId: z.string().min(1) }),
      z.object({ ok: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),

    /**
     * Update one entry (name, credentials, defaults). Pin with owning
     * `{ addonId }`. Empty/omitted `tokenSecret` keeps the stored secret.
     */
    updateEntry: method(TrainingProviderUpdateEntryInputSchema, z.object({ ok: z.literal(true) }), {
      kind: 'mutation',
      auth: 'admin',
    }),

    /** Call the provider with the entry's stored credentials. Never returns them. */
    validateCredentials: method(
      z.object({ entryId: z.string().min(1) }),
      TrainingCredentialCheckSchema,
      {
        kind: 'mutation',
        auth: 'admin',
        timeoutMs: 30_000,
      },
    ),

    /** USD range for a run of `gpuSeconds` on `gpuType` in `region`. */
    estimateJob: method(
      z.object({
        entryId: z.string().min(1),
        gpuType: z.string(),
        region: z.string(),
        datasetBytes: z.number().int().nonnegative(),
        gpuSecondsLow: z.number().nonnegative(),
        gpuSecondsHigh: z.number().nonnegative(),
      }),
      z.object({
        usdLow: z.number().nonnegative(),
        usdHigh: z.number().nonnegative(),
        notes: z.array(z.string()).readonly(),
      }),
      { auth: 'admin' },
    ),

    /**
     * Take the dataset archive behind `ticket` (minted by pipeline-analytics,
     * same host) and land it as the job's dataset in the cloud, streamed —
     * nothing is staged on the hub's disk. Idempotent per `jobKey`: a second
     * call replaces a partial upload. Answers what actually landed.
     */
    uploadDataset: method(
      z.object({ ...JobRef, ticket: PeerBytesTicketSchema }),
      z.object({ bytes: z.number().int().nonnegative(), sha256: z.string() }),
      { kind: 'mutation', auth: 'admin', timeoutMs: 2 * 60 * 60_000 },
    ),

    /**
     * Start the trainer on a GPU. Looks the job up by `jobKey` first, so a
     * retried submit never starts a second GPU. `jobSpecJson` is written next
     * to the dataset as `job.json`; `maxRuntimeSec` is enforced by the
     * provider (a hard timeout), not by the hub.
     */
    submitJob: method(
      z.object({
        ...JobRef,
        trainer: TrainerSourceRefSchema,
        jobSpecJson: z.string().min(2).max(64_000),
        gpuType: z.string(),
        region: z.string(),
        maxRuntimeSec: z.number().int().positive(),
      }),
      ProviderJobStatusSchema,
      { kind: 'mutation', auth: 'admin', timeoutMs: 30 * 60_000 },
    ),

    getJob: method(z.object(JobRef), ProviderJobStatusSchema, { auth: 'admin', timeoutMs: 60_000 }),

    /** Stdout/stderr since `cursor` (opaque), oldest first, at most `max` lines. */
    listJobEvents: method(
      z.object({ ...JobRef, cursor: z.string().optional(), max: z.number().int().min(1).max(500) }),
      z.object({ lines: z.array(TrainingLogLineSchema).readonly(), cursor: z.string() }),
      { auth: 'admin', timeoutMs: 60_000 },
    ),

    /** Stop the job. Idempotent: an unknown or finished job is a no-op. */
    cancelJob: method(z.object(JobRef), z.object({ ok: z.literal(true) }), {
      kind: 'mutation',
      auth: 'admin',
      timeoutMs: 60_000,
    }),

    /** The job's `result.json`, as text (small, JSON). `found: false` before it exists. */
    readResult: method(
      z.object(JobRef),
      z.object({ found: z.boolean(), text: z.string().optional() }),
      { kind: 'mutation', auth: 'admin', timeoutMs: 5 * 60_000 },
    ),

    /**
     * Offer one output file of the job (`bundle.tar`) to the caller as a
     * one-shot `ctx.peerBytes` ticket, streamed from the cloud — the provider
     * stages nothing on disk. The caller dials it at once.
     */
    offerArtifact: method(
      z.object({ ...JobRef, path: z.enum(['bundle.tar']) }),
      z.object({ ticket: PeerBytesTicketSchema }),
      { kind: 'mutation', auth: 'admin', timeoutMs: 5 * 60_000 },
    ),

    /** Delete every cloud object tagged with `jobKey` (the dataset first). Idempotent. */
    cleanupJob: method(z.object(JobRef), z.object({ deleted: z.array(z.string()).readonly() }), {
      kind: 'mutation',
      auth: 'admin',
      timeoutMs: 5 * 60_000,
    }),

    /**
     * Jobs this provider can still see. Optional `entryId` filters; omit to
     * list every entry (orphan sweep). Pin with `{ addonId }`.
     */
    listJobs: method(
      z.object({ entryId: z.string().min(1).optional() }),
      z.array(ProviderJobStatusSchema).readonly(),
      {
        auth: 'admin',
        timeoutMs: 2 * 60_000,
      },
    ),
  },
} as const satisfies CapabilityDefinition

export type ITrainingCloudProvider = InferProvider<typeof trainingProviderCapability>
