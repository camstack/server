/**
 * The `jobs` provider: the ledger of long-running work (planning#719, D1105).
 *
 * - Audience is enforced here (`job-policy.ts`), nowhere else.
 * - A terminal state never walks back. Cancel asks the PRODUCER; the state changes only
 *   when the producer reports it through `update`.
 * - Progress lives in memory and reaches the ledger at most once per
 *   {@link PROGRESS_PERSIST_MS}; a state transition is written at once.
 * - Reconcile (D49, D3): driven by a producer registering and by a stale job seen on a read,
 *   never by a timer. A job the producer does not know becomes `interrupted` only after a
 *   SECOND read says so; a read that fails changes nothing.
 */
import {
  isTerminalJobState,
  type CapCaller,
  type JobSourceEntry,
  type IJobsProvider,
  type IScopedLogger,
  type Job,
  type JobCancelReason,
  type JobEntityRef,
  type JobRegisterInput,
  type JobResult,
  type JobSnapshot,
  type JobState,
  type JobSummary,
  type JobUpdateInput,
} from '@dominevo/types'
import { canCancelJob, canSeeJob, selectJobsToPrune, type JobRetention } from './job-policy.js'
import type { JobStore, StoredJob } from './job-store.js'

export const PROGRESS_PERSIST_MS = 5_000
/** A producer confirmed a job this recently: reconcile leaves it alone. */
export const RECONCILE_GRACE_MS = 10_000
/** A job not confirmed for this long is reconciled when a read sees it. */
export const STALE_CONFIRMATION_MS = 60_000

/** The `job-source` calls this provider makes, each pinned to one producer addon. */
export interface IJobProducerClient {
  getJobs(producerAddonId: string, jobIds: readonly string[]): Promise<readonly JobSourceEntry[]>
  cancelJob(producerAddonId: string, jobId: string): Promise<{ readonly accepted: boolean }>
  resolveResult(producerAddonId: string, jobId: string): Promise<JobResult | null>
}

export interface JobsProviderDeps {
  readonly store: JobStore
  readonly producers: IJobProducerClient
  readonly emitChanged: (jobId: string, state: JobState) => void
  readonly retention: () => JobRetention
  readonly logger: IScopedLogger
  readonly now: () => number
  readonly newId: () => string
}

