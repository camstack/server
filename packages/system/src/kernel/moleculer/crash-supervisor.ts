/**
 * Per-runner crash circuit-breaker.
 *
 * Replaces the old infinite-respawn loop in `process-service.ts`'s
 * `spawnRunner` exit handler. A runner that exits unexpectedly is
 * respawned with exponential backoff while the crash count inside a
 * sliding time window stays under `maxCrashes`. Once the window fills
 * up the breaker trips: respawning STOPS and the caller marks the
 * addon `failed`.
 *
 * State is per-runner (keyed on `runnerId`) and crash timestamps older
 * than `windowMs` age out — a runner that crashed once an hour ago and
 * then crashes again starts a fresh streak.
 */

/** Tunables for `CrashSupervisor`. */
export interface CrashSupervisorOptions {
  /** CRASH_WINDOW_MS — crashes older than this age out of the count. */
  readonly windowMs: number
  /** Crashes within the window before the breaker trips to `failed`. */
  readonly maxCrashes: number
  /** Backoff cap — the exponential backoff never exceeds this. */
  readonly maxBackoffMs: number
}

/**
 * Outcome of recording a crash. Discriminated on `action`:
 *   - `respawn` — under the threshold, schedule another spawn after `backoffMs`.
 *   - `failed`  — breaker tripped, do NOT respawn; mark the addon `failed`.
 */
export type CrashDecision =
  | { readonly action: 'respawn'; readonly backoffMs: number; readonly crashesInWindow: number }
  | { readonly action: 'failed'; readonly crashesInWindow: number }

/** Per-runner crash circuit-breaker. Replaces the old infinite-respawn loop. */
export class CrashSupervisor {
  /** runnerId → crash timestamps (ms epoch), pruned to the active window. */
  private readonly crashes = new Map<string, number[]>()

  constructor(private readonly opts: CrashSupervisorOptions) {}

  /**
   * Record a crash for `runnerId` and decide what to do. `now` is
   * injectable for deterministic tests; production calls omit it.
   */
  recordCrash(runnerId: string, now: number = Date.now()): CrashDecision {
    const cutoff = now - this.opts.windowMs
    const recent = (this.crashes.get(runnerId) ?? []).filter((t) => t >= cutoff)
    recent.push(now)
    this.crashes.set(runnerId, recent)

    if (recent.length >= this.opts.maxCrashes) {
      return { action: 'failed', crashesInWindow: recent.length }
    }

    const streak = recent.length
    const backoffMs = Math.min(this.opts.maxBackoffMs, 500 * 2 ** Math.min(6, streak - 1))
    return { action: 'respawn', backoffMs, crashesInWindow: streak }
  }

  /** Clear crash history after a clean run / manual restart. */
  reset(runnerId: string): void {
    this.crashes.delete(runnerId)
  }
}
