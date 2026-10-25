import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import {
  NODE_CONTAINER_CURRENT_KEY,
  NODE_CPU_KEY,
  NODE_CPU_TEMPERATURE_KEY,
  NODE_GPU_KEY,
  NODE_MEMORY_KEY,
  NODE_PROCESS_CPU_KEY,
  NODE_TOTALS_MIN_INTERVAL_MS,
  RUNNER_CPU_GC_KEY,
  RUNNER_CPU_LIFETIME_KEY,
  RUNNER_CPU_MAIN_KEY,
  RUNNER_PROCESSES_KEY,
  RUNNER_RSS_KEY,
  NodeMetricsHistoryRecorder,
  type NodeHistoryPoint,
  type NodeMetricsHistoryClient,
  assembleRunnerSamples,
} from '../node-metrics-history-recorder.js'
import type { SystemResourceSnapshot } from '@camstack/types'
import type { RetainedProcess } from '../load-series-types.js'

function silentLogger(): IScopedLogger {
  const noop = vi.fn()
  const logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: (): IScopedLogger => logger,
    withTags: (): IScopedLogger => logger,
  }
  return logger as unknown as IScopedLogger
}

describe('NodeMetricsHistoryRecorder', () => {
  function recordingClient(): NodeMetricsHistoryClient & {
    record: ReturnType<typeof vi.fn>
    points: () => readonly NodeHistoryPoint[]
  } {
    const record = vi.fn(async (input: { points: readonly NodeHistoryPoint[] }) => ({
      accepted: input.points.length,
      refused: [],
    }))
    return {
      declareSeries: vi.fn(async (input: { name: string }) => ({
        key: `addon:metrics-native/${input.name}`,
      })),
      record,
      queryNode: vi.fn(async () => ({ series: [] })),
      points: () => record.mock.calls.flatMap((c) => c[0].points),
    }
  }

  function processRow(pid: number, over: Partial<RetainedProcess> = {}): RetainedProcess {
    return {
      pid,
      addonId: 'pipeline',
      classification: 'managed',
      cpuPercent: 10,
      memoryRssBytes: 100 * 1_048_576,
      cpuMainPercent: 4,
      cpuGcPercent: 1,
      ...over,
    }
  }

  it('scopes per RUNNER, never per pid: a respawned runner keeps writing ONE series', async () => {
    const client = recordingClient()
    const rec = new NodeMetricsHistoryRecorder({ deviceHistory: client, logger: silentLogger() })
    await rec.recordSample('hub', 1000, [processRow(42), processRow(43)], null)
    // The runner restarted: new pids, same addon.
    await rec.recordSample('hub', 11_000, [processRow(977)], null)
    const points = client.points()
    expect(points.some((p) => p.key === NODE_PROCESS_CPU_KEY)).toBe(false)
    expect(new Set(points.map((p) => p.scope))).toEqual(new Set(['pipeline']))
    const at1 = points.filter((p) => p.ts === 1000)
    expect(at1.find((p) => p.key === RUNNER_CPU_LIFETIME_KEY)?.value).toBe(20)
    expect(at1.find((p) => p.key === RUNNER_RSS_KEY)?.value).toBe(200)
    expect(at1.find((p) => p.key === RUNNER_PROCESSES_KEY)?.value).toBe(2)
    expect(at1.find((p) => p.key === RUNNER_CPU_MAIN_KEY)?.value).toBe(8)
    expect(at1.find((p) => p.key === RUNNER_CPU_GC_KEY)?.value).toBe(2)
  })

  it('a runner whose split is unknown for one process writes no CPU split (never a partial sum)', async () => {
    const client = recordingClient()
    const rec = new NodeMetricsHistoryRecorder({ deviceHistory: client, logger: silentLogger() })
    await rec.recordSample(
      'hub',
      1000,
      [
        processRow(1),
        processRow(2, { cpuMainPercent: null, cpuGcPercent: null }),
        processRow(3, { addonId: null, classification: 'root' }),
      ],
      null,
    )
    const points = client.points()
    expect(points.filter((p) => p.key === RUNNER_CPU_MAIN_KEY).map((p) => p.scope)).toEqual([
      '__root__',
    ])
  })

  it('reads the runner series back as process rows the fold sums to the same numbers', () => {
    const answer = (scope: string, value: number) => ({
      series: [{ scope, points: [{ t: 5000, value, samples: 1 }] }],
    })
    const samples = assembleRunnerSamples({
      main: answer('pipeline', 8),
      gc: answer('pipeline', 2),
      lifetime: answer('pipeline', 20),
      rss: answer('pipeline', 200),
      count: answer('pipeline', 2),
    })
    expect(samples).toHaveLength(1)
    const rows = samples[0]?.processes ?? []
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.addonId === 'pipeline' && r.classification === 'managed')).toBe(true)
    expect(rows.reduce((n, r) => n + r.cpuPercent, 0)).toBe(20)
    expect(rows.reduce((n, r) => n + (r.cpuMainPercent ?? 0), 0)).toBe(8)
    expect(rows.reduce((n, r) => n + r.memoryRssBytes, 0)).toBe(200 * 1_048_576)
  })

  it('records node totals, skips a reading the node did not take, and bounds the rate', async () => {
    const client = recordingClient()
    const rec = new NodeMetricsHistoryRecorder({ deviceHistory: client, logger: silentLogger() })
    const snapshot: SystemResourceSnapshot = {
      cpu: { total: 37.25, user: 30, system: 7, irq: 0, nice: 0, loadAvg: [1, 1, 1], cores: 4 },
      memory: {
        percent: 61,
        totalBytes: 100,
        usedBytes: 61,
        availableBytes: 39,
        swapUsedBytes: 0,
        swapTotalBytes: 0,
      },
      gpu: null,
      network: {
        rxBytes: 0,
        txBytes: 0,
        rxPackets: 0,
        txPackets: 0,
        rxErrors: 0,
        txErrors: 0,
        timestampMs: 0,
      },
      disk: { readBytes: 0, writeBytes: 0, readOps: 0, writeOps: 0, timestampMs: 0 },
      pressure: { cpu: null, memory: null, io: null },
      process: { openFds: 0, threadCount: 0, activeHandles: 0, activeRequests: 0 },
      cpuTemperature: null,
      timestampMs: 0,
    }
    await rec.recordTotals('agent-a', 1000, snapshot)
    await rec.recordTotals('agent-a', 1000 + NODE_TOTALS_MIN_INTERVAL_MS - 1, snapshot)
    await rec.recordTotals('agent-a', 1000 + NODE_TOTALS_MIN_INTERVAL_MS, {
      ...snapshot,
      cpuTemperature: 48,
    })
    const points = client.points()
    expect(points.filter((p) => p.ts === 1000).map((p) => [p.key, p.value])).toEqual([
      [NODE_CPU_KEY, 37.3],
      [NODE_MEMORY_KEY, 61],
    ])
    expect(points.some((p) => p.key === NODE_GPU_KEY)).toBe(false)
    expect(points.filter((p) => p.key === NODE_CPU_TEMPERATURE_KEY).map((p) => p.value)).toEqual([
      48,
    ])
    expect(points.every((p) => p.subject.nodeId === 'agent-a')).toBe(true)
  })

  it('records container memory when cgroup snapshot is present', async () => {
    const client: NodeMetricsHistoryClient & { record: ReturnType<typeof vi.fn> } = {
      declareSeries: vi.fn(async (input: { name: string }) => ({
        key: `addon:metrics-native/${input.name}`,
      })),
      record: vi.fn(async (input) => ({
        accepted: input.points.length,
        refused: [],
      })),
      queryNode: vi.fn(async () => ({ series: [] })),
    }
    const rec = new NodeMetricsHistoryRecorder({ deviceHistory: client, logger: silentLogger() })
    await rec.recordSample('hub', 2000, [], {
      source: 'cgroup-v2',
      currentBytes: 2 * 1_048_576,
      limitBytes: null,
      anonBytes: null,
      fileBytes: null,
      shmemBytes: null,
      slabBytes: null,
      gpuShmemBytes: null,
    })
    expect(client.record.mock.calls[0]![0]!.points[0]!.key).toBe(NODE_CONTAINER_CURRENT_KEY)
  })

  describe('declare-until-success and refusals', () => {
    const proc = {
      pid: 42,
      addonId: 'pipeline',
      classification: 'managed' as const,
      cpuPercent: 1,
      memoryRssBytes: 1_048_576,
      cpuMainPercent: null,
      cpuGcPercent: null,
    }
    function client(): NodeMetricsHistoryClient & {
      declareSeries: ReturnType<typeof vi.fn>
      record: ReturnType<typeof vi.fn>
    } {
      return {
        declareSeries: vi.fn(async (input: { name: string }) => ({ key: input.name })),
        record: vi.fn(async (input) => ({ accepted: input.points.length, refused: [] })),
        queryNode: vi.fn(async () => ({ series: [] })),
      }
    }

    it('a failed declare is retried by the next sample, which then writes', async () => {
      const dh = client()
      dh.declareSeries.mockRejectedValueOnce(new Error('caller addon could not be identified'))
      const rec = new NodeMetricsHistoryRecorder({ deviceHistory: dh, logger: silentLogger() })
      await rec.declare().catch(() => undefined)
      await rec.recordSample('hub', 1000, [proc], null)
      expect(dh.record).toHaveBeenCalledOnce()
    })

    it('an undeclared refusal is logged and the next sample re-declares', async () => {
      const dh = client()
      dh.record.mockResolvedValueOnce({
        accepted: 0,
        refused: [{ key: RUNNER_RSS_KEY, reason: 'undeclared', count: 2 }],
      })
      const warn = vi.fn()
      const noop = vi.fn()
      const logger = {
        debug: noop,
        info: noop,
        warn,
        error: noop,
        child: (): IScopedLogger => logger,
        withTags: (): IScopedLogger => logger,
      } as unknown as IScopedLogger
      const rec = new NodeMetricsHistoryRecorder({ deviceHistory: dh, logger })
      await rec.recordSample('hub', 1000, [proc], null)
      expect(warn).toHaveBeenCalledOnce()
      expect(JSON.stringify(warn.mock.calls[0])).toContain('undeclared')
      const before = dh.declareSeries.mock.calls.length
      await rec.recordSample('hub', 2000, [proc], null)
      expect(dh.declareSeries.mock.calls.length).toBeGreaterThan(before)
    })
  })

  it('stores nothing and declares nothing until device-history is ready, then both', async () => {
    let ready = false
    const client: NodeMetricsHistoryClient & {
      declareSeries: ReturnType<typeof vi.fn>
      record: ReturnType<typeof vi.fn>
    } = {
      declareSeries: vi.fn(async (input: { name: string }) => ({
        key: `addon:metrics-native/${input.name}`,
      })),
      record: vi.fn(async (input) => ({ accepted: input.points.length, refused: [] })),
      queryNode: vi.fn(async () => ({ series: [] })),
    }
    const rec = new NodeMetricsHistoryRecorder({
      deviceHistory: client,
      logger: silentLogger(),
      historyReady: () => ready,
    })
    const proc = {
      pid: 7,
      addonId: null,
      classification: 'managed' as const,
      cpuPercent: 1,
      memoryRssBytes: 1_048_576,
      cpuMainPercent: null,
      cpuGcPercent: null,
    }
    await rec.recordSample('hub', 1000, [proc], null)
    expect(client.declareSeries).not.toHaveBeenCalled()
    expect(client.record).not.toHaveBeenCalled()
    ready = true
    await rec.recordSample('hub', 20_000, [proc], null)
    expect(client.declareSeries).toHaveBeenCalledTimes(11)
    expect(client.record).toHaveBeenCalled()
  })
})
