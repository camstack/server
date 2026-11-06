import { randomUUID } from 'node:crypto'
import type { IEventBus, IScopedLogger } from '@camstack/types'
import { EventCategory, errMsg } from '@camstack/types'

/**
 * Kernel-level addon health monitor.
 *
 * Tracks load + initialize + crash failures across the addon population
 * and drives an aggressive auto-retry loop independent of any single
 * addon's logic. Mirrors the spec the operator approved:
 *
 *   - Boot grace: 5 minutes from `start()`. Failures during this window
 *     are silently retried (slow-starting addons must have a chance to
 *     come up before alarming).
 *   - Retry cadence: 60s after first failure, 120s after second, then
 *     300s for every subsequent attempt — never gives up.
 *   - Tick interval: 30s. Faster than the shortest retry interval (60s)
 *     so a scheduled retry never waits more than ~30s past its target.
 *   - Post-grace alerting: emits `AddonLoadFailed` exactly once per
 *     failure-streak; AlertCenter consumes the event to create a
 *     persistent operator-visible alert. Recovery emits
 *     `AddonLoadRecovered` so the alert can dismiss itself.
 *   - In-memory state only. Server restart resets the grace window
 *     (operator's call — they want a clean slate after a manual restart).
 *
 * The monitor never restarts addons itself: it knows nothing about
 * tarball install / dist paths / dependency injection. It calls a
 * caller-injected `retryFn(packageName)` which is the AddonRegistry's
 * existing reload path — the monitor is just the scheduler + alert
 * gate. This keeps the kernel package addon-agnostic.
 *
 * Group-runner / fork crashes: `process-service.ts` already respawns
 * crashed children with exponential backoff. The monitor doesn't
 * duplicate that loop — it only marks the addon `failed` when the
 * crash supervisor reports it (via `recordFailure`) and clears it on
 * `READY:<nodeId>` recovery (via `recordSuccess`). The kernel's
 * spawn handler wires both edges.
 */

export const HEALTH_MONITOR_TICK_MS = 30_000
export const HEALTH_MONITOR_GRACE_PERIOD_MS: number = 5 * 60_000

/**
 * Retry intervals after each failure (capped — never stops).
 *
 * The FIRST interval must not exceed {@link HEALTH_MONITOR_TICK_MS}: retries can
 * only fire on a tick, so anything larger just adds latency on top of a wait the
 * tick already imposes. It used to be 60 s, which meant an addon that failed to
 * load because the boot was still moving files around stayed down for 60–90 s
 * — a schedule that presumed a healthy hub (docs/design/boot-to-usable-camera.md,
 * item E). Pinned by `addon-health-monitor.spec.ts`.
 */
export const HEALTH_MONITOR_RETRY_INTERVALS_MS: readonly number[] = [
  30_000, // one tick after attempt 1 — the boot-transient case
  120_000, // 2 min after attempt 2
  300_000, // 5 min after attempt 3+ (repeating)
] as const

export type AddonHealthPhase = 'pending' | 'healthy' | 'failed'

export interface AddonHealthState {
  readonly packageName: string
  readonly addonId?: string
  phase: AddonHealthPhase
  retryCount: number
  firstFailureAt: number | null
  lastAttemptAt: number | null
  lastError: { readonly message: string; readonly stack?: string } | null
  nextRetryAt: number | null
  /** True once `AddonLoadFailed` has been emitted for the current streak. */
  alertEmitted: boolean
  /** True if a retry attempt is currently in flight. */
  retrying: boolean
}

export interface AddonHealthSnapshot {
  readonly packageName: string
  readonly addonId?: string
  readonly phase: AddonHealthPhase
  readonly retryCount: number
  readonly firstFailureAt: number | null
  readonly lastAttemptAt: number | null
  readonly lastError: { readonly message: string; readonly stack?: string } | null
  readonly nextRetryAt: number | null
  readonly alertEmitted: boolean
  readonly retrying: boolean
  /** Whether the boot grace window is still open (suppresses alerts). */
  readonly inGracePeriod: boolean
}

export interface AddonHealthMonitorOptions {
  readonly eventBus: IEventBus
  readonly logger: IScopedLogger
  /**
   * Called by the monitor's tick loop when a failed package is due
   * for a retry attempt. Should perform the actual reload (tarball
   * extract + addon-loader re-import + initialize). Returns true on
   * success; throws on failure (the monitor records the new error).
   */
  readonly retryFn: (packageName: string) => Promise<void>
  /** Override for tests. Defaults to `HEALTH_MONITOR_TICK_MS`. */
  readonly tickIntervalMs?: number
  /** Override for tests. Defaults to `HEALTH_MONITOR_GRACE_PERIOD_MS`. */
  readonly gracePeriodMs?: number
  /** Override for tests. Defaults to `HEALTH_MONITOR_RETRY_INTERVALS_MS`. */
  readonly retryIntervalsMs?: readonly number[]
  /** Override clock for deterministic tests. */
  readonly now?: () => number
}

