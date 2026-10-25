/**
 * D469. The `[mem]` line carried every GC number except the one that costs:
 * `gcPauseMs` is the MAIN-THREAD pause, and on 2026-09-12 it read 673 ms/60 s
 * on hub-main (1.1 % of a core) while the process's V8 platform workers were
 * burning 15.8 % — and 3 852 ms/300 s on stream-broker (1.3 %) against a
 * measured 36.6 %. A 14x and a 28x understatement of the largest item in the
 * container, on every process in the fleet.
 *
 * The two fields tested here close that: what this process costs (`procCpu`,
 * exact microseconds from `process.cpuUsage()`) and how much of it is V8's
 * background threads (`v8WorkerCpu`, a SHARE of that exact number so USER_HZ
 * never enters the arithmetic).
 */
import { describe, expect, it } from 'vitest'
import {
  createProcessCpuCensus,
  formatProcessCpu,
  PROCESS_CPU_MIN_WINDOW_MS,
  type ProcessCpuReading,
  type TaskTicks,
} from '../process-cpu-census.js'

const tasks = (main: number, worker: number, workers = 4): readonly TaskTicks[] => [
  { comm: 'MainThread', ticks: main },
  ...Array.from({ length: workers }, () => ({ comm: 'V8Worker', ticks: worker })),
]

describe('what the process costs', () => {
  it('reports CPU as a percentage of one core over the window it names', () => {
    let cpuUs = 0
    const census = createProcessCpuCensus({
      cpuUsageUs: () => cpuUs,
      readTasks: () => null,
      startedAt: 1_000,
    })
    // 30 core-seconds of CPU across 60 s of wall clock = 50 % of one core.
    cpuUs = 30_000_000
    expect(census.read(61_000)).toEqual<ProcessCpuReading>({
      percentOfCore: 50,
      windowMs: 60_000,
      v8Workers: null,
    })
  })

  it('measures each window against the previous read, not against the start', () => {
    let cpuUs = 0
    const census = createProcessCpuCensus({
      cpuUsageUs: () => cpuUs,
      readTasks: () => null,
      startedAt: 0,
    })
    cpuUs = 60_000_000
    expect(census.read(60_000)?.percentOfCore).toBe(100)
    cpuUs = 66_000_000
    const second = census.read(120_000)
    expect(second?.percentOfCore).toBe(10)
    expect(second?.windowMs).toBe(60_000)
  })

  it('declines to answer a window too short to describe', () => {
    const census = createProcessCpuCensus({
      cpuUsageUs: () => 0,
      readTasks: () => null,
      startedAt: 0,
    })
    expect(census.read(PROCESS_CPU_MIN_WINDOW_MS - 1)).toBeNull()
  })

  it('keeps the unread interval when it declines, so nothing is attributed to a window it did not span', () => {
    let cpuUs = 0
    const census = createProcessCpuCensus({
      cpuUsageUs: () => cpuUs,
      readTasks: () => null,
      startedAt: 0,
    })
    cpuUs = 30_000_000
    expect(census.read(500)).toBeNull()
    // The 30 core-seconds are still unread; the next read describes all 60 s.
    cpuUs = 60_000_000
    expect(census.read(60_000)).toEqual<ProcessCpuReading>({
      percentOfCore: 100,
      windowMs: 60_000,
      v8Workers: null,
    })
  })
})

