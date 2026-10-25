/**
 * hub-main's `[mem]` heartbeat, and the reason it was invisible.
 *
 * The watch itself has been running in hub-main since 2026-08-02. What it never
 * had was a DESTINATION: `startHeapWatch` was called with no sink, so it fell
 * back to `console.log`, which the log manager knows nothing about. Every forked
 * runner passes a sink backed by its `IScopedLogger`, so a runner's line fans
 * out to the buffer, the console destination, the rotated file and Loki.
 * hub-main's went to a file descriptor. 42 hours of Loki carried a `[mem]` line
 * for every runner in the cluster and none for the largest process in it.
 *
 * These specs assert the chain Loki actually sits on — `startHeapWatch` → sink →
 * `LogManager.createLogger` → `ILogDestination.write` — rather than asserting
 * that a mock function was called, because a mock function was called before
 * this change too.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { LogEntry } from '@camstack/types'
import { type ILogDestination, LogManager } from '../../logging/log-manager.js'
import {
  buildHeapSample,
  createDeferredHeapWatchSink,
  type HeapWatchProbes,
  type HeapWatchSink,
  HUB_MAIN_HEAP_WATCH_LABEL,
  hubMainRssBudget,
  startHeapWatch,
  strandedMb,
  ZERO_LOOP_DELAY,
} from '../heap-watch.js'

const MB = 1024 * 1024

interface MemoryOverrides {
  readonly rss: number
  readonly heapUsed: number
  readonly heapTotal?: number
  readonly external?: number
  readonly arrayBuffers?: number
}

function mem(o: MemoryOverrides): NodeJS.MemoryUsage {
  return {
    rss: o.rss,
    heapTotal: o.heapTotal ?? o.heapUsed,
    heapUsed: o.heapUsed,
    external: o.external ?? 0,
    arrayBuffers: o.arrayBuffers ?? 0,
  }
}

/** A destination is what Loki IS — the loki addon registers one. */
class RecordingDestination implements ILogDestination {
  readonly entries: LogEntry[] = []
  async initialize(): Promise<void> {}
  async shutdown(): Promise<void> {}
  write(entry: LogEntry): void {
    this.entries.push(entry)
  }
}

type MemoryReader = () => NodeJS.MemoryUsage

interface WiredWatch {
  readonly destination: RecordingDestination
  readonly stdout: HeapWatchSink
  readonly attach: () => void
  readonly stop: () => void
}

/**
 * The readings of THIS process that a `[mem]` line otherwise takes for real —
 * posed from the fake clock, so a window is a window in every environment.
 *
 * The per-thread CPU census (D469) reads `/proc/self/task` — on macOS that is
 * `null` and `v8WorkerCpu` is absent from every line; on Linux it is real
 * jiffies of REAL time, which fake timers do not advance. A 60 s hub window is
 * ~0.2 ms of CPU here and a 300 s runner window ~1.5 ms, against 10 ms jiffies:
 * on the CI runner (one throttled N100 core shared with a second vitest worker,
 * whose ticks land in the same `/proc/self`) the runner window crossed a jiffy
 * and the hub window did not, and `v8WorkerCpu` was on one line in two runs
 * out of four. A vocabulary test reads the format, never the machine (D624).
 */
function posedProcessProbes(): HeapWatchProbes {
  // 20 % of a core, spread 60/40 between the main thread and V8's workers —
  // every window ≥ 1 s of fake time has ticks, so the share is a reading.
  const ticksNow = (): number => Math.floor(Date.now() / 10)
  return {
    readSpaces: () => [
      { name: 'old_space', usedBytes: 900 * MB },
      { name: 'large_object_space', usedBytes: 64 * MB },
      { name: 'new_space', usedBytes: 40 * MB },
    ],
    processCpu: {
      cpuUsageUs: () => Date.now() * 1000 * 0.2,
      readTasks: () => [
        { comm: 'MainThread', ticks: Math.floor(ticksNow() * 0.6) },
        { comm: 'V8Worker', ticks: Math.floor(ticksNow() * 0.1) },
        { comm: 'V8Worker', ticks: Math.floor(ticksNow() * 0.1) },
        { comm: 'V8Worker', ticks: Math.floor(ticksNow() * 0.1) },
        { comm: 'V8Worker', ticks: Math.floor(ticksNow() * 0.1) },
      ],
    },
  }
}

/**
 * hub-main's real wiring: the watch starts before any logger exists (a process
 * that dies nine seconds after boot must still leave samples), so the sink is
 * handed over later rather than the start being delayed.
 */
