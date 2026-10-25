/**
 * The job state machine (D805): start → upload → submit → poll → collect →
 * ready, with every failure path named and every terminal path cleaning the
 * cloud up.
 *
 * Registry-driven, not timer-driven: the reconcile tick compares every
 * non-terminal job with what the provider says (on boot, then every 30 s), so
 * a hub restart mid-run loses nothing — the job record and the provider's
 * jobKey tag are the whole truth. Background work (the upload, the collect)
 * is tracked in memory; a job found in one of those states with no task
 * behind it was interrupted by a restart and is handled as such.
 */
import {
  type ProviderJobStatus,
  type TrainerSourceRef,
  type TrainingFailureReason,
  type TrainingJob,
  type TrainingJobRequest,
  type TrainingJobState,
  type TrainingRefusalReason,
  TrainingResultSchema,
} from '@camstack/types'
import { findBaseModel } from './base-models.js'
import { applyLogLines } from './job-progress.js'
import { JobMutator } from './job-mutator.js'
import { buildJobSpec } from './job-spec.js'
import { ARTIFACT_RETENTION_DAYS, planJob } from './plan-job.js'
import type { EnginePorts } from './ports.js'

export const RECONCILE_INTERVAL_MS = 30_000
export const ORPHAN_SWEEP_INTERVAL_MS = 24 * 60 * 60_000
const DAY_MS = 24 * 60 * 60_000
export const ARTIFACT_RETENTION_MS = ARTIFACT_RETENTION_DAYS * DAY_MS
/** The provider enforces maxRuntimeSec; past it by this much, the hub cancels too. */
const RUNTIME_GRACE_MS = 10 * 60_000
const EVENT_PAGE = 500
const EVENT_PAGES_PER_POLL = 5

/** States the reconcile tick polls the provider for. */
const POLLED: ReadonlySet<TrainingJobState> = new Set([
  'submitted',
  'starting',
  'running',
  'cancelling',
])
/** States from which nothing more happens in the cloud. */
export const SETTLED: ReadonlySet<TrainingJobState> = new Set([
  'ready',
  'registered',
  'canary',
  'failed',
  'cancelled',
  'lost',
  'expired',
  'discarded',
])
/** A job in one of these holds (or is about to hold) a GPU. */
const ACTIVE: ReadonlySet<TrainingJobState> = new Set([
  'uploading',
  'submitted',
  'starting',
  'running',
  'collecting',
  'cancelling',
])

export type StartJobInput = TrainingJobRequest & {
  readonly name: string
  readonly maxCostUsd: number
  readonly maxRuntimeSec: number
  readonly idempotencyKey: string
}

export type StartJobResult =
  | { readonly kind: 'started'; readonly job: TrainingJob }
  | { readonly kind: 'refused'; readonly reason: TrainingRefusalReason; readonly detail: string }

export type StartJobBatchInput = Omit<TrainingJobRequest, 'baseModelId'> & {
  readonly baseModelIds: readonly string[]
  readonly name: string
  readonly maxCostUsd: number
  readonly maxRuntimeSec: number
  readonly idempotencyKey: string
}

export type StartJobBatchResult =
  | {
      readonly kind: 'started'
      readonly batchId: string
      readonly jobs: readonly TrainingJob[]
    }
  | { readonly kind: 'refused'; readonly reason: TrainingRefusalReason; readonly detail: string }

