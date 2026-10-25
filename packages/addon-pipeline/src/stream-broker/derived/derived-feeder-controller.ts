/**
 * DerivedFeederController — the on-demand lifecycle owner for ONE derived
 * stream's transcode feeder.
 *
 * A derived stream's `derived:*` broker is a push broker: it produces nothing
 * on its own. This controller spawns the {@link DerivedStreamFeeder} (ffmpeg
 * transcode of the source loopback → the broker's push ingress) the instant the
 * derived broker gains demand, and tears it down (releasing the source
 * loopback) when the broker idles — so an unwatched derived never pins its
 * source camera. It mirrors the recorder `SegmentWriter`'s bounded-restart /
 * give-up policy: a feeder that keeps dying rapidly stops respawning, while a
 * healthy run resets the counter so a transient blip never permanently stops a
 * derived stream.
 *
 * The controller is transport-agnostic: it knows nothing about brokers,
 * getStreamWithCodec, or RTSP restream URLs — the caller injects a single
 * `spawn` that resolves the source loopback, builds the argv, connects a
 * feeder, and returns the started feeder plus a `release` for its source
 * refcount. That keeps this a small, deterministic, unit-testable seam.
 */

import type { IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import type { DerivedStreamFeeder } from './derived-stream-feeder.js'

/** A started feeder plus the cleanup that releases its source loopback. */
export interface ActiveDerivedFeeder {
  readonly feeder: DerivedStreamFeeder
  /** Release the source refcount (getStreamWithCodec pipeline). No-op for a raw camStream restream. */
  readonly release: () => Promise<void>
}

/** Injectable timer so tests drive backoff deterministically. */
export interface RestartTimer {
  readonly cancel: () => void
}

export interface DerivedFeederControllerDeps {
  readonly logger: IScopedLogger
  /**
   * Resolve the source loopback, build the transcode argv, connect a feeder and
   * return it. `onTeardown` MUST be invoked exactly once when the feeder's child
   * exits (wire it to the feeder's `onTeardown` callback) so the controller can
   * apply its restart policy. Rejects when the source loopback is unavailable.
   */
  readonly spawn: (onTeardown: () => void) => Promise<ActiveDerivedFeeder>
  /** Injectable scheduler (defaults to `setTimeout`) — tests supply a fake. */
  readonly scheduleRestart?: (fn: () => void, delayMs: number) => RestartTimer
}

/** Max CONSECUTIVE rapid restarts before giving up (reset by a stable run). */
const MAX_RESTARTS = 10
/** Restart backoff: base delay, doubled per consecutive attempt, capped. */
const RESTART_BASE_MS = 500
const RESTART_MAX_MS = 10_000
/** A feeder that ran at least this long is "stable" → reset the restart count. */
const STABLE_RUN_MS = 30_000

function defaultScheduleRestart(fn: () => void, delayMs: number): RestartTimer {
  const timer = setTimeout(fn, delayMs)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

export class DerivedFeederController {
  private demand = false
  private starting = false
  private stopped = false
  private current: ActiveDerivedFeeder | null = null
  private restarts = 0
  private restartTimer: RestartTimer | null = null
  private startedAt = 0
  private readonly schedule: (fn: () => void, delayMs: number) => RestartTimer

  constructor(private readonly deps: DerivedFeederControllerDeps) {
    this.schedule = deps.scheduleRestart ?? defaultScheduleRestart
  }

  /** Broker demand transition. `true` → ensure a feeder runs; `false` → tear it down. */
  onDemand(active: boolean): void {
    if (this.stopped) return
    this.demand = active
    if (active) {
      void this.ensureRunning()
    } else {
      this.teardownCurrent()
    }
  }

  /** Permanent teardown — feeder killed, source released, no further restart. */
  destroy(): void {
    this.stopped = true
    this.demand = false
    this.teardownCurrent()
  }

  private cancelRestartTimer(): void {
    if (this.restartTimer) {
      this.restartTimer.cancel()
      this.restartTimer = null
    }
  }

  private teardownCurrent(): void {
    this.cancelRestartTimer()
    const active = this.current
    this.current = null
    this.restarts = 0
    if (!active) return
    active.feeder.destroy()
    void active.release().catch((err) => {
      this.deps.logger.warn('derived feeder source release failed', {
        meta: { error: errMsg(err) },
      })
    })
  }

  private async ensureRunning(): Promise<void> {
    if (this.stopped || !this.demand || this.starting || this.current) return
    this.cancelRestartTimer()
    this.starting = true
    try {
      const active = await this.deps.spawn(() => this.handleTeardown())
      this.startedAt = Date.now()
      // Demand may have dropped (or the controller destroyed) while spawning —
      // discard the just-started feeder rather than leaking it.
      if (this.stopped || !this.demand) {
        active.feeder.destroy()
        void active.release().catch(() => {})
        return
      }
      this.current = active
    } catch (err) {
      this.deps.logger.warn('derived feeder spawn failed', { meta: { error: errMsg(err) } })
      this.scheduleRestart()
    } finally {
      this.starting = false
    }
  }

  /** The running feeder's child exited. Apply the bounded-restart policy. */
  private handleTeardown(): void {
    const active = this.current
    this.current = null
    if (active) {
      void active.release().catch(() => {})
    }
    if (this.stopped || !this.demand) return
    // A long, healthy run resets the consecutive-restart counter — only RAPID
    // back-to-back failures count toward giving up.
    if (Date.now() - this.startedAt >= STABLE_RUN_MS) this.restarts = 0
    if (this.restarts >= MAX_RESTARTS) {
      this.deps.logger.warn('derived feeder giving up after max restarts', {
        meta: { restarts: this.restarts },
      })
      return
    }
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    this.cancelRestartTimer()
    this.restarts += 1
    const delayMs = Math.min(RESTART_BASE_MS * 2 ** (this.restarts - 1), RESTART_MAX_MS)
    this.deps.logger.info('derived feeder restarting', {
      meta: { attempt: this.restarts, delayMs },
    })
    this.restartTimer = this.schedule(() => {
      this.restartTimer = null
      void this.ensureRunning()
    }, delayMs)
  }
}
