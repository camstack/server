import type { IScopedLogger, NodeBenchmarkPlanInput, NodeBenchmarkPreflight } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  AutoBenchmarkScheduler,
  type AutoBenchmarkDeps,
  AUTO_BENCH_MAX_ATTEMPTS,
  AUTO_BENCH_MAX_CAMERAS_ON_NODE,
  AUTO_BENCH_RETRY_MS,
  planAutoBenchmark,
  type AutoBenchInput,
  type AutoBenchNode,
} from '../node-benchmark/auto-benchmark.js'

const node = (over: Partial<AutoBenchNode> = {}): AutoBenchNode => ({
  nodeId: 'amd',
  online: true,
  camerasOnNode: 0,
  devices: [{ key: 'edgetpu:usb', available: true, exclusion: null }],
  ...over,
})

const input = (over: Partial<AutoBenchInput> = {}): AutoBenchInput => ({
  nodes: [node()],
  benchmarked: new Set<string>(),
  runActive: false,
  attempts: new Map(),
  nowMs: 1_000_000,
  ...over,
})

describe('planAutoBenchmark', () => {
  it('a device with no result starts a run limited to that device', () => {
    const plan = planAutoBenchmark(input())
    expect(plan.start).toEqual({ nodeId: 'amd', deviceKeys: ['edgetpu:usb'] })
  })

  it('a device that already has results starts nothing', () => {
    const plan = planAutoBenchmark(input({ benchmarked: new Set(['amd\u0000edgetpu:usb']) }))
    expect(plan.start).toBeNull()
    expect(plan.decisions).toContainEqual(
      expect.objectContaining({ deviceKey: 'edgetpu:usb', kind: 'skip', reason: 'has-results' }),
    )
  })

  it('a device the operator disabled starts nothing, results or not', () => {
    const plan = planAutoBenchmark(
      input({
        nodes: [
          node({ devices: [{ key: 'edgetpu:usb', available: true, exclusion: 'disabled' }] }),
        ],
      }),
    )
    expect(plan.start).toBeNull()
    expect(plan.decisions).toContainEqual(
      expect.objectContaining({ kind: 'skip', reason: 'not-eligible' }),
    )
  })

  it('an unavailable or excluded device starts nothing', () => {
    for (const device of [
      { key: 'd', available: false, exclusion: 'unavailable' },
      { key: 'd', available: true, exclusion: 'accelerator-preferred' },
    ]) {
      expect(planAutoBenchmark(input({ nodes: [node({ devices: [device] })] })).start).toBeNull()
    }
  })

  it('waits while another benchmark is running', () => {
    const plan = planAutoBenchmark(input({ runActive: true }))
    expect(plan.start).toBeNull()
    expect(plan.decisions).toContainEqual(
      expect.objectContaining({ kind: 'wait', reason: 'run-active' }),
    )
  })

  it('defers a busy node, and starts it once it is quiet', () => {
    const busy = node({ camerasOnNode: AUTO_BENCH_MAX_CAMERAS_ON_NODE + 1 })
    const plan = planAutoBenchmark(input({ nodes: [busy] }))
    expect(plan.start).toBeNull()
    expect(plan.decisions).toContainEqual(
      expect.objectContaining({ kind: 'wait', reason: 'node-busy', nodeId: 'amd' }),
    )
    const quiet = node({ camerasOnNode: AUTO_BENCH_MAX_CAMERAS_ON_NODE })
    expect(planAutoBenchmark(input({ nodes: [quiet] })).start).not.toBeNull()
  })

  it('an offline node waits', () => {
    const plan = planAutoBenchmark(input({ nodes: [node({ online: false })] }))
    expect(plan.start).toBeNull()
    expect(plan.decisions).toContainEqual(
      expect.objectContaining({ kind: 'wait', reason: 'node-offline' }),
    )
  })

  it('retries at a bounded pace and gives up after the attempts', () => {
    const key = 'amd\u0000edgetpu:usb'
    const soon = planAutoBenchmark(
      input({
        attempts: new Map([[key, { count: 1, lastAtMs: 1_000_000 - AUTO_BENCH_RETRY_MS + 1 }]]),
      }),
    )
    expect(soon.start).toBeNull()
    expect(soon.decisions).toContainEqual(
      expect.objectContaining({ kind: 'wait', reason: 'retry-later' }),
    )
    const due = planAutoBenchmark(
      input({
        attempts: new Map([[key, { count: 1, lastAtMs: 1_000_000 - AUTO_BENCH_RETRY_MS }]]),
      }),
    )
    expect(due.start).not.toBeNull()
    const spent = planAutoBenchmark(
      input({ attempts: new Map([[key, { count: AUTO_BENCH_MAX_ATTEMPTS, lastAtMs: 0 }]]) }),
    )
    expect(spent.start).toBeNull()
    expect(spent.decisions).toContainEqual(
      expect.objectContaining({ kind: 'skip', reason: 'gave-up' }),
    )
  })

  it('runs ONE node at a time (the first by id) with its pending devices in that run', () => {
    const plan = planAutoBenchmark(
      input({
        nodes: [
          node({
            nodeId: 'b',
            devices: [
              { key: 'x', available: true, exclusion: null },
              { key: 'y', available: true, exclusion: null },
            ],
          }),
          node({ nodeId: 'a' }),
        ],
      }),
    )
    expect(plan.start).toEqual({ nodeId: 'a', deviceKeys: ['edgetpu:usb'] })
  })
})