function wireHubMain(
  readMemory: MemoryReader,
  budgetMb?: number,
  probes?: HeapWatchProbes,
): WiredWatch {
  const manager = new LogManager()
  const destination = new RecordingDestination()
  manager.addDestination(destination)
  const logger = manager.createLogger('heap-watch')
  const stdout: HeapWatchSink = { info: vi.fn(), warn: vi.fn() }
  const deferred = createDeferredHeapWatchSink(HUB_MAIN_HEAP_WATCH_LABEL, stdout)
  const stop = startHeapWatch(
    HUB_MAIN_HEAP_WATCH_LABEL,
    deferred.sink,
    60_000,
    { reclaim: () => undefined, readMemory, heapLimitBytes: 4288 * MB },
    { read: () => ZERO_LOOP_DELAY, stop: () => undefined },
    [],
    false,
    { budgetMb, source: 'test' },
    probes,
  )
  return {
    destination,
    stdout,
    attach: () => {
      deferred.attach({
        info: (line) => {
          logger.info(line)
        },
        warn: (line) => {
          logger.warn(line)
        },
      })
    },
    stop,
  }
}

/** The routine hub-main heartbeat, as it reaches a destination. */
function heartbeats(d: RecordingDestination): readonly string[] {
  return d.entries
    .map((e) => e.message)
    .filter((m) => m.startsWith(`[mem] ${HUB_MAIN_HEAP_WATCH_LABEL} rss=`))
}

describe('the heartbeat reaches the log manager, which is what Loki reads', () => {
  it('a hub-main sample lands in a DESTINATION, not only on stdout', () => {
    vi.useFakeTimers()
    const w = wireHubMain(() => mem({ rss: 4870 * MB, heapUsed: 1295 * MB, external: 360 * MB }))
    try {
      w.attach()
      vi.advanceTimersByTime(120_000)
      expect(heartbeats(w.destination).length).toBeGreaterThan(0)
    } finally {
      w.stop()
      vi.useRealTimers()
    }
  })

  it('the handover announces itself once, through the NEW target', () => {
    vi.useFakeTimers()
    const w = wireHubMain(() => mem({ rss: 900 * MB, heapUsed: 500 * MB }))
    try {
      w.attach()
      vi.advanceTimersByTime(600_000)
      const handover = w.destination.entries.filter((e) =>
        e.message.includes('heartbeat attached to the log manager'),
      )
      expect(handover).toHaveLength(1)
      // Its absence from Loki is the only in-band evidence the wiring broke,
      // so it must carry hub-main's name like every other line.
      expect(handover[0]?.message).toContain(`[mem] ${HUB_MAIN_HEAP_WATCH_LABEL}`)
    } finally {
      w.stop()
      vi.useRealTimers()
    }
  })

  it('BEFORE the handover the boot window still goes to stdout — nothing is delayed', () => {
    vi.useFakeTimers()
    const w = wireHubMain(() => mem({ rss: 900 * MB, heapUsed: 500 * MB }))
    try {
      // The first tick is synchronous inside startHeapWatch, i.e. before any
      // logger could possibly exist. That sample is the reason the watch is
      // started where it is, and it must not be lost to the handover.
      expect(vi.mocked(w.stdout.info).mock.calls.length).toBeGreaterThan(0)
      expect(heartbeats(w.destination)).toHaveLength(0)
      w.attach()
      vi.advanceTimersByTime(120_000)
      expect(heartbeats(w.destination).length).toBeGreaterThan(0)
    } finally {
      w.stop()
      vi.useRealTimers()
    }
  })

  it('carries every field a runner line carries — one vocabulary, not two', () => {
    vi.useFakeTimers()
    const hub = wireHubMain(
      () => mem({ rss: 4870 * MB, heapUsed: 1295 * MB, external: 360 * MB, arrayBuffers: 64 * MB }),
      4096,
      posedProcessProbes(),
    )
    const runnerLines: string[] = []
    const stopRunner = startHeapWatch(
      'hub/recorder',
      {
        info: (line) => {
          runnerLines.push(line)
        },
        warn: (line) => {
          runnerLines.push(line)
        },
      },
      300_000,
      {
        reclaim: () => undefined,
        readMemory: () => mem({ rss: 1500 * MB, heapUsed: 900 * MB, external: 40 * MB }),
        heapLimitBytes: 3072 * MB,
      },
      { read: () => ZERO_LOOP_DELAY, stop: () => undefined },
      [],
      false,
      { budgetMb: 3072, source: 'test' },
      posedProcessProbes(),
    )
    try {
      hub.attach()
      // Far enough for the RUNNER's 300s cadence to produce a DUE line. The
      // comparison used to run at 120s, where the only runner line available
      // was its synchronous boot line — a boot line and a due line are not the
      // same line, and a field whose window has not opened yet (the gc census,
      // D458) is absent from one and present on the other for reasons that have
      // nothing to do with the two processes speaking one vocabulary.
      vi.advanceTimersByTime(300_000)
      const keys = (line: string): readonly string[] =>
        [...line.matchAll(/([a-zA-Z0-9]+)=/g)].map((m) => m[1] ?? '')
      const hubLine = heartbeats(hub.destination).at(-1)
      const runnerLine = runnerLines.filter((l) => l.startsWith('[mem] hub/recorder rss=')).at(-1)
      expect(hubLine).toBeDefined()
      expect(runnerLine).toBeDefined()
      expect(keys(hubLine ?? '')).toEqual(keys(runnerLine ?? ''))
      // And the shape that separates a leak from allocator residue is present.
      expect(hubLine).toContain('rss=')
      expect(hubLine).toContain('heapUsed=')
      expect(hubLine).toContain('external=')
      // The CONDITIONAL fields are present on both, by construction of the posed
      // probes — so the equality above compared them rather than their absence.
      // Off Linux the real `/proc` reader answers `null` and both lines lack
      // `v8WorkerCpu`; two absences are equal and prove nothing (D624).
      expect(keys(hubLine ?? '')).toContain('procCpu')
      expect(keys(hubLine ?? '')).toContain('v8WorkerCpu')
      expect(keys(hubLine ?? '')).toContain('gc')
    } finally {
      hub.stop()
      stopRunner()
      vi.useRealTimers()
    }
  })
})