describe('how much of it is V8 background work', () => {
  it('reports the worker share of the EXACT process cost, so USER_HZ never enters it', () => {
    let cpuUs = 0
    let current = tasks(0, 0)
    const census = createProcessCpuCensus({
      cpuUsageUs: () => cpuUs,
      readTasks: () => current,
      startedAt: 0,
    })
    // 60 core-seconds over 60 s = 100 % of a core. Ticks say 1000 main + 4x250
    // worker = 2000 total, so the workers are half of it — whatever a tick is.
    cpuUs = 60_000_000
    current = tasks(1000, 250)
    expect(census.read(60_000)).toEqual<ProcessCpuReading>({
      percentOfCore: 100,
      windowMs: 60_000,
      v8Workers: { percentOfCore: 50, threads: 4 },
    })
  })

  it('counts only threads named V8Worker', () => {
    let cpuUs = 0
    let current: readonly TaskTicks[] = [
      { comm: 'MainThread', ticks: 0 },
      { comm: 'libuv-worker', ticks: 0 },
      { comm: 'V8Worker', ticks: 0 },
    ]
    const census = createProcessCpuCensus({
      cpuUsageUs: () => cpuUs,
      readTasks: () => current,
      startedAt: 0,
    })
    cpuUs = 60_000_000
    current = [
      { comm: 'MainThread', ticks: 300 },
      { comm: 'libuv-worker', ticks: 100 },
      { comm: 'V8Worker', ticks: 100 },
    ]
    expect(census.read(60_000)?.v8Workers).toEqual({ percentOfCore: 20, threads: 1 })
  })

  it('says nothing about the workers when /proc cannot be read, and still reports the process cost', () => {
    let cpuUs = 0
    const census = createProcessCpuCensus({
      cpuUsageUs: () => cpuUs,
      readTasks: () => null,
      startedAt: 0,
    })
    cpuUs = 60_000_000
    const reading = census.read(60_000)
    expect(reading?.percentOfCore).toBe(100)
    expect(reading?.v8Workers).toBeNull()
  })

  it('a measurement that went backwards is null, never zero', () => {
    let cpuUs = 0
    let current = tasks(1000, 250)
    const census = createProcessCpuCensus({
      cpuUsageUs: () => cpuUs,
      readTasks: () => current,
      startedAt: 0,
    })
    // Threads vanished between the snapshots: the delta is not a reading.
    cpuUs = 60_000_000
    current = [{ comm: 'MainThread', ticks: 1000 }]
    const reading = census.read(60_000)
    expect(reading?.percentOfCore).toBe(100)
    expect(reading?.v8Workers).toBeNull()
  })

  it('a window in which no thread was scheduled at all is null, not a share of nothing', () => {
    const census = createProcessCpuCensus({
      cpuUsageUs: () => 0,
      readTasks: () => tasks(0, 0),
      startedAt: 0,
    })
    expect(census.read(60_000)?.v8Workers).toBeNull()
  })
})

describe('the line', () => {
  it('prints nothing at all when there is no reading', () => {
    expect(formatProcessCpu(null)).toBe('')
    expect(formatProcessCpu(undefined)).toBe('')
  })

  it('prints the process cost alone when the workers are unknown', () => {
    expect(formatProcessCpu({ percentOfCore: 33.3, windowMs: 60_000, v8Workers: null })).toBe(
      ' procCpu=33.3%',
    )
  })

  it('names the worker cost and how many threads it is spread over', () => {
    expect(
      formatProcessCpu({
        percentOfCore: 63.3,
        windowMs: 75_000,
        v8Workers: { percentOfCore: 36.6, threads: 4 },
      }),
    ).toBe(' procCpu=63.3% v8WorkerCpu=36.6%/4thr')
  })

  it('is appended LAST, so no field any Loki query reads has moved', () => {
    const line = `[mem] hub-main rss=1MB gc=maj9/min126/inc9@60s gcMajPerMin=9.0 gcPauseMs=809${formatProcessCpu(
      { percentOfCore: 33.3, windowMs: 60_000, v8Workers: { percentOfCore: 15.8, threads: 4 } },
    )}`
    expect(line.indexOf('gcPauseMs=')).toBeLessThan(line.indexOf('procCpu='))
    expect(line.indexOf('procCpu=')).toBeLessThan(line.indexOf('v8WorkerCpu='))
  })
})

describe('reading the real /proc', () => {
  it('reads this process and finds its own V8 workers, or says it cannot', async () => {
    const { readSelfTaskTicks } = await import('../process-cpu-census.js')
    const read = readSelfTaskTicks()
    if (process.platform !== 'linux') {
      expect(read).toBeNull()
      return
    }
    expect(read).not.toBeNull()
    expect(read?.some((t) => t.comm === 'V8Worker')).toBe(true)
    // Cumulative ticks are never negative.
    expect(read?.every((t) => t.ticks >= 0)).toBe(true)
  })
})
