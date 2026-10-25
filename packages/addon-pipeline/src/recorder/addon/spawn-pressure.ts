/**
 * The recorder's answer to "the host cannot fork right now": do LESS AT ONCE,
 * then go back to normal.
 *
 * ── Why this is not "attach one at a time" ────────────────────────────────
 * On 2026-08-18 three cameras were unplugged, every writer for them re-dialled
 * at the same moment, and `spawn ffmpeg` failed with EAGAIN. The obvious
 * reaction — serialise the attaches — is the one this repo has already
 * measured and rejected: ("overlap boot attach so one unpublished
 * camera cannot stall the fleet") exists because a serial `for await` let ONE
 * camera whose `high` profile was unpublished block every other writer for
 * tens of seconds; the first pin landed at t0+223 s.
 *
 * So the bound stays bounded-parallel and simply MOVES. Pressure halves it
 * (floor 1); a quiet interval steps it back up, one lane at a time, until it
 * is back at the bound the fleet is sized for. Both directions are logged:
 * a fleet quietly running at concurrency 1 looks exactly like a fleet that is
 * merely slow.
 *
 * Deliberately time-based and injectable rather than clever: the only input is
 * "a spawn failed transiently", and the only output is an integer read at the
 * top of each drain.
 */
import type { IScopedLogger } from '@camstack/types'

/** Quiet time that buys back ONE lane. */
export const PRESSURE_RECOVERY_MS = 30_000

export interface SpawnPressureGovernorDeps {
  /** The bound in the absence of pressure — the fleet's normal parallelism. */
  readonly maxConcurrency: number
  /** Never shrink past this. One is still progress; zero is a stall. */
  readonly minConcurrency?: number
  /** Quiet time per recovered lane. Default {@link PRESSURE_RECOVERY_MS}. */
  readonly recoverAfterMs?: number
  readonly now?: () => number
  readonly logger?: IScopedLogger
}

/** Adaptive bound for the recorder's attach parallelism. */
export class SpawnPressureGovernor {
  private limit: number
  private readonly min: number
  private readonly recoverAfterMs: number
  /** When the limit last MOVED — the clock both directions are measured from. */
  private lastChangeAt: number
  private underPressure = false

  constructor(private readonly deps: SpawnPressureGovernorDeps) {
    this.min = Math.max(1, deps.minConcurrency ?? 1)
    this.limit = Math.max(this.min, deps.maxConcurrency)
    this.recoverAfterMs = deps.recoverAfterMs ?? PRESSURE_RECOVERY_MS
    this.lastChangeAt = this.now()
  }

  /**
   * How many attaches may overlap right now.
   *
   * Reading is what drives recovery: there is no timer to leak, no interval to
   * lose to a runner respawn, and a recorder that stops attaching entirely
   * simply keeps its reduced bound until it tries again — which is correct.
   */
  get concurrency(): number {
    const max = Math.max(this.min, this.deps.maxConcurrency)
    if (this.limit >= max) return max
    const now = this.now()
    const elapsed = now - this.lastChangeAt
    if (elapsed < this.recoverAfterMs) return this.limit
    // One lane per elapsed WINDOW, not per read: a recorder with nothing to
    // attach reads this rarely, and recovery must not depend on how often it
    // is asked. `lastChangeAt` advances by the windows consumed so the
    // remainder still counts toward the next lane.
    const lanes = Math.floor(elapsed / this.recoverAfterMs)
    this.limit = Math.min(max, this.limit + lanes)
    this.lastChangeAt += lanes * this.recoverAfterMs
    if (this.limit >= max && this.underPressure) {
      this.underPressure = false
      this.deps.logger?.info('recorder: spawn pressure cleared — attach concurrency restored', {
        meta: { concurrency: this.limit },
      })
    } else {
      this.deps.logger?.info('recorder: recovering attach concurrency', {
        meta: { concurrency: this.limit, max },
      })
    }
    return this.limit
  }

  /**
   * A transient spawn failure happened on `deviceId`'s writer.
   *
   * Halves the CURRENT limit, not the max: two waves of pressure inside one
   * recovery window must compound, or a host under sustained load is asked for
   * the same too-large batch over and over.
   */
  report(deviceId: number): void {
    const before = this.limit
    this.limit = Math.max(this.min, Math.floor(this.limit / 2))
    this.lastChangeAt = this.now()
    this.underPressure = true
    // A bound that moves without saying so is indistinguishable from a slow
    // fleet — and this one moves in response to an outage-shaped signal.
    this.deps.logger?.warn('recorder: spawn pressure — reducing attach concurrency', {
      tags: { deviceId },
      meta: { from: before, to: this.limit },
    })
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}
