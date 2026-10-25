/**
 * D469 — the wiring, not the arithmetic. `process-cpu-census.spec.ts` proves
 * the numbers; this proves they reach the `[mem]` line, which is the half that
 * fails silently. D285 is the precedent: the heap watch was started correctly
 * and passed no sink for 27 days, and a heartbeat with no destination is
 * indistinguishable from no heartbeat.
 */
import { describe, expect, it, vi } from 'vitest'
import { startHeapWatch } from '../heap-watch.js'
import type { TaskTicks } from '../process-cpu-census.js'

interface Sink {
  readonly lines: string[]
  readonly info: (m: string) => void
  readonly warn: (m: string) => void
  readonly error: (m: string) => void
  readonly debug: (m: string) => void
}

function sink(): Sink {
  const lines: string[] = []
  const push = (m: string): void => {
    lines.push(m)
  }
  return { lines, info: push, warn: push, error: push, debug: push }
}

const MEM: NodeJS.MemoryUsage = {
  rss: 1_800_000_000,
  heapTotal: 1_000_000_000,
  heapUsed: 800_000_000,
  external: 270_000_000,
  arrayBuffers: 20_000_000,
}

const tasks = (main: number, worker: number): readonly TaskTicks[] => [
  { comm: 'MainThread', ticks: main },
  { comm: 'V8Worker', ticks: worker },
  { comm: 'V8Worker', ticks: worker },
  { comm: 'V8Worker', ticks: worker },
  { comm: 'V8Worker', ticks: worker },
]

interface Posed {
  /** CPU microseconds the process has used at the end of the window. */
  readonly cpuUs: number
  /** Per-thread ticks at the end of the window, or `null` for "cannot read". */
  readonly ticks: readonly TaskTicks[] | null
}

/** Runs one 60 s window against a process that starts at zero, returns its line. */
function lineFor(posed: Posed): string | undefined {
  let at = 0
  let cpu = 0
  let t: readonly TaskTicks[] | null = posed.ticks === null ? null : tasks(0, 0)
  const s = sink()
  const stop = startHeapWatch(
    'hub-main',
    s,
    60_000,
    {
      readMemory: () => MEM,
      now: () => at,
      heapLimitBytes: 3_422_552_064,
      reclaim: () => undefined,
    },
    undefined,
    [],
    false,
    undefined,
    {
      readSpaces: () => [],
      processCpu: { cpuUsageUs: () => cpu, readTasks: () => t },
    },
  )
  at = 60_000
  cpu = posed.cpuUs
  t = posed.ticks
  vi.advanceTimersByTime(60_000)
  stop()
  return s.lines.find((l) => l.includes('procCpu='))
}

describe('process CPU on the [mem] line', () => {
  it('names what this process cost and how much of it was V8 background work', () => {
    vi.useFakeTimers()
    try {
      // 20 core-seconds over 60 s = 33.3 % of a core; ticks say the four
      // workers hold 1 900 of 4 000, i.e. 47.5 % of it = 15.8 %. Those are the
      // numbers measured on the live hub-main on 2026-09-12.
      const line = lineFor({ cpuUs: 20_000_000, ticks: tasks(2100, 475) })
      expect(line).toBeDefined()
      expect(line).toContain('procCpu=33.3%')
      expect(line).toContain('v8WorkerCpu=15.8%/4thr')
    } finally {
      vi.useRealTimers()
    }
  })

  it('prints an idle process at zero — a runner doing nothing is a reading', () => {
    vi.useFakeTimers()
    try {
      const line = lineFor({ cpuUs: 0, ticks: tasks(0, 0) })
      expect(line).toContain('procCpu=0.0%')
      // No thread was scheduled, so the worker SHARE is unknown, not zero.
      expect(line).not.toContain('v8WorkerCpu=')
    } finally {
      vi.useRealTimers()
    }
  })

  it('still reports the process cost when /proc cannot be read', () => {
    vi.useFakeTimers()
    try {
      const line = lineFor({ cpuUs: 60_000_000, ticks: null })
      expect(line).toContain('procCpu=100.0%')
      // Absence is the reading: unknown must never print as zero (D393).
      expect(line).not.toContain('v8WorkerCpu=')
    } finally {
      vi.useRealTimers()
    }
  })

  it('is appended after the GC fields, so nothing a Loki query reads has moved', () => {
    vi.useFakeTimers()
    try {
      const line = lineFor({ cpuUs: 60_000_000, ticks: tasks(100, 100) })
      expect(line).toBeDefined()
      expect(line?.indexOf('rss=')).toBeLessThan(line?.indexOf('procCpu=') ?? -1)
      expect(line?.indexOf('heapUsed=')).toBeLessThan(line?.indexOf('procCpu=') ?? -1)
      expect(line?.indexOf('gcPauseMs=')).toBeLessThan(line?.indexOf('procCpu=') ?? -1)
      expect(line?.indexOf('procCpu=')).toBeLessThan(line?.indexOf('v8WorkerCpu=') ?? -1)
    } finally {
      vi.useRealTimers()
    }
  })
})