interface Logged {
  readonly message: string
  readonly tags?: Record<string, unknown>
}

function harness(over: Partial<AutoBenchmarkDeps> = {}) {
  const started: NodeBenchmarkPlanInput[] = []
  const lines: Logged[] = []
  const at = (message: string, extra?: { tags?: Record<string, unknown> }): void => {
    lines.push({ message, ...extra })
  }
  const logger: IScopedLogger = {
    debug: at,
    info: at,
    warn: at,
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  const scheduler = new AutoBenchmarkScheduler({
    logger,
    readNodes: async () => [node()],
    benchmarked: async () => new Set<string>(),
    runActive: () => false,
    pickModels: async (_nodeId, keys) => Object.fromEntries(keys.map((k) => [k, 'yolov9t'])),
    start: async (plan) => {
      started.push(plan)
      return { kind: 'started' as const, runId: 'r1' }
    },
    now: () => 5_000_000,
    ...over,
  })
  return { scheduler, started, lines }
}

describe('AutoBenchmarkScheduler', () => {
  it('starts a device-phase run limited to the new device, logged with the node tag', async () => {
    const { scheduler, started, lines } = harness()
    await scheduler.tick('test')
    expect(started).toHaveLength(1)
    expect(started[0]).toMatchObject({
      nodeId: 'amd',
      phases: ['device'],
      devices: [{ deviceKey: 'edgetpu:usb', modelIds: ['yolov9t'] }],
      acceptInsufficientHeadroom: false,
    })
    expect(lines.find((l) => l.message === 'auto benchmark: started')?.tags).toEqual({
      nodeId: 'amd',
    })
  })

  it('does not start a second run while the retry spacing holds', async () => {
    const { scheduler, started } = harness()
    await scheduler.tick('a')
    await scheduler.tick('b')
    expect(started).toHaveLength(1)
  })

  it('a refused start is deferred and logged once, and costs no attempt', async () => {
    let calls = 0
    const refused: NodeBenchmarkPreflight['refusals'] = [
      { kind: 'insufficient-headroom', detail: 'x', overridable: true },
    ]
    const { scheduler, lines } = harness({
      start: async () => {
        calls += 1
        return { kind: 'refused' as const, preflight: refusedPreflight(refused) }
      },
    })
    await scheduler.tick('a')
    await scheduler.tick('b')
    expect(calls).toBe(2)
    expect(lines.filter((l) => l.message === 'auto benchmark: wait')).toHaveLength(1)
  })
})

function refusedPreflight(refusals: NodeBenchmarkPreflight['refusals']): NodeBenchmarkPreflight {
  return {
    nodeId: 'amd',
    online: true,
    moving: [],
    staying: [],
    estimatedDurationMs: 0,
    budgetMs: 0,
    phases: ['device'],
    steps: [],
    devices: [],
    headroom: { sessionsNow: 0, otherNodesCapacitySessions: null },
    refusals,
    canStart: false,
  }
}