function sameEntity(job: Job, entity: JobEntityRef): boolean {
  const own = job.subject?.entity
  return own !== undefined && own.kind === entity.kind && own.id === entity.id
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class JobsProvider {
  /** Live (queued / running) jobs, with the freshest progress. Terminal jobs leave it. */
  private readonly live = new Map<string, StoredJob>()
  private readonly lastPersistedAt = new Map<string, number>()
  private readonly reconciling = new Set<string>()
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly deps: JobsProviderDeps) {}

  /** The provider registered on the `jobs` capability. */
  asProvider(): IJobsProvider {
    return {
      register: (input) => this.register(input),
      update: (input) => this.update(input),
      list: (input) =>
        this.list(input.caller, {
          ...(input.states !== undefined ? { states: input.states } : {}),
          includeDismissed: input.includeDismissed,
          ...(input.entity !== undefined ? { entity: input.entity } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        }),
      get: (input) => this.get(input.caller, input.jobId),
      getSummary: (input) => this.getSummary(input.caller),
      cancel: (input) => this.cancel(input.caller, input.jobId),
      dismiss: (input) => this.dismiss(input.caller, input.jobId),
      collect: (input) => this.collect(input.caller, input.jobId),
    }
  }

  /** Serialises writes so two registers or updates of one job never interleave. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  // ── Producer side ────────────────────────────────────────────────

  register(input: JobRegisterInput): Promise<{ jobId: string }> {
    return this.exclusive(async () => {
      const existing = await this.findByKey(input.idempotencyKey)
      if (existing !== null) return { jobId: existing.jobId }
      const now = this.deps.now()
      const job: StoredJob = {
        jobId: this.deps.newId(),
        kind: input.kind,
        producerAddonId: input.producerAddonId,
        ownerUserId: input.ownerUserId,
        audience: input.audience,
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
        titleKey: input.titleKey,
        titleParams: input.titleParams,
        state: input.state,
        failure: null,
        progress: input.progress ?? null,
        cancellable: input.cancellable,
        createdAt: now,
        updatedAt: now,
        lastConfirmedAt: now,
        finishedAt: null,
        idempotencyKey: input.idempotencyKey,
      }
      await this.deps.store.put(job)
      this.live.set(job.jobId, job)
      this.lastPersistedAt.set(job.jobId, now)
      this.deps.emitChanged(job.jobId, job.state)
      await this.pruneOwner(job.ownerUserId)
      return { jobId: job.jobId }
    })
  }

  update(input: JobUpdateInput): Promise<{ updated: boolean }> {
    return this.exclusive(async () => {
      const current = await this.load(input.jobId)
      if (current === null) return { updated: false }
      return { updated: await this.apply(current, input) }
    })
  }

  /**
   * Apply a producer-reported change. Returns `false` when the job is already terminal (it never
   * walks back) or the change moves it backwards.
   */
  private async apply(
    current: StoredJob,
    change: Omit<JobUpdateInput, 'jobId'> & { readonly cancellable?: boolean },
  ): Promise<boolean> {
    if (isTerminalJobState(current.state)) return false
    const now = this.deps.now()
    const nextState = this.forwardState(current.state, change.state)
    const stateChanged = nextState !== current.state
    const terminal = isTerminalJobState(nextState)
    const failure =
      nextState === 'failed'
        ? (change.failure ?? current.failure ?? { reason: 'error' as const, message: 'failed' })
        : (change.failure ?? current.failure)
    const next: StoredJob = {
      ...current,
      state: nextState,
      progress: change.progress === undefined ? current.progress : change.progress,
      failure: nextState === 'failed' ? failure : null,
      cancellable: terminal ? false : (change.cancellable ?? current.cancellable),
      updatedAt: now,
      lastConfirmedAt: now,
      finishedAt: terminal ? now : null,
    }
    if (terminal) {
      this.live.delete(next.jobId)
      this.lastPersistedAt.delete(next.jobId)
      await this.deps.store.put(next)
    } else {
      this.live.set(next.jobId, next)
      const lastPersist = this.lastPersistedAt.get(next.jobId) ?? 0
      if (stateChanged || now - lastPersist >= PROGRESS_PERSIST_MS) {
        this.lastPersistedAt.set(next.jobId, now)
        await this.deps.store.put(next)
      }
    }
    if (stateChanged) this.deps.emitChanged(next.jobId, next.state)
    if (terminal) await this.pruneOwner(next.ownerUserId)
    return true
  }

  /** `queued → running` and any move to a terminal state; nothing walks back. */
  private forwardState(from: JobState, to: JobState | undefined): JobState {
    if (to === undefined || to === 'queued') return from
    return to
  }

  // ── Consumer side ────────────────────────────────────────────────

  async list(
    caller: CapCaller,
    input: {
      readonly states?: readonly JobState[]
      readonly includeDismissed: boolean
      readonly entity?: JobEntityRef
      readonly limit?: number
    },
  ): Promise<Job[]> {
    const visible = await this.visibleJobs(caller)
    const dismissed = input.includeDismissed
      ? new Set<string>()
      : await this.deps.store.dismissedBy(caller.userId)
    const states = input.states
    const entity = input.entity
    const out = visible
      .filter((job) => !dismissed.has(job.jobId))
      .filter((job) => states === undefined || states.includes(job.state))
      .filter((job) => entity === undefined || sameEntity(job, entity))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, input.limit ?? 200)
    this.reconcileStale(out)
    return out.map(toJob)
  }

  async get(caller: CapCaller, jobId: string): Promise<Job | null> {
    const job = await this.load(jobId)
    if (job === null || !canSeeJob(job, caller)) return null
    this.reconcileStale([job])
    return toJob(job)
  }

  async getSummary(caller: CapCaller): Promise<JobSummary> {
    try {
      const visible = await this.visibleJobs(caller)
      const dismissed = await this.deps.store.dismissedBy(caller.userId)
      return {
        running: visible.filter((job) => !isTerminalJobState(job.state)).length,
        unseenFinished: visible.filter(
          (job) => isTerminalJobState(job.state) && !dismissed.has(job.jobId),
        ).length,
      }
    } catch (err) {
      // A measurement that FAILED is null, never 0 (D393).
      this.deps.logger.warn('jobs summary unavailable', { meta: { error: errorMessage(err) } })
      const running = [...this.live.values()].filter((job) => canSeeJob(job, caller)).length
      return { running, unseenFinished: null }
    }
  }

  /** Ask the producer to stop. Nothing is changed here: the producer reports the new state. */
  async cancel(
    caller: CapCaller,
    jobId: string,
  ): Promise<{ accepted: boolean; reason: JobCancelReason | null }> {
    const job = await this.load(jobId)
    if (job === null || !canSeeJob(job, caller)) return { accepted: false, reason: 'not-found' }
    if (isTerminalJobState(job.state)) return { accepted: false, reason: 'terminal' }
    if (!job.cancellable) return { accepted: false, reason: 'not-cancellable' }
    if (!canCancelJob(job, caller)) return { accepted: false, reason: 'not-allowed' }
    try {
      const { accepted } = await this.deps.producers.cancelJob(job.producerAddonId, jobId)
      return accepted
        ? { accepted: true, reason: null }
        : { accepted: false, reason: 'producer-refused' }
    } catch (err) {
      this.deps.logger.warn('job cancel: producer unreachable', {
        meta: { jobId, producerAddonId: job.producerAddonId, error: errorMessage(err) },
      })
      return { accepted: false, reason: 'producer-unreachable' }
    }
  }

  async dismiss(caller: CapCaller, jobId: string): Promise<{ dismissed: boolean }> {
    const job = await this.load(jobId)
    if (job === null || !canSeeJob(job, caller)) return { dismissed: false }
    await this.deps.store.dismiss(jobId, caller.userId, this.deps.now())
    return { dismissed: true }
  }

  async collect(caller: CapCaller, jobId: string): Promise<JobResult | null> {
    const job = await this.load(jobId)
    if (job === null || !canSeeJob(job, caller) || job.state !== 'done') return null
    try {
      return await this.deps.producers.resolveResult(job.producerAddonId, jobId)
    } catch (err) {
      this.deps.logger.warn('job collect: producer unreachable', {
        meta: { jobId, producerAddonId: job.producerAddonId, error: errorMessage(err) },
      })
      return null
    }
  }

  // ── Reconcile ────────────────────────────────────────────────────

  /**
   * Compare the live jobs of a producer with what the producer says now. Called when the
   * producer registers (a restart wiped its RAM) and when a read sees a stale job.
   */
  async reconcileProducer(producerAddonId: string): Promise<void> {
    if (this.reconciling.has(producerAddonId)) return
    this.reconciling.add(producerAddonId)
    try {
      await this.reconcileOnce(producerAddonId)
    } finally {
      this.reconciling.delete(producerAddonId)
    }
  }

  /** Reconcile every producer that has an open job (a `job-source` provider became ready). */
  async reconcileAll(): Promise<void> {
    const producers = new Set((await this.openJobs()).map((job) => job.producerAddonId))
    for (const producerAddonId of producers) await this.reconcileProducer(producerAddonId)
  }

  private async reconcileOnce(producerAddonId: string): Promise<void> {
    const cutoff = this.deps.now() - RECONCILE_GRACE_MS
    const candidates = (await this.openJobs()).filter(
      (job) => job.producerAddonId === producerAddonId && job.lastConfirmedAt <= cutoff,
    )
    if (candidates.length === 0) return
    const first = await this.readProducer(
      producerAddonId,
      candidates.map((j) => j.jobId),
    )
    if (first === null) return
    const unknown: string[] = []
    for (const entry of first) {
      if ('snapshot' in entry) await this.applySnapshot(entry.jobId, entry.snapshot)
      else unknown.push(entry.jobId)
    }
    if (unknown.length === 0) return
    // D49: a read that would mark work lost is confirmed by a second read.
    const second = await this.readProducer(producerAddonId, unknown)
    if (second === null) return
    for (const entry of second) {
      if ('snapshot' in entry) await this.applySnapshot(entry.jobId, entry.snapshot)
      else await this.markInterrupted(entry.jobId)
    }
  }

  private async readProducer(
    producerAddonId: string,
    jobIds: readonly string[],
  ): Promise<readonly JobSourceEntry[] | null> {
    try {
      return await this.deps.producers.getJobs(producerAddonId, jobIds)
    } catch (err) {
      this.deps.logger.warn('job reconcile: producer unreadable, nothing changed', {
        meta: { producerAddonId, jobCount: jobIds.length, error: errorMessage(err) },
      })
      return null
    }
  }

  private applySnapshot(jobId: string, snapshot: JobSnapshot): Promise<void> {
    return this.exclusive(async () => {
      const current = await this.load(jobId)
      if (current === null) return
      await this.apply(current, {
        state: snapshot.state,
        progress: snapshot.progress,
        failure: snapshot.failure,
        cancellable: snapshot.cancellable,
      })
    })
  }

  private markInterrupted(jobId: string): Promise<void> {
    return this.exclusive(async () => {
      const current = await this.load(jobId)
      if (current === null || isTerminalJobState(current.state)) return
      await this.apply(current, {
        state: 'failed',
        failure: {
          reason: 'interrupted',
          message: 'The producer no longer knows this job; it was probably restarted.',
        },
      })
      this.deps.logger.warn('job marked interrupted after two reads', {
        meta: { jobId, producerAddonId: current.producerAddonId },
      })
    })
  }

  private reconcileStale(jobs: readonly StoredJob[]): void {
    const cutoff = this.deps.now() - STALE_CONFIRMATION_MS
    const producers = new Set(
      jobs
        .filter((job) => !isTerminalJobState(job.state) && job.lastConfirmedAt <= cutoff)
        .map((job) => job.producerAddonId),
    )
    for (const producerAddonId of producers) {
      void this.reconcileProducer(producerAddonId).catch((err: unknown) => {
        this.deps.logger.warn('job reconcile failed', {
          meta: { producerAddonId, error: errorMessage(err) },
        })
      })
    }
  }

  // ── Reads ────────────────────────────────────────────────────────

  private async load(jobId: string): Promise<StoredJob | null> {
    return this.live.get(jobId) ?? (await this.deps.store.get(jobId))
  }

  private async findByKey(key: string): Promise<StoredJob | null> {
    for (const job of this.live.values()) if (job.idempotencyKey === key) return job
    return this.deps.store.findByIdempotencyKey(key)
  }

  /** The ledger overlaid with the live (fresher) copies. */
  private async allJobs(): Promise<readonly StoredJob[]> {
    const rows = await this.deps.store.all()
    return rows.map((row) => this.live.get(row.jobId) ?? row)
  }

  private async openJobs(): Promise<readonly StoredJob[]> {
    return (await this.allJobs()).filter((job) => !isTerminalJobState(job.state))
  }

  private async visibleJobs(caller: CapCaller): Promise<StoredJob[]> {
    return (await this.allJobs()).filter((job) => canSeeJob(job, caller))
  }

  private async pruneOwner(ownerUserId: string): Promise<void> {
    try {
      const mine = (await this.allJobs()).filter((job) => job.ownerUserId === ownerUserId)
      const doomed = selectJobsToPrune(mine, this.deps.now(), this.deps.retention())
      await this.deps.store.deleteJobs(doomed)
    } catch (err) {
      this.deps.logger.warn('job retention prune failed', {
        meta: { ownerUserId, error: errorMessage(err) },
      })
    }
  }
}

function toJob(stored: StoredJob): Job {
  const { idempotencyKey: _key, ...job } = stored
  return job
}
