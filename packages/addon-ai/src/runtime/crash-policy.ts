/**
 * Per-runtime crash circuit-breaker — copied verbatim from
 * `@camstack/system/src/kernel/moleculer/crash-supervisor.ts` (the class is NOT
 * re-exported from the package index, so the ~60-line discipline is duplicated
 * here per the plan). Respawn with exponential backoff while the crash count in
 * a sliding window stays under `maxCrashes`; once the window fills the breaker
 * trips and the runtime is marked terminally `failed` — never an infinite loop
 * (the D6 invariant).
 */

export interface CrashPolicyOptions {
  /** Crashes older than this age out of the count. */
  readonly windowMs: number
  /** Crashes within the window before the breaker trips to `failed`. */
  readonly maxCrashes: number
  /** Backoff cap — the exponential backoff never exceeds this. */
  readonly maxBackoffMs: number
}

export type CrashDecision =
  | { readonly action: 'respawn'; readonly backoffMs: number; readonly crashesInWindow: number }
  | { readonly action: 'failed'; readonly crashesInWindow: number }

export class CrashPolicy {
  private readonly crashes = new Map<string, number[]>()

  constructor(private readonly opts: CrashPolicyOptions) {}

  recordCrash(id: string, now: number = Date.now()): CrashDecision {
    const cutoff = now - this.opts.windowMs
    const recent = (this.crashes.get(id) ?? []).filter((t) => t >= cutoff)
    recent.push(now)
    this.crashes.set(id, recent)

    if (recent.length >= this.opts.maxCrashes) {
      return { action: 'failed', crashesInWindow: recent.length }
    }

    const streak = recent.length
    const backoffMs = Math.min(this.opts.maxBackoffMs, 500 * 2 ** Math.min(6, streak - 1))
    return { action: 'respawn', backoffMs, crashesInWindow: streak }
  }

  crashesInWindow(id: string, now: number = Date.now()): number {
    const cutoff = now - this.opts.windowMs
    return (this.crashes.get(id) ?? []).filter((t) => t >= cutoff).length
  }

  reset(id: string): void {
    this.crashes.delete(id)
  }
}

export const DEFAULT_CRASH_POLICY: CrashPolicyOptions = {
  windowMs: 300_000,
  maxCrashes: 5,
  maxBackoffMs: 30_000,
}