type AcceptedPlan = NonNullable<Awaited<ReturnType<typeof planJob>>['accepted']>

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class TrainingEngine {
  readonly mutator: JobMutator
  private readonly tasks = new Map<string, Promise<void>>()

  constructor(
    private readonly ports: EnginePorts,
    private readonly trainer: TrainerSourceRef,
  ) {
    this.mutator = new JobMutator(ports.jobs, ports.now)
  }

  /** Await every background task (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks.values()])
  }

  async startJob(input: StartJobInput): Promise<StartJobResult> {
    const existing = await this.ports.jobs.findByIdempotencyKey(input.idempotencyKey)
    if (existing !== null) return { kind: 'started', job: existing }
    const busy = this.busyJob(await this.ports.jobs.list())
    if (busy !== undefined) {
      return {
        kind: 'refused',
        reason: 'job-already-running',
        detail: `"${busy.name}" is still ${busy.state}`,
      }
    }
    const planned = await planJob(input, {
      corpus: this.ports.corpus,
      provider: this.ports.provider,
    })
    if (planned.plan.refusal !== null || planned.accepted === null) {
      const refusal = planned.plan.refusal ?? {
        reason: 'unknown-dataset' as const,
        detail: 'no plan',
      }
      return { kind: 'refused', reason: refusal.reason, detail: refusal.detail }
    }
    const { name, maxCostUsd, maxRuntimeSec, idempotencyKey, ...request } = input
    const job = this.newJobRow({
      request,
      name,
      maxCostUsd,
      maxRuntimeSec,
      idempotencyKey,
      batchId: null,
      state: 'uploading',
      accepted: planned.accepted,
    })
    await this.ports.jobs.put(job)
    this.ports.logger.info('training job started', {
      meta: {
        jobId: job.id,
        provider: request.entryId,
        gpu: request.gpuType,
        frames: job.frameCount,
        collections: request.selection.collectionIds.length,
      },
    })
    this.runTask(job.id, () => this.uploadAndSubmit(job.id))
    return { kind: 'started', job }
  }

  /**
   * One job per base model, same live selection snapshot. The first uploads;
   * siblings stay `queued` until the prior job in the batch settles.
   */
  async startJobBatch(input: StartJobBatchInput): Promise<StartJobBatchResult> {
    const existing = await this.ports.jobs.findByIdempotencyKey(input.idempotencyKey)
    if (existing !== null) {
      const batchId = existing.batchId ?? existing.id
      const jobs =
        existing.batchId === null
          ? [existing]
          : (await this.ports.jobs.list())
              .filter((j) => j.batchId === existing.batchId)
              .toSorted((a, b) => a.createdAt - b.createdAt)
      return { kind: 'started', batchId, jobs }
    }
    const busy = this.busyJob(await this.ports.jobs.list())
    if (busy !== undefined) {
      return {
        kind: 'refused',
        reason: 'job-already-running',
        detail: `"${busy.name}" is still ${busy.state}`,
      }
    }
    const models = uniqueBaseModelIds(input.baseModelIds)
    for (const modelId of models) {
      if (findBaseModel(modelId) === null) {
        return {
          kind: 'refused',
          reason: 'unknown-base-model',
          detail: `"${modelId}" is not a trainable base`,
        }
      }
    }
    const headModel = models[0]
    if (headModel === undefined) {
      return {
        kind: 'refused',
        reason: 'unknown-base-model',
        detail: 'no base models given',
      }
    }
    const shared: Omit<TrainingJobRequest, 'baseModelId'> = {
      selection: input.selection,
      entryId: input.entryId,
      gpuType: input.gpuType,
      region: input.region,
      preset: input.preset,
      freeze: input.freeze,
      holdoutCameras: input.holdoutCameras,
    }
    const planned = await planJob(
      { ...shared, baseModelId: headModel },
      { corpus: this.ports.corpus, provider: this.ports.provider },
    )
    if (planned.plan.refusal !== null || planned.accepted === null) {
      const refusal = planned.plan.refusal ?? {
        reason: 'unknown-dataset' as const,
        detail: 'no plan',
      }
      return { kind: 'refused', reason: refusal.reason, detail: refusal.detail }
    }
    const batchId = this.ports.newId()
    const jobs: TrainingJob[] = []
    for (let i = 0; i < models.length; i += 1) {
      const modelId = models[i]
      if (modelId === undefined) continue
      const job = this.newJobRow({
        request: { ...shared, baseModelId: modelId },
        name: input.name,
        maxCostUsd: input.maxCostUsd,
        maxRuntimeSec: input.maxRuntimeSec,
        idempotencyKey: i === 0 ? input.idempotencyKey : `${input.idempotencyKey}:${modelId}`,
        batchId,
        state: i === 0 ? 'uploading' : 'queued',
        accepted: planned.accepted,
      })
      await this.ports.jobs.put(job)
      jobs.push(job)
    }
    const head = jobs[0]
    if (head === undefined) {
      return {
        kind: 'refused',
        reason: 'unknown-base-model',
        detail: 'no base models given',
      }
    }
    this.ports.logger.info('training job batch started', {
      meta: {
        batchId,
        jobIds: jobs.map((j) => j.id),
        models: [...models],
        frames: head.frameCount,
      },
    })
    this.runTask(head.id, () => this.uploadAndSubmit(head.id))
    return { kind: 'started', batchId, jobs }
  }

  async cancelJob(id: string): Promise<TrainingJob> {
    const job = await this.ports.jobs.get(id)
    if (job === null) throw new Error(`training job "${id}" does not exist`)
    if (job.state === 'queued') {
      const moved = await this.mutator.update(id, (j) => ({ ...j, state: 'cancelled' }))
      return moved ?? job
    }
    if (!ACTIVE.has(job.state) || job.state === 'cancelling') return job
    const moved = await this.mutator.update(id, (j) => ({ ...j, state: 'cancelling' }))
    if (job.state !== 'uploading') {
      try {
        await this.ports.provider.cancelJob({ entryId: job.request.entryId, jobKey: id })
      } catch (err: unknown) {
        this.ports.logger.warn('training cancel call failed — the next reconcile retries', {
          meta: { jobId: id, error: errText(err) },
        })
      }
    }
    return moved ?? job
  }

  /** One reconcile pass over every job. Never throws; each job fails alone. */
  async tick(): Promise<void> {
    const jobs = await this.ports.jobs.list()
    const now = this.ports.now()
    for (const job of jobs) {
      try {
        await this.reconcile(job, now)
      } catch (err: unknown) {
        this.ports.logger.warn('training reconcile failed for one job', {
          meta: { jobId: job.id, state: job.state, error: errText(err) },
        })
      }
    }
  }

  /** Cloud jobs we hold no live record of are cancelled and cleaned (they burn credit). */
  async sweepOrphans(): Promise<readonly string[]> {
    const known = new Map((await this.ports.jobs.list()).map((j) => [j.id, j]))
    const swept: string[] = []
    for (const provider of await this.ports.provider.describe({})) {
      if (!provider.configured) continue
      for (const status of await this.ports.provider.listJobs({ entryId: provider.entryId })) {
        const record = known.get(status.jobKey)
        const live = record !== undefined && !SETTLED.has(record.state)
        const stillRunning =
          status.state === 'pending' || status.state === 'starting' || status.state === 'running'
        if (live || (record !== undefined && !stillRunning)) continue
        this.ports.logger.warn('training orphan swept — a cloud job with no live record', {
          meta: { jobKey: status.jobKey, provider: provider.addonId, state: status.state },
        })
        await this.ports.provider.cancelJob({ entryId: provider.entryId, jobKey: status.jobKey })
        await this.ports.provider.cleanupJob({ entryId: provider.entryId, jobKey: status.jobKey })
        swept.push(status.jobKey)
      }
    }
    return swept
  }

  // ── Steps ────────────────────────────────────────────────────────────

  private runTask(id: string, body: () => Promise<void>): void {
    if (this.tasks.has(id)) return
    const task = body()
      .catch((err: unknown) => {
        this.ports.logger.warn('training background step failed', {
          meta: { jobId: id, error: errText(err) },
        })
      })
      .finally(() => this.tasks.delete(id))
    this.tasks.set(id, task)
  }

  private async uploadAndSubmit(id: string): Promise<void> {
    const job = await this.ports.jobs.get(id)
    if (job === null) return
    const base = findBaseModel(job.request.baseModelId)
    if (base === null || job.frameIds.length === 0) {
      await this.fail(id, 'upload-failed', null, 'the corpus snapshot or base model disappeared')
      return
    }
    let uploaded: { bytes: number; sha256: string }
    try {
      const offer = await this.ports.datasets.offerArchive({
        filter: { frameIds: [...job.frameIds] },
        layout: job.datasetLayout,
      })
      uploaded = await this.ports.provider.uploadDataset({
        entryId: job.request.entryId,
        jobKey: id,
        ticket: offer.ticket,
      })
    } catch (err: unknown) {
      await this.fail(id, 'upload-failed', 'prepare', errText(err))
      await this.cleanupCloud(id)
      return
    }
    const afterUpload = await this.mutator.update(id, (j) => ({
      ...j,
      dataset: { bytes: uploaded.bytes, sha256: uploaded.sha256, uploadedAt: this.ports.now() },
    }))
    if (afterUpload?.state === 'cancelling') {
      await this.finishCancelled(id)
      return
    }
    try {
      const spec = buildJobSpec({
        job: afterUpload ?? job,
        base,
        versionId: `live-${job.annotationHash.slice(0, 12)}`,
        annotationHash: job.annotationHash,
        datasetSha256: uploaded.sha256,
      })
      const status = await this.ports.provider.submitJob({
        entryId: job.request.entryId,
        jobKey: id,
        trainer: job.trainer,
        jobSpecJson: JSON.stringify(spec),
        gpuType: job.request.gpuType,
        region: job.request.region,
        maxRuntimeSec: job.maxRuntimeSec,
      })
      await this.mutator.update(id, (j) => this.withStatus({ ...j, state: 'submitted' }, status))
    } catch (err: unknown) {
      await this.fail(id, 'submit-failed', 'prepare', errText(err))
      await this.cleanupCloud(id)
    }
  }

  private async reconcile(job: TrainingJob, now: number): Promise<void> {
    if (job.state === 'uploading' && !this.tasks.has(job.id)) {
      await this.fail(
        job.id,
        'hub-restart-during-upload',
        'prepare',
        'the hub restarted while the dataset was uploading',
      )
      await this.cleanupCloud(job.id)
      return
    }
    if (POLLED.has(job.state)) {
      await this.poll(job, now)
      return
    }
    if (job.state === 'collecting') {
      this.runTask(job.id, () => this.collect(job.id))
      return
    }
    await this.housekeep(job, now)
  }

  private async housekeep(job: TrainingJob, now: number): Promise<void> {
    // cleanupJob is idempotent, so "not yet confirmed deleted" is the whole condition.
    if (job.cloudDatasetDeletedAt === null && SETTLED.has(job.state)) {
      const due = job.state !== 'failed' || (job.cloudCleanupDueAt ?? 0) <= now
      if (due) await this.cleanupCloud(job.id)
    }
    if (job.artifacts !== null && job.artifacts.expiresAt <= now) {
      await this.ports.artifacts.remove(job.id)
      await this.mutator.update(job.id, (j) => ({
        ...j,
        artifacts: null,
        state: j.state === 'ready' ? 'expired' : j.state,
      }))
      this.ports.logger.info('training artefacts expired from the hub', { meta: { jobId: job.id } })
    }
  }

  private async poll(job: TrainingJob, now: number): Promise<void> {
    const ref = { entryId: job.request.entryId, jobKey: job.id }
    const status = await this.ports.provider.getJob(ref)
    let cursor = job.logCursor ?? undefined
    let progressed = { stage: job.stage, progress: job.progress, logTail: job.logTail }
    for (let page = 0; page < EVENT_PAGES_PER_POLL; page += 1) {
      const batch = await this.ports.provider.listJobEvents({
        ...ref,
        max: EVENT_PAGE,
        ...(cursor !== undefined ? { cursor } : {}),
      })
      progressed = applyLogLines(progressed, batch.lines)
      cursor = batch.cursor
      if (batch.lines.length < EVENT_PAGE) break
    }
    const updated = await this.mutator.update(job.id, (j) =>
      this.withStatus({ ...j, ...progressed, logCursor: cursor ?? null }, status),
    )
    if (updated === null) return
    await this.afterPoll(updated, status, now)
  }

  private async afterPoll(job: TrainingJob, status: ProviderJobStatus, now: number): Promise<void> {
    const ref = { entryId: job.request.entryId, jobKey: job.id }
    const running =
      status.state === 'pending' || status.state === 'starting' || status.state === 'running'
    if (job.state === 'cancelling') {
      if (!running) await this.finishCancelled(job.id)
      return
    }
    if (running && job.provider.costUsd >= job.maxCostUsd) {
      await this.ports.provider.cancelJob(ref)
      await this.fail(
        job.id,
        'cost-cap',
        job.stage,
        `spent $${job.provider.costUsd.toFixed(2)} of a $${job.maxCostUsd.toFixed(2)} cap`,
      )
      return
    }
    const started = job.provider.startedAt
    if (
      running &&
      started !== null &&
      now - started > job.maxRuntimeSec * 1000 + RUNTIME_GRACE_MS
    ) {
      await this.ports.provider.cancelJob(ref)
      await this.fail(job.id, 'runtime-cap', job.stage, `ran past ${String(job.maxRuntimeSec)} s`)
      return
    }
    if (status.state === 'succeeded') {
      await this.mutator.update(job.id, (j) => ({ ...j, state: 'collecting' }))
      this.runTask(job.id, () => this.collect(job.id))
      return
    }
    if (status.state === 'failed') {
      const detail = await this.failureDetail(job)
      await this.fail(
        job.id,
        'trainer-failed',
        job.stage,
        detail ?? status.failureReason ?? `exit ${String(status.exitCode ?? '?')}`,
      )
      return
    }
    if (status.state === 'cancelled') {
      await this.fail(job.id, 'provider-error', job.stage, 'the provider stopped the job')
      return
    }
    if (status.state === 'lost') {
      await this.mutator.update(job.id, (j) => ({ ...j, state: 'lost' }))
      await this.advanceBatchQueue(job.id)
    }
  }

  private async failureDetail(job: TrainingJob): Promise<string | null> {
    try {
      const raw = await this.ports.provider.readResult({
        entryId: job.request.entryId,
        jobKey: job.id,
      })
      if (!raw.found || raw.text === undefined) return null
      const parsed = TrainingResultSchema.safeParse(JSON.parse(raw.text))
      const error = parsed.success ? parsed.data.error : null
      return error === null ? null : `${error.stage}: ${error.code} — ${error.message}`
    } catch {
      return null
    }
  }

  private async collect(id: string): Promise<void> {
    const job = await this.ports.jobs.get(id)
    if (job === null || job.state !== 'collecting') return
    const ref = { entryId: job.request.entryId, jobKey: id }
    try {
      const raw = await this.ports.provider.readResult(ref)
      if (!raw.found || raw.text === undefined) {
        await this.fail(id, 'result-invalid', 'package', 'the job ended without a result.json')
        return
      }
      const parsed = TrainingResultSchema.safeParse(JSON.parse(raw.text))
      if (!parsed.success) {
        await this.fail(
          id,
          'result-invalid',
          'package',
          parsed.error.issues[0]?.message ?? 'unreadable',
        )
        return
      }
      const result = parsed.data
      if (
        result.status !== 'succeeded' ||
        result.bundle == null ||
        result.catalogDraft == null ||
        result.files === undefined
      ) {
        const why =
          result.error === null
            ? 'the result names no bundle'
            : `${result.error.stage}: ${result.error.message}`
        await this.fail(
          id,
          result.status === 'failed' ? 'trainer-failed' : 'result-invalid',
          'package',
          why,
        )
        return
      }
      const { ticket } = await this.ports.provider.offerArtifact({ ...ref, path: 'bundle.tar' })
      const got = await this.ports.artifacts.receiveBundle(id, ticket, result.bundle.bytes)
      if (got.sha256 !== result.bundle.sha256 || got.bytes !== result.bundle.bytes) {
        await this.ports.artifacts.remove(id)
        await this.fail(
          id,
          'checksum-mismatch',
          'package',
          'the fetched bundle does not match result.json',
        )
        return
      }
      await this.ports.artifacts.writeResult(id, raw.text)
      const now = this.ports.now()
      await this.mutator.update(id, (j) => ({
        ...j,
        state: 'ready',
        artifacts: {
          bundleBytes: got.bytes,
          bundleSha256: got.sha256,
          fetchedAt: now,
          expiresAt: now + ARTIFACT_RETENTION_MS,
        },
      }))
      this.ports.logger.info('training result fetched and verified', {
        meta: { jobId: id, bytes: got.bytes },
      })
      await this.cleanupCloud(id)
      await this.advanceBatchQueue(id)
    } catch (err: unknown) {
      await this.fail(id, 'fetch-failed', 'package', errText(err))
    }
  }

  private async finishCancelled(id: string): Promise<void> {
    await this.mutator.update(id, (j) => ({ ...j, state: 'cancelled' }))
    await this.cleanupCloud(id)
    await this.advanceBatchQueue(id)
  }

  /** Delete the cloud copy (dataset first). A failure is retried by the next tick. */
  private async cleanupCloud(id: string): Promise<void> {
    const job = await this.ports.jobs.get(id)
    if (job === null || job.cloudDatasetDeletedAt !== null) return
    try {
      const { deleted } = await this.ports.provider.cleanupJob({
        entryId: job.request.entryId,
        jobKey: id,
      })
      await this.mutator.update(id, (j) => ({
        ...j,
        cloudDatasetDeletedAt: this.ports.now(),
        cloudCleanupDueAt: null,
      }))
      this.ports.logger.info('training cloud copy deleted', {
        meta: { jobId: id, deleted: [...deleted] },
      })
    } catch (err: unknown) {
      this.ports.logger.warn('training cloud cleanup failed — retried on the next reconcile', {
        meta: { jobId: id, error: errText(err) },
      })
    }
  }

  private async fail(
    id: string,
    reason: TrainingFailureReason,
    stage: string | null,
    detail: string,
  ): Promise<void> {
    let grace = 0
    const job = await this.ports.jobs.get(id)
    if (job !== null && reason === 'trainer-failed') {
      const provider = (await this.ports.provider.describe({})).find(
        (p) => p.entryId === job.request.entryId,
      )
      grace = (provider?.defaults.failedDatasetGraceHours ?? 0) * 60 * 60_000
    }
    await this.mutator.update(id, (j) => ({
      ...j,
      state: 'failed',
      failure: { reason, stage, detail },
      cloudCleanupDueAt: this.ports.now() + grace,
    }))
    this.ports.logger.warn('training job failed', { meta: { jobId: id, reason, stage, detail } })
    await this.advanceBatchQueue(id)
  }

  private withStatus(job: TrainingJob, status: ProviderJobStatus): TrainingJob {
    const mapped: TrainingJobState =
      job.state === 'cancelling'
        ? 'cancelling'
        : status.state === 'pending'
          ? 'submitted'
          : status.state === 'starting'
            ? 'starting'
            : status.state === 'running'
              ? 'running'
              : job.state
    return {
      ...job,
      state: mapped,
      provider: {
        state: status.state,
        providerJobId: status.providerJobId ?? job.provider.providerJobId,
        startedAt: status.startedAt ?? job.provider.startedAt,
        endedAt: status.endedAt ?? job.provider.endedAt,
        billedSeconds: status.billedSeconds,
        costUsd: status.costUsd,
        costIsEstimate: status.costIsEstimate,
        lastPolledAt: this.ports.now(),
      },
    }
  }

  /**
   * Blocks a new start from outside while any non-settled job is in flight —
   * GPU-holding (`ACTIVE`) or a batch sibling still `queued`. Poll/cancel keep
   * using `ACTIVE` alone (queued holds no GPU).
   */
  private busyJob(jobs: readonly TrainingJob[]): TrainingJob | undefined {
    return jobs.find((j) => ACTIVE.has(j.state) || j.state === 'queued')
  }

  private newJobRow(args: {
    readonly request: TrainingJobRequest
    readonly name: string
    readonly maxCostUsd: number
    readonly maxRuntimeSec: number
    readonly idempotencyKey: string
    readonly batchId: string | null
    readonly state: 'uploading' | 'queued'
    readonly accepted: AcceptedPlan
  }): TrainingJob {
    const now = this.ports.now()
    const { corpus, split } = args.accepted
    return {
      id: this.ports.newId(),
      idempotencyKey: args.idempotencyKey,
      name: args.name,
      createdAt: now,
      updatedAt: now,
      state: args.state,
      batchId: args.batchId,
      stage: null,
      failure: null,
      request: args.request,
      maxCostUsd: args.maxCostUsd,
      maxRuntimeSec: args.maxRuntimeSec,
      trainer: this.trainer,
      datasetLayout: corpus.layout,
      frameCount: corpus.frameIds.length,
      frameIds: [...corpus.frameIds],
      annotationHash: corpus.annotationHash,
      dataset: null,
      split,
      provider: {
        state: null,
        providerJobId: null,
        startedAt: null,
        endedAt: null,
        billedSeconds: 0,
        costUsd: 0,
        costIsEstimate: true,
        lastPolledAt: null,
      },
      progress: { epoch: null, epochs: null, etaSec: null, series: [] },
      logTail: [],
      logCursor: null,
      artifacts: null,
      cloudDatasetDeletedAt: null,
      cloudCleanupDueAt: null,
      registeredModelIds: [],
      canary: null,
    }
  }

  /**
   * When a batch member settles and nothing else is ACTIVE, promote the next
   * `queued` sibling (same `batchId`, oldest first) into `uploading`.
   */
  private async advanceBatchQueue(settledId: string): Promise<void> {
    const settled = await this.ports.jobs.get(settledId)
    if (settled === null || settled.batchId === null || !SETTLED.has(settled.state)) return
    const jobs = await this.ports.jobs.list()
    if (jobs.some((j) => ACTIVE.has(j.state))) return
    const next = jobs
      .filter((j) => j.batchId === settled.batchId && j.state === 'queued')
      .toSorted((a, b) => a.createdAt - b.createdAt)[0]
    if (next === undefined) return
    const moved = await this.mutator.update(next.id, (j) =>
      j.state === 'queued' ? { ...j, state: 'uploading' } : j,
    )
    if (moved === null || moved.state !== 'uploading') return
    this.ports.logger.info('training batch advanced to next model', {
      meta: {
        batchId: settled.batchId,
        jobId: moved.id,
        baseModelId: moved.request.baseModelId,
      },
    })
    this.runTask(moved.id, () => this.uploadAndSubmit(moved.id))
  }
}

function uniqueBaseModelIds(ids: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
