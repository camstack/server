import type {
  LedgerWalkInput,
  LedgerWalkReport,
  StorageCleanupInput,
  StorageCleanupJob,
  StorageCleanupPhase,
  StorageLocation,
} from '@camstack/types'
import { evictionPolicyOfLocation } from '@camstack/types'
import type { StorageOrchestratorService } from './storage-orchestrator.service.js'

const FOOTAGE_TYPES = new Set(['recordings', 'recordingsLow'])

export interface CleanupJobState {
  get(): Promise<StorageCleanupJob | null>
  set(value: StorageCleanupJob | null): Promise<void>
}

export interface OrphanAuditStart {
  readonly started: boolean
  readonly alreadyRunning: boolean
}

export interface OrphanAuditStatus {
  readonly running: boolean
  readonly complete: boolean | null
  readonly totalReclaimed: number
  readonly totalBytesReclaimed: number
  readonly error: string | null
}

export interface DebugMediaStart {
  readonly started: boolean
  readonly alreadyRunning: boolean
}

export interface DebugMediaStatus {
  readonly running: boolean
  readonly totalReclaimed: number
  readonly totalBytesReclaimed: number
  readonly error: string | null
}

export interface StorageCleanupParticipants {
  startOrphan(restart: boolean): Promise<OrphanAuditStart>
  orphanStatus(): Promise<OrphanAuditStatus>
  startDebugMedia(): Promise<DebugMediaStart>
  debugMediaStatus(): Promise<DebugMediaStatus>
  walkLedger(input: LedgerWalkInput): Promise<LedgerWalkReport>
}

export interface StorageCleanupCoordinatorDeps {
  readonly locations: StorageOrchestratorService
  readonly state: CleanupJobState
  readonly participants: StorageCleanupParticipants
  readonly now: () => number
  readonly newId: () => string
  readonly sleep?: (ms: number) => Promise<void>
  readonly pollMs?: number
}

function isTerminal(job: StorageCleanupJob): boolean {
  return job.phase === 'done' || job.phase === 'failed' || job.phase === 'cancelled'
}

/**
 * A location whose footage the system will not remove on its own — eviction
 * policy `never` (D385): `readonly` and `disabled`. NOT `drain`, which is
 * shrinking on purpose and whose leftovers the ratchet is already removing.
 */
function footageFrozen(location: StorageLocation): boolean {
  return evictionPolicyOfLocation(location) === 'never'
}

/**
 * One operator-facing cleanup of leftover analytics rows/blobs, optional
 * debug media, and ghost ledger rows on frozen footage locations.
 *
 * Each addon call either returns immediately (start+poll) or is a bounded
 * ledger walk. The HTTP caller never waits on the full pass.
 */
export class StorageCleanupCoordinator {
  private active: StorageCleanupJob | null = null
  private startReserved = false

  constructor(private readonly deps: StorageCleanupCoordinatorDeps) {}

  async start(input: StorageCleanupInput): Promise<string> {
    if (this.startReserved) throw new Error('storage cleanup is already active')
    this.startReserved = true
    try {
      const existing = await this.status()
      if (existing && !isTerminal(existing)) {
        throw new Error(`storage cleanup is already active (${existing.jobId})`)
      }
      const now = this.deps.now()
      const job: StorageCleanupJob = {
        jobId: this.deps.newId(),
        phase: 'orphans',
        includeDebugMedia: input.includeDebugMedia === true,
        orphansReclaimed: 0,
        orphanBytesReclaimed: 0,
        debugMediaReclaimed: 0,
        debugMediaBytesReclaimed: 0,
        ghostsForgotten: 0,
        ghostBytesForgotten: 0,
        detail: 'Starting orphan reclaim',
        cancelRequested: false,
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
        error: null,
      }
      await this.persist(job)
      this.active = job
      void this.run(job)
      return job.jobId
    } finally {
      this.startReserved = false
    }
  }

  async status(jobId?: string): Promise<StorageCleanupJob | null> {
    const job = this.active ?? (await this.deps.state.get())
    if (jobId !== undefined && job?.jobId !== jobId) return null
    return job
  }

  async cancel(jobId: string): Promise<boolean> {
    const job = await this.status(jobId)
    if (!job || isTerminal(job)) return false
    job.cancelRequested = true
    job.detail = 'Cancel requested — finishing the current step'
    await this.persist(job)
    return true
  }