export class AddonHealthMonitor {
  private readonly state = new Map<string, AddonHealthState>()
  private readonly bootAt: number
  private readonly tickIntervalMs: number
  private readonly gracePeriodMs: number
  private readonly retryIntervalsMs: readonly number[]
  private readonly eventBus: IEventBus
  private readonly logger: IScopedLogger
  private readonly retryFn: (packageName: string) => Promise<void>
  private readonly now: () => number
  private timer: NodeJS.Timeout | null = null
  private graceEmittedFor = false

  constructor(opts: AddonHealthMonitorOptions) {
    this.eventBus = opts.eventBus
    this.logger = opts.logger
    this.retryFn = opts.retryFn
    this.now = opts.now ?? (() => Date.now())
    this.tickIntervalMs = opts.tickIntervalMs ?? HEALTH_MONITOR_TICK_MS
    this.gracePeriodMs = opts.gracePeriodMs ?? HEALTH_MONITOR_GRACE_PERIOD_MS
    this.retryIntervalsMs = opts.retryIntervalsMs ?? HEALTH_MONITOR_RETRY_INTERVALS_MS
    this.bootAt = this.now()
  }

  /** True while we're still inside the post-boot grace window. */
  inGracePeriod(): boolean {
    return this.now() - this.bootAt < this.gracePeriodMs
  }

  /**
   * Record a successful load/init/recovery for a package. Clears any
   * existing failure state and emits `AddonLoadRecovered` if the
   * package was previously in `failed` state with an alert emitted.
   */
  recordSuccess(packageName: string, addonId?: string): void {
    const existing = this.state.get(packageName)
    const wasAlerting = existing?.phase === 'failed' && existing.alertEmitted

    this.state.set(packageName, {
      packageName,
      addonId: addonId ?? existing?.addonId,
      phase: 'healthy',
      retryCount: 0,
      firstFailureAt: null,
      lastAttemptAt: this.now(),
      lastError: null,
      nextRetryAt: null,
      alertEmitted: false,
      retrying: false,
    })

    if (wasAlerting) {
      this.emit(EventCategory.AddonLoadRecovered, {
        packageName,
        addonId: addonId ?? existing?.addonId,
        retryCount: existing.retryCount,
      })
    }
  }

  /**
   * Record a load/init/crash failure. Schedules the next retry per
   * `retryIntervalsMs` and (post-grace) emits `AddonLoadFailed` if
   * this is the first alert for the current streak.
   */
  recordFailure(packageName: string, err: unknown, addonId?: string): void {
    const existing = this.state.get(packageName)
    const t = this.now()
    const retryCount = (existing?.retryCount ?? 0) + 1
    const intervalIdx = Math.min(retryCount - 1, this.retryIntervalsMs.length - 1)
    const interval = this.retryIntervalsMs[intervalIdx]!
    const nextRetryAt = t + interval

    const errPayload = {
      message: errMsg(err),
      ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
    }

    const next: AddonHealthState = {
      packageName,
      addonId: addonId ?? existing?.addonId,
      phase: 'failed',
      retryCount,
      firstFailureAt: existing?.firstFailureAt ?? t,
      lastAttemptAt: t,
      lastError: errPayload,
      nextRetryAt,
      alertEmitted: existing?.alertEmitted ?? false,
      retrying: false,
    }
    this.state.set(packageName, next)

    // Always log the failure (operator can grep log even during grace).
    this.logger.warn('Addon load/init failure recorded', {
      meta: {
        packageName,
        addonId: addonId ?? existing?.addonId,
        retryCount,
        nextRetryAt,
        inGrace: this.inGracePeriod(),
        error: errPayload.message,
      },
    })

    // Emit retry-scheduled (transient — for live UI countdown).
    this.emit(EventCategory.AddonRetryScheduled, {
      packageName,
      addonId: next.addonId,
      retryCount,
      nextRetryAt,
    })

    // Post-grace: emit `AddonLoadFailed` exactly once per streak.
    // The streak is reset when `recordSuccess` runs (alertEmitted=false).
    if (!this.inGracePeriod() && !next.alertEmitted) {
      next.alertEmitted = true
      this.emit(EventCategory.AddonLoadFailed, {
        packageName,
        addonId: next.addonId,
        error: errPayload,
        retryCount,
        nextRetryAt,
      })
    }
  }