describe('the label', () => {
  it('cannot collide with a runner, because a runner label always has a slash', () => {
    // `kernel/moleculer/addon-runner.ts:222` builds every runner nodeId as
    // `${parentNodeId}/${runnerId}`. A label with no slash is unreachable by
    // that rule, so hub-main is unambiguous by construction.
    expect(HUB_MAIN_HEAP_WATCH_LABEL).not.toContain('/')
  })

  it('sorts immediately before the hub/ family — the root, then its runners', () => {
    // `hub/decoder-ffmpeg` is in the list deliberately: it sorts before a
    // hypothetical `hub/main`, so this fails if the label ever moves INTO the
    // runner namespace instead of sitting ahead of it.
    const sorted = [
      'hub/stream-broker',
      HUB_MAIN_HEAP_WATCH_LABEL,
      'hub/recorder',
      'hub/decoder-ffmpeg',
      'hub/pipeline-analytics',
    ].toSorted()
    expect(sorted[0]).toBe(HUB_MAIN_HEAP_WATCH_LABEL)
  })
})

describe('stranded — the arithmetic that separates a leak from allocator residue', () => {
  it('is rss minus heapUsed minus external, on hub-main as measured 2026-08-27', () => {
    const sample = buildHeapSample(
      mem({ rss: 4870 * MB, heapUsed: 1295 * MB, external: 360 * MB }),
      4288 * MB,
    )
    expect(sample.rssMb).toBe(4870)
    expect(sample.heapUsedMb).toBe(1295)
    expect(sample.externalMb).toBe(360)
    expect(strandedMb(sample)).toBe(3215)
  })

  it('is subtractive, not clamped — a process below its own floor reads negative', () => {
    const sample = buildHeapSample(
      mem({ rss: 500 * MB, heapUsed: 400 * MB, external: 200 * MB }),
      0,
    )
    expect(strandedMb(sample)).toBe(-100)
  })
})

