/**
 * Yield the event loop, and yield HARDER when something else is waiting for it.
 *
 * WHY THIS EXISTS
 * ───────────────
 * A background pass over stored media (the D148 staging recovery: 123 000
 * segments, 179 GB) is defined as work that must never cost the live write
 * path. A fixed `setImmediate` between chunks does not deliver that: it hands
 * the loop back exactly once per chunk regardless of how deep the queue behind
 * it is, so under contention the recovery keeps its share and the things that
 * matter — a SegmentWriter's finalize, a cap UDS request — wait behind it. On
 * 2026-08-14 that showed as 896 "camera function authority TIMED OUT" warnings
 * in three hours and four cameras' segments failing to land inside 30 s, while
 * the recovery ran at full tilt.
 *
 * The pacer measures what a zero-delay hop ACTUALLY cost. A hop that returns
 * promptly means nothing else wanted the loop; one that takes tens of
 * milliseconds means the queue behind it was deep, and the honest response is
 * to stand further back — sleep proportionally, bounded, until it clears. That
 * is a signal the pass already has, needs no coupling to the cap layer, and
 * degrades to "a plain macrotask hop" on an idle node.
 */

export interface LoopPacerDeps {
  /** Monotonic-ish clock in ms. */
  readonly now: () => number
  /** Hand the loop back for at least `ms`. */
  readonly sleep: (ms: number) => Promise<void>
  /**
   * Observed hop cost at or above which the loop counts as CONTENDED. A hop
   * costs well under a millisecond on an idle loop; tens of ms means real work
   * queued behind it.
   */
  readonly busyLagMs?: number
  /** Sleep granted per contended hop, multiplied by consecutive contention. */
  readonly backoffStepMs?: number
  /** Ceiling on one back-off sleep, so a permanently busy node still drains. */
  readonly maxBackoffMs?: number
}

const DEFAULT_BUSY_LAG_MS = 25
const DEFAULT_BACKOFF_STEP_MS = 25
const DEFAULT_MAX_BACKOFF_MS = 250

/** What the pacer observed, for the pass to report at the end. */
export interface LoopPacerStats {
  readonly hops: number
  readonly contendedHops: number
  readonly pausedMs: number
  readonly maxLagMs: number
}

export class LoopPacer {
  private consecutive = 0
  private hops = 0
  private contendedHops = 0
  private pausedMs = 0
  private maxLagMs = 0

  constructor(private readonly deps: LoopPacerDeps) {}

  /**
   * One paced yield. Always hands the loop back at least once; sleeps longer
   * while the previous hop shows the loop is contended, and forgets the
   * back-off as soon as one hop comes back clean.
   */
  async hop(): Promise<void> {
    const busyLagMs = this.deps.busyLagMs ?? DEFAULT_BUSY_LAG_MS
    const stepMs = this.deps.backoffStepMs ?? DEFAULT_BACKOFF_STEP_MS
    const maxMs = this.deps.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS

    const before = this.deps.now()
    await this.deps.sleep(0)
    const lagMs = this.deps.now() - before
    this.hops += 1
    if (lagMs > this.maxLagMs) this.maxLagMs = lagMs

    if (lagMs < busyLagMs) {
      this.consecutive = 0
      return
    }
    this.consecutive += 1
    this.contendedHops += 1
    const pauseMs = Math.min(stepMs * this.consecutive, maxMs)
    this.pausedMs += pauseMs
    await this.deps.sleep(pauseMs)
  }

  stats(): LoopPacerStats {
    return {
      hops: this.hops,
      contendedHops: this.contendedHops,
      pausedMs: this.pausedMs,
      maxLagMs: this.maxLagMs,
    }
  }
}

/** The production pacer: real clock, real timers. */
export function nodeLoopPacer(): LoopPacer {
  return new LoopPacer({
    now: () => Date.now(),
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms)
      }),
  })
}
