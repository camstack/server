/**
 * EventLoopStallMonitor — names the stream-broker process's event-loop
 * stalls.
 *
 * ## Why
 *
 * Production shows two signatures of a blocked loop in this process, neither
 * of which any line attributed:
 *
 *  - every camera's source-RTP activity watchdog firing in the SAME second
 *    (a whole-process silence, not N independent camera outages);
 *  - a measured 6.8 s offer→answer block that sat between two log lines with
 *    NO await between them and released in one burst (session created +
 *    first-RTP forwarded + codec negotiated within 2 ms) — the signature of
 *    a loop that froze and then flushed.
 *
 * Those stalls land 1:1 in remote time-to-first-frame: whatever phase spans
 * the freeze absorbs it. This monitor samples timer drift so a stall becomes
 * ONE structured report with its duration, correlatable by timestamp with
 * the phase brackets on the WebRTC connect path.
 *
 * ## How
 *
 * A `setInterval` at `intervalMs`; each tick measures how much LATER it ran
 * than scheduled. Late-past-`thresholdMs` → `onStall(lateMs)`. The sampler
 * itself is O(1) per tick and allocation-free — cheap enough to run always.
 */

export interface EventLoopStallMonitorOptions {
  /** Sampling cadence. Default 100 ms. */
  readonly intervalMs?: number
  /** Report ticks that ran at least this much later than scheduled.
   *  Default 250 ms — GC pauses and scheduler jitter stay below it;
   *  the production stalls of interest are 10–70× above it. */
  readonly thresholdMs?: number
  /** Clock, injectable for tests. Default `Date.now`. */
  readonly now?: () => number
  /** Receives the measured lateness (ms) of a stalled tick. Exceptions are
   *  swallowed — reporting must never break sampling. */
  readonly onStall: (stallMs: number) => void
}

const DEFAULT_INTERVAL_MS = 100
const DEFAULT_THRESHOLD_MS = 250

export class EventLoopStallMonitor {
  private readonly intervalMs: number
  private readonly thresholdMs: number
  private readonly now: () => number
  private readonly onStall: (stallMs: number) => void
  private timer: ReturnType<typeof setInterval> | null = null
  private lastTickAt = 0

  constructor(options: EventLoopStallMonitorOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
    this.thresholdMs = options.thresholdMs ?? DEFAULT_THRESHOLD_MS
    this.now = options.now ?? (() => Date.now())
    this.onStall = options.onStall
  }

  start(): void {
    if (this.timer) return
    this.lastTickAt = this.now()
    this.timer = setInterval(() => {
      const at = this.now()
      const lateMs = at - this.lastTickAt - this.intervalMs
      this.lastTickAt = at
      if (lateMs >= this.thresholdMs) {
        try {
          this.onStall(lateMs)
        } catch {
          // Reporting must never break the sampler.
        }
      }
    }, this.intervalMs)
    // Never keep the process alive just to sample it.
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }
}
