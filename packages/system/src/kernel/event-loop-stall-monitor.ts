/**
 * event-loop-stall-monitor — names the thing that freezes the detection process.
 *
 * ## What this exists to settle
 *
 * On 2026-08-01/02 inference across the whole fleet stalled in bursts: 759
 * calls in 90 minutes crossed the runner's 20s deadline, p50 41s and max 80s,
 * and EVERY one of them eventually resolved. Six explanations were killed with
 * telemetry alone:
 *
 *  - not a slow GPU or a wedged pool — the work completes, just enormously late;
 *  - not CPU starvation — hosts sat at 8-48% during the freezes;
 *  - not swap — `pswpin/pswpout` are flat zero on every host;
 *  - not a logging artifact — Loki's timestamp trails the in-process one by
 *    0.1-1.0s at p95, so the gaps are real, not buffered delivery;
 *  - not the v1.2.30 release — the stalls predate it by a day;
 *  - not only the idle-pool recompile — that is real and hub-side, but the
 *    agent stalls with no eviction and no compile at all.
 *
 * What IS established: the 10s stats timer — which touches no inference code —
 * stops firing for 22-88s and resumes at the same instant the abandoned calls
 * settle. The event loop itself freezes. From outside the process, GC and a
 * synchronous block are indistinguishable, and guessing between them is how
 * this investigation would go wrong. So measure it.
 *
 * ## How
 *
 * A 1s interval whose LATENESS is the freeze: a tick that arrives 40s late means
 * the loop was blocked ~39s, whatever blocked it. In the same window the GC
 * observer accumulates pause time. The two numbers together answer the question
 * outright:
 *
 *  - `gcMs` ≈ `stallMs` → garbage collection. Look at heap growth.
 *  - `gcMs` ≈ 0 → something SYNCHRONOUS blocked the loop, and GC is innocent.
 *
 * Heap and RSS ride along because if it is GC, the next question is always
 * "growing since when?".
 *
 * Deliberately not a histogram (`monitorEventLoopDelay`): that reports a
 * distribution, and the question here is about ONE outlier and what coincided
 * with it.
 */
import { PerformanceObserver, type PerformanceEntry } from 'node:perf_hooks'
import type { IScopedLogger } from '@camstack/types'

/** Tick period. Small enough to bound attribution error, large enough to cost
 *  nothing on a process already doing frame work. */
export const STALL_TICK_MS = 1_000

/**
 * Report a freeze only past this. The runner's own inference deadline is 20s
 * and the observed freezes run 22-88s, so this is far below the signal while
 * staying clear of ordinary scheduling jitter (a busy frame path routinely
 * overruns a 1s timer by tens of ms).
 */
export const STALL_REPORT_MS = 2_000

export interface StallVerdict {
  /** How long the loop was actually blocked. */
  readonly stallMs: number
  /** GC pause time inside the stall window. */
  readonly gcMs: number
  /** Number of GC pauses in the window. */
  readonly gcCount: number
  /** Longest single GC pause in the window. */
  readonly longestGcMs: number
  /** What the evidence says. */
  readonly cause: 'gc' | 'synchronous-block' | 'mixed'
}

/**
 * Attribute a freeze. Pure, because this is the ONE judgement the whole module
 * exists to make and it must be testable without freezing a real event loop.
 *
 * `gc` when garbage collection accounts for most of the stall; a
 * `synchronous-block` when it accounts for almost none — that verdict points
 * away from the heap entirely and at whatever ran without yielding.
 */
export function attributeStall(
  stallMs: number,
  gcMs: number,
  gcCount: number,
  longestGcMs: number,
): StallVerdict {
  const share = stallMs > 0 ? gcMs / stallMs : 0
  const cause: StallVerdict['cause'] =
    share >= 0.7 ? 'gc' : share <= 0.2 ? 'synchronous-block' : 'mixed'
  return { stallMs, gcMs, gcCount, longestGcMs, cause }
}

interface GcWindow {
  totalMs: number
  count: number
  longestMs: number
}

/**
 * Start watching. Returns a stop function; safe to call twice.
 *
 * Never throws into the caller: a diagnostic that can take the detection
 * process down is worse than no diagnostic. `PerformanceObserver` for `gc` is
 * unavailable in some embedded runtimes, and that must degrade to
 * stall-detection-without-attribution rather than a boot failure.
 */
export function startEventLoopStallMonitor(
  logger: IScopedLogger,
  reportThresholdMs: number = STALL_REPORT_MS,
): () => void {
  let gc: GcWindow = { totalMs: 0, count: 0, longestMs: 0 }
  let observer: PerformanceObserver | null = null
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as readonly PerformanceEntry[]) {
        gc.totalMs += entry.duration
        gc.count += 1
        if (entry.duration > gc.longestMs) gc.longestMs = entry.duration
      }
    })
    observer.observe({ entryTypes: ['gc'] })
  } catch {
    observer = null
  }

  let expected = Date.now() + STALL_TICK_MS
  const timer = setInterval(() => {
    const now = Date.now()
    const lateBy = now - expected
    const window = gc
    gc = { totalMs: 0, count: 0, longestMs: 0 }
    expected = now + STALL_TICK_MS
    if (lateBy < reportThresholdMs) return

    const verdict = attributeStall(
      lateBy,
      Math.round(window.totalMs),
      window.count,
      Math.round(window.longestMs),
    )
    const mem = process.memoryUsage()
    logger.warn('event loop stalled', {
      meta: {
        stallMs: verdict.stallMs,
        cause: verdict.cause,
        gcMs: verdict.gcMs,
        gcCount: verdict.gcCount,
        longestGcMs: verdict.longestGcMs,
        gcObserved: observer !== null,
        heapUsedMb: Math.round(mem.heapUsed / 1e6),
        heapTotalMb: Math.round(mem.heapTotal / 1e6),
        rssMb: Math.round(mem.rss / 1e6),
        externalMb: Math.round(mem.external / 1e6),
        arrayBuffersMb: Math.round(mem.arrayBuffers / 1e6),
      },
    })
  }, STALL_TICK_MS)
  timer.unref?.()

  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    observer?.disconnect()
  }
}
