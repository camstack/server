/**
 * In-process event-loop stall sampler for the capacity ramp.
 *
 * The capacity driver runs INSIDE the detection process (the same event
 * loop the executor's per-frame Node-side work blocks), so it can observe
 * stalls directly instead of scraping the `event loop stalled` log line —
 * the hub's own log ring holds ~20s and Loki is a post-hoc surface, neither
 * is a per-step counter. Same lateness principle as
 * `@camstack/system`'s `event-loop-stall-monitor.ts` (a tick that
 * arrives N ms late means the loop was blocked ~N ms), with cumulative
 * counters the driver snapshots at step boundaries and diffs.
 *
 * The one judgement — GC vs synchronous block — is delegated to the
 * monitor's own `attributeStall` so the two surfaces can never disagree on
 * what a stall was.
 */
import { type PerformanceEntry, PerformanceObserver } from 'node:perf_hooks'
import { attributeStall } from '@camstack/system/addon-utils'

/** Tick period — finer than the monitor's 1s so short steps still sample. */
export const STALL_SAMPLER_TICK_MS = 250

/** Report threshold — same bar as the monitor (`STALL_REPORT_MS`). */
export const STALL_SAMPLER_REPORT_MS = 2_000

/** Cumulative stall counters. Snapshot + diff across a step window. */
export interface StallSample {
  /** Stalls ≥ threshold since the sampler started (any cause). */
  readonly count: number
  /** Longest single stall observed (ms). */
  readonly maxMs: number
  /** Total blocked time across all stalls (ms). */
  readonly totalMs: number
  /** GC pause time attributed inside stall windows (ms). */
  readonly gcMs: number
  /** Stalls whose verdict was `synchronous-block`. */
  readonly syncCount: number
  /** Stalls whose verdict was `gc`. */
  readonly gcCount: number
}

const EMPTY_SAMPLE: StallSample = {
  count: 0,
  maxMs: 0,
  totalMs: 0,
  gcMs: 0,
  syncCount: 0,
  gcCount: 0,
}

interface GcWindow {
  readonly totalMs: number
  readonly count: number
  readonly longestMs: number
}

/**
 * Fold ONE tick observation into the cumulative sample. Pure — this is the
 * entire accounting judgement, testable without freezing a real loop.
 * `lateBy` below the threshold returns the sample unchanged (scheduling
 * jitter is not a stall).
 */
export function applyStallTick(
  sample: StallSample,
  lateByMs: number,
  gcWindow: GcWindow,
  reportThresholdMs: number,
): StallSample {
  if (lateByMs < reportThresholdMs) return sample
  const verdict = attributeStall(
    lateByMs,
    Math.round(gcWindow.totalMs),
    gcWindow.count,
    Math.round(gcWindow.longestMs),
  )
  return {
    count: sample.count + 1,
    maxMs: Math.max(sample.maxMs, lateByMs),
    totalMs: sample.totalMs + lateByMs,
    gcMs: sample.gcMs + verdict.gcMs,
    syncCount: sample.syncCount + (verdict.cause === 'synchronous-block' ? 1 : 0),
    gcCount: sample.gcCount + (verdict.cause === 'gc' ? 1 : 0),
  }
}

/** Diff two snapshots of the SAME sampler (end − start). */
export function diffStallSamples(start: StallSample, end: StallSample): StallSample {
  return {
    count: end.count - start.count,
    maxMs: end.maxMs, // max is not diffable; report the run max (conservative)
    totalMs: end.totalMs - start.totalMs,
    gcMs: end.gcMs - start.gcMs,
    syncCount: end.syncCount - start.syncCount,
    gcCount: end.gcCount - start.gcCount,
  }
}

export interface StallSamplerHandle {
  snapshot(): StallSample
  stop(): void
}

export interface StallSamplerOptions {
  readonly tickMs?: number
  readonly reportThresholdMs?: number
  readonly now?: () => number
  /**
   * Ticker injection for tests: receives the tick fn, returns a stop fn.
   * Default wires a real unref'd `setInterval`.
   */
  readonly createTicker?: (onTick: () => void, tickMs: number) => () => void
  /** Set false to skip the GC PerformanceObserver (tests). */
  readonly observeGc?: boolean
}

/**
 * Start sampling. Never throws into the caller (a diagnostic must not take
 * the detection process down): the GC observer degrades to
 * stall-without-attribution when unavailable, mirroring the boot monitor.
 */
export function startStallSampler(opts: StallSamplerOptions = {}): StallSamplerHandle {
  const tickMs = opts.tickMs ?? STALL_SAMPLER_TICK_MS
  const reportThresholdMs = opts.reportThresholdMs ?? STALL_SAMPLER_REPORT_MS
  const now = opts.now ?? Date.now

  let sample = EMPTY_SAMPLE
  let gc: { totalMs: number; count: number; longestMs: number } = {
    totalMs: 0,
    count: 0,
    longestMs: 0,
  }

  let observer: PerformanceObserver | null = null
  if (opts.observeGc !== false) {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as readonly PerformanceEntry[]) {
          gc = {
            totalMs: gc.totalMs + entry.duration,
            count: gc.count + 1,
            longestMs: Math.max(gc.longestMs, entry.duration),
          }
        }
      })
      observer.observe({ entryTypes: ['gc'] })
    } catch {
      observer = null
    }
  }

  let expected = now() + tickMs
  const onTick = (): void => {
    const t = now()
    const lateBy = t - expected
    const window = gc
    gc = { totalMs: 0, count: 0, longestMs: 0 }
    expected = t + tickMs
    sample = applyStallTick(sample, lateBy, window, reportThresholdMs)
  }

  const stopTicker =
    opts.createTicker !== undefined
      ? opts.createTicker(onTick, tickMs)
      : (() => {
          const timer = setInterval(onTick, tickMs)
          timer.unref?.()
          return () => clearInterval(timer)
        })()

  let stopped = false
  return {
    snapshot: () => sample,
    stop: () => {
      if (stopped) return
      stopped = true
      stopTicker()
      observer?.disconnect()
    },
  }
}
