/**
 * face-rescore-scheduler — the hourly, change-gated whole-archive rescore (D866).
 *
 * Supersedes the "no background job" line the `face-rescore.ts` header used to
 * carry. That line argued against re-scoring every buffered face on EVERY
 * assign. This is not that: it runs on a slow cadence, and only when a
 * fingerprint of the two things a suggestion depends on — the gallery and the
 * set of unassigned faces — differs from the one the last completed run saw.
 * An unchanged archive costs one gallery manifest read and one aggregate.
 *
 * ## Rules
 *
 * - The interval is re-read from the orchestrator's global settings on EVERY
 *   tick (`0` = off, otherwise at least 10 minutes), so changing it needs no
 *   restart. A read that fails skips the tick; it never guesses an interval.
 * - NOT a boot purge: the clock starts when the scheduler is constructed, so
 *   the first run is one interval after start.
 * - The job is the SAME single-flight job the manual action starts: a tick
 *   that finds one running does nothing, and a manual call during a scheduled
 *   run gets the running job back.
 * - Completed runs (manual ones included) record their fingerprint, which is
 *   what lets the next tick say "unchanged" after an operator's run.
 */
import type { IScopedLogger } from '@camstack/types'
import {
  type FaceRescoreJob,
  type FaceRescorePorts,
  readRescoreFingerprint,
} from './face-rescore-job.js'
import type { FaceRescoreStatePort } from './store/face-rescore-state-store.js'

export const FACE_RESCORE_TICK_MS = 60_000

export type FaceRescoreTickOutcome =
  | 'disabled'
  | 'setting-unreadable'
  | 'not-due'
  | 'busy'
  | 'unreadable'
  | 'unchanged'
  | 'ran'
  | 'failed'

export interface FaceRescoreSchedulerDeps {
  /** Minutes from the orchestrator setting; `null` when it could not be read. */
  readonly readIntervalMinutes: () => Promise<number | null>
  readonly job: Pick<FaceRescoreJob, 'start' | 'whenSettled' | 'status' | 'isRunning'>
  readonly fingerprintPorts: Pick<
    FaceRescorePorts,
    'resolveClusterModelId' | 'galleryManifest' | 'pendingMarker'
  >
  readonly state: Pick<FaceRescoreStatePort, 'load'>
  readonly now: () => number
  readonly logger: Pick<IScopedLogger, 'info' | 'warn' | 'debug'>
}

export class FaceRescoreScheduler {
  private lastCheckAt: number
  private ticking = false

  constructor(
    private readonly deps: FaceRescoreSchedulerDeps,
    startedAt: number,
  ) {
    this.lastCheckAt = startedAt
  }

  async tick(): Promise<FaceRescoreTickOutcome> {
    if (this.ticking) return 'busy'
    this.ticking = true
    try {
      return await this.decideAndRun()
    } finally {
      this.ticking = false
    }
  }

  private async decideAndRun(): Promise<FaceRescoreTickOutcome> {
    const minutes = await this.readInterval()
    if (minutes === null) return 'setting-unreadable'
    if (minutes === 0) return 'disabled'
    const now = this.deps.now()
    if (now - this.lastCheckAt < minutes * 60_000) return 'not-due'
    this.lastCheckAt = now
    if (this.deps.job.isRunning()) return 'busy'

    const observed = await this.observe()
    if (observed === null) return 'unreadable'
    const previous = await this.deps.state.load()
    if (previous !== null && previous.fingerprint === observed) {
      this.deps.logger.info('face rescore skipped, unchanged', {
        meta: { fingerprint: observed, lastRunAt: previous.finishedAt },
      })
      return 'unchanged'
    }
    this.deps.job.start()
    await this.deps.job.whenSettled()
    return this.deps.job.status().state === 'completed' ? 'ran' : 'failed'
  }

  private async readInterval(): Promise<number | null> {
    try {
      return await this.deps.readIntervalMinutes()
    } catch (err) {
      this.deps.logger.warn('face rescore interval unreadable — tick skipped', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }

  private async observe(): Promise<string | null> {
    try {
      const seen = await readRescoreFingerprint(this.deps.fingerprintPorts)
      if (seen === null) {
        this.deps.logger.warn('face rescore tick skipped — cluster face model unresolved')
        return null
      }
      return seen.fingerprint.combined
    } catch (err) {
      this.deps.logger.warn('face rescore fingerprint unreadable — tick skipped', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
      return null
    }
  }
}