  private async run(job: StorageCleanupJob): Promise<void> {
    try {
      await this.reclaimOrphans(job)
      if (await this.stopped(job)) return
      if (job.includeDebugMedia) {
        await this.setPhase(job, 'debug-media', 'Reclaiming debug media')
        await this.reclaimDebugMedia(job)
        if (await this.stopped(job)) return
      }
      await this.setPhase(job, 'ghost-ledger', 'Forgetting ghost footage rows')
      await this.forgetGhosts(job)
      if (await this.stopped(job)) return
      await this.finish(job, 'done', null)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.finish(job, 'failed', message)
    }
  }

  private async reclaimOrphans(job: StorageCleanupJob): Promise<void> {
    let restart = true
    for (;;) {
      if (await this.stopped(job)) return
      const start = await this.deps.participants.startOrphan(restart)
      restart = false
      if (!start.started && !start.alreadyRunning) {
        throw new Error('orphan reclaim did not start')
      }
      const status = await this.waitUntilIdle(
        () => this.deps.participants.orphanStatus(),
        job,
        (s) => `Orphan reclaim: ${s.totalReclaimed} rows / ${String(s.totalBytesReclaimed)} bytes`,
      )
      job.orphansReclaimed += status.totalReclaimed
      job.orphanBytesReclaimed += status.totalBytesReclaimed
      job.detail = `Orphans: ${job.orphansReclaimed} rows, ${String(job.orphanBytesReclaimed)} bytes`
      await this.persist(job)
      if (status.error) throw new Error(status.error)
      if (status.complete === true) return
    }
  }

  private async reclaimDebugMedia(job: StorageCleanupJob): Promise<void> {
    const start = await this.deps.participants.startDebugMedia()
    if (!start.started && !start.alreadyRunning) {
      throw new Error('debug-media reclaim did not start')
    }
    const status = await this.waitUntilIdle(
      () => this.deps.participants.debugMediaStatus(),
      job,
      (s) => `Debug media: ${s.totalReclaimed} files`,
    )
    job.debugMediaReclaimed = status.totalReclaimed
    job.debugMediaBytesReclaimed = status.totalBytesReclaimed
    await this.persist(job)
    if (status.error) throw new Error(status.error)
  }

  private async forgetGhosts(job: StorageCleanupJob): Promise<void> {
    const frozen = this.deps.locations
      .listLocations()
      .filter((l) => FOOTAGE_TYPES.has(l.type) && footageFrozen(l))
    if (frozen.length === 0) {
      job.detail = 'No frozen footage locations'
      await this.persist(job)
      return
    }
    for (const loc of frozen) {
      if (await this.stopped(job)) return
      job.detail = `Ghost ledger: ${loc.id}`
      await this.persist(job)
      const report = await this.deps.participants.walkLedger({
        locationId: loc.id,
        apply: true,
      })
      job.ghostsForgotten += report.forgottenSegments
      job.ghostBytesForgotten += report.forgottenBytes
      await this.persist(job)
    }
  }

  private async waitUntilIdle<T extends { running: boolean }>(
    read: () => Promise<T>,
    job: StorageCleanupJob,
    detail: (status: T) => string,
  ): Promise<T> {
    const pollMs = this.deps.pollMs ?? 2_000
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
    for (;;) {
      const status = await read()
      job.detail = detail(status)
      await this.persist(job)
      if (!status.running) return status
      await sleep(pollMs)
    }
  }

  private async stopped(job: StorageCleanupJob): Promise<boolean> {
    const latest = await this.status(job.jobId)
    if (latest?.cancelRequested === true) {
      await this.finish(job, 'cancelled', null)
      return true
    }
    return false
  }

  private async setPhase(
    job: StorageCleanupJob,
    phase: StorageCleanupPhase,
    detail: string,
  ): Promise<void> {
    job.phase = phase
    job.detail = detail
    await this.persist(job)
  }

  private async finish(
    job: StorageCleanupJob,
    phase: 'done' | 'failed' | 'cancelled',
    error: string | null,
  ): Promise<void> {
    job.phase = phase
    job.error = error
    job.finishedAt = this.deps.now()
    job.detail = phase === 'done' ? 'Cleanup finished' : job.detail
    await this.persist(job)
  }

  private async persist(job: StorageCleanupJob): Promise<void> {
    job.updatedAt = this.deps.now()
    this.active = job
    await this.deps.state.set(job)
  }
}