describe('a budget is stated or absent — never implied', () => {
  it('hub-main declares 4096MB, and every routine line says so', () => {
    vi.useFakeTimers()
    const budget = hubMainRssBudget({})
    const w = wireHubMain(() => mem({ rss: 900 * MB, heapUsed: 500 * MB }), budget.budgetMb)
    try {
      w.attach()
      vi.advanceTimersByTime(120_000)
      expect(budget.budgetMb).toBe(4096)
      const lines = heartbeats(w.destination)
      // A `for` over nothing is not an assertion. Two of this repo's shipped
      // bugs hid behind a vacuously green loop.
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) expect(line).toContain('rssBudget=4096MB')
    } finally {
      w.stop()
      vi.useRealTimers()
    }
  })

  it('with no budget the line claims none, and the process says it is UNWATCHED', () => {
    vi.useFakeTimers()
    const w = wireHubMain(() => mem({ rss: 900 * MB, heapUsed: 500 * MB }), undefined)
    try {
      w.attach()
      vi.advanceTimersByTime(120_000)
      const lines = heartbeats(w.destination)
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) expect(line).not.toContain('rssBudget')
      // Silence would read as "watched and fine". It has to be said out loud —
      // and on stdout, because the announcement happens at boot, before the
      // handover.
      const announced = vi
        .mocked(w.stdout.info)
        .mock.calls.map((c) => String(c[0]))
        .filter((l) => l.includes('NOT WATCHED against an RSS budget'))
      expect(announced).toHaveLength(1)
    } finally {
      w.stop()
      vi.useRealTimers()
    }
  })

  it('an operator override of 0 disables the alarm without inventing a default', () => {
    const budget = hubMainRssBudget({ CAMSTACK_HUB_RSS_BUDGET_MB: '0' })
    expect(budget.budgetMb).toBeUndefined()
  })
})

describe('the sample costs what a 2s probe on the router process is allowed to cost', () => {
  it('reads memory ONCE per probe — this runs where every cross-runner call is mediated', () => {
    vi.useFakeTimers()
    const readMemory = vi.fn(() => mem({ rss: 900 * MB, heapUsed: 500 * MB }))
    const stop = startHeapWatch(
      HUB_MAIN_HEAP_WATCH_LABEL,
      { info: vi.fn(), warn: vi.fn() },
      60_000,
      { reclaim: () => undefined, readMemory, heapLimitBytes: 4288 * MB },
      { read: () => ZERO_LOOP_DELAY, stop: () => undefined },
      [],
      false,
      { budgetMb: 4096, source: 'test' },
    )
    try {
      readMemory.mockClear()
      // 60s at the 2s probe cadence = 30 probes. A second read per probe would
      // be a second `process.memoryUsage()`; a `/proc/<pid>/smaps` parse would
      // be orders of magnitude worse and is why this is pinned.
      vi.advanceTimersByTime(60_000)
      expect(readMemory).toHaveBeenCalledTimes(30)
    } finally {
      stop()
      vi.useRealTimers()
    }
  })

  it('never touches the filesystem — smaps stays a manual census, not a probe', () => {
    // The three growth shapes were ESTABLISHED with smaps; they are not
    // MEASURED with it. Parsing 10,819 mappings every 2s on the process that
    // routes every cross-runner call is not telemetry, it is load. Asserted
    // against the module's own source because the cheapest way for that to
    // regress is an import nobody notices.
    const source = readFileSync(
      new URL('../heap-watch.ts', import.meta.url).pathname,
      'utf8',
    ).replaceAll(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '')
    expect(source).not.toMatch(/from 'node:fs/)
    expect(source).not.toMatch(/from 'node:child_process/)
    expect(source).not.toContain('/proc/')
  })

  it('the whole sample, computed for real, is far under one probe period', () => {
    // Everything the probe does that is not the log line: read the ceiling,
    // read memory, build the sample, evaluate the reclaim gate.
    const iterations = 20_000
    const startedAt = process.hrtime.bigint()
    let sink = 0
    for (let i = 0; i < iterations; i += 1) {
      const sample = buildHeapSample(process.memoryUsage(), 4288 * MB)
      sink += strandedMb(sample)
    }
    const nsPerSample = Number(process.hrtime.bigint() - startedAt) / iterations
    expect(sink).not.toBeNaN()
    // Measured ~2-6us on a laptop. The bound is deliberately 100x that: this
    // asserts "free at a 2s cadence", not a machine-specific number, so it can
    // never flake in CI while still failing if a filesystem read appears.
    expect(nsPerSample).toBeLessThan(500_000)
  })

  it('the deferred indirection is what THIS change adds, and it is one call', () => {
    const target: HeapWatchSink = {
      info: () => undefined,
      warn: () => undefined,
    }
    const deferred = createDeferredHeapWatchSink('bench', {
      info: () => undefined,
      warn: () => undefined,
    })
    deferred.attach(target)
    const iterations = 1_000_000
    const startedAt = process.hrtime.bigint()
    for (let i = 0; i < iterations; i += 1) deferred.sink.info('x')
    const nsPerCall = Number(process.hrtime.bigint() - startedAt) / iterations
    // And it is paid ONCE PER LINE — 1 per minute on hub-main — not per probe.
    expect(nsPerCall).toBeLessThan(1_000)
  })
})