  /**
   * Force an immediate retry attempt for a package, resetting the
   * counter back to 0 (next failure goes to the 60s interval again).
   * Used by the user-facing `addons.retryLoad` tRPC procedure and by
   * the explicit reinstall path.
   */
  async retryNow(packageName: string): Promise<void> {
    const existing = this.state.get(packageName)
    if (!existing) {
      this.logger.warn('retryNow called on unknown package', { meta: { packageName } })
      return
    }
    // Reset counter so the next failure starts from 60s again, then
    // run the retry immediately. recordSuccess/Failure will overwrite
    // the entry as usual.
    this.state.set(packageName, {
      ...existing,
      retryCount: 0,
      retrying: true,
    })
    await this.attemptRetry(packageName)
  }

  /** Snapshot of all tracked packages (read-only, for tRPC list / UI). */
  getHealthSnapshot(): readonly AddonHealthSnapshot[] {
    const inGrace = this.inGracePeriod()
    return [...this.state.values()].map((s) => ({ ...s, inGracePeriod: inGrace }))
  }

  /** Get health for a single package (or null if unknown). */
  getHealth(packageName: string): AddonHealthSnapshot | null {
    const s = this.state.get(packageName)
    if (!s) return null
    return { ...s, inGracePeriod: this.inGracePeriod() }
  }

  /**
   * Drop tracking for a package (used on uninstall — we don't want
   * the monitor to keep retrying a package the user explicitly removed).
   */
  forget(packageName: string): void {
    this.state.delete(packageName)
  }

  /** Begin the retry tick loop. Idempotent. */
  start(): void {
    if (this.timer) return
    // unref so the timer doesn't keep the event loop alive at shutdown
    this.timer = setInterval(() => {
      void this.tick()
    }, this.tickIntervalMs)
    this.timer.unref?.()
    this.logger.info('AddonHealthMonitor started', {
      meta: {
        tickIntervalMs: this.tickIntervalMs,
        gracePeriodMs: this.gracePeriodMs,
        retryIntervalsMs: [...this.retryIntervalsMs],
      },
    })
  }

  /** Stop the retry loop (cleanup on shutdown). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Public for tests. Production callers go through `start()`.
   *
   * Each tick:
   *   1. If grace JUST ended on this tick, emit `AddonLoadFailed` for
   *      every package still in `failed` state that hasn't alerted yet.
   *   2. For every `failed` package whose `nextRetryAt` <= now, run
   *      `retryFn`. On success, recordSuccess; on failure, recordFailure
   *      (which recomputes the next interval).
   */
  async tick(): Promise<void> {
    const t = this.now()

    // Edge: grace just ended → flush deferred alerts.
    if (!this.inGracePeriod() && !this.graceEmittedFor) {
      this.graceEmittedFor = true
      for (const s of this.state.values()) {
        if (s.phase === 'failed' && !s.alertEmitted && s.lastError) {
          s.alertEmitted = true
          this.emit(EventCategory.AddonLoadFailed, {
            packageName: s.packageName,
            addonId: s.addonId,
            error: s.lastError,
            retryCount: s.retryCount,
            nextRetryAt: s.nextRetryAt,
          })
        }
      }
    }

    // Retry due-list. Snapshot keys to avoid mutation-during-iteration.
    const dueList: string[] = []
    for (const s of this.state.values()) {
      if (s.phase === 'failed' && !s.retrying && s.nextRetryAt != null && s.nextRetryAt <= t) {
        dueList.push(s.packageName)
      }
    }
    for (const pkg of dueList) {
      await this.attemptRetry(pkg)
    }
  }

  private async attemptRetry(packageName: string): Promise<void> {
    const existing = this.state.get(packageName)
    if (!existing) return

    existing.retrying = true
    this.emit(EventCategory.AddonRetryAttempting, {
      packageName,
      addonId: existing.addonId,
      retryCount: existing.retryCount,
    })

    try {
      await this.retryFn(packageName)
      // The retryFn is expected to call back into the monitor via
      // recordSuccess/recordFailure with the actual outcome (since
      // it knows whether the addon actually came up). We mark the
      // attempt as complete even if recordSuccess wasn't called —
      // some retryFn implementations may throw on failure instead of
      // calling recordFailure. Handle both shapes:
      const after = this.state.get(packageName)
      if (after && after.retrying) {
        // Implementer didn't call recordSuccess — assume success
        // since we got here without throwing.
        this.recordSuccess(packageName, after.addonId)
      }
    } catch (err) {
      const after = this.state.get(packageName)
      if (after && after.retrying) {
        // Implementer didn't call recordFailure — record it now.
        this.recordFailure(packageName, err, after.addonId)
      }
    }
  }

  private emit(category: EventCategory, data: Record<string, unknown>): void {
    this.eventBus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      category,
      source: { type: 'addon', id: String(data['packageName'] ?? data['addonId'] ?? 'unknown') },
      data,
    })
  }
}
