/**
 * The automatic benchmark's attempt ledger survives an orchestrator restart:
 * the Mac was benchmarked again three minutes after a node-lost attempt, right
 * after a respawn, because attempts and spacing lived in memory. The stored
 * blob is round-tripped through JSON, as the settings store does.
 */
import type { IScopedLogger, NodeBenchmarkPlanInput } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  AutoBenchmarkScheduler,
  AUTO_BENCH_MAX_ATTEMPTS,
  AUTO_BENCH_RETRY_MS,
  benchKey,
  type AutoBenchNode,
} from '../node-benchmark/auto-benchmark.js'
import { attemptsFromBlob, attemptsToBlob } from '../node-benchmark/auto-benchmark-attempts.js'
import { AutoBenchmarkAttemptsSchema } from '../orchestrator-store-schemas.js'

const MAC: AutoBenchNode = {
  nodeId: 'mac',
  online: true,
  camerasOnNode: 0,
  devices: [{ key: 'coreml:all', available: true, exclusion: null }],
}

/** A settings-store blob: only JSON survives a "restart". */
function fakeStore() {
  let stored: string | null = null
  return {
    persistence: {
      load: async () =>
        attemptsFromBlob(
          stored === null ? {} : AutoBenchmarkAttemptsSchema.parse(JSON.parse(stored)),
          benchKey,
        ),
      save: async (map: Parameters<typeof attemptsToBlob>[0]) => {
        stored = JSON.stringify(attemptsToBlob(map))
      },
    },
    raw: () => stored,
  }
}

function boot(opts: {
  store?: ReturnType<typeof fakeStore>
  nowMs: number
  benchmarked?: ReadonlySet<string>
}) {
  const started: NodeBenchmarkPlanInput[] = []
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  const scheduler = new AutoBenchmarkScheduler({
    logger,
    readNodes: async () => [MAC],
    benchmarked: async () => opts.benchmarked ?? new Set<string>(),
    runActive: () => false,
    pickModels: async () => ({ 'coreml:all': 'yolov9m-640' }),
    start: async (plan) => {
      started.push(plan)
      return { kind: 'started' as const, runId: `r${String(started.length)}` }
    },
    now: () => opts.nowMs,
    ...(opts.store !== undefined ? { persistence: opts.store.persistence } : {}),
  })
  return { scheduler, started }
}

describe('AutoBenchmarkScheduler — the attempt ledger survives a restart', () => {
  it('a respawn three minutes after an attempt does not start the next one', async () => {
    const store = fakeStore()
    const t0 = 10_000_000
    await boot({ store, nowMs: t0 }).scheduler.tick('boot')
    expect(store.raw()).toContain('"count":1')

    const afterRespawn = boot({ store, nowMs: t0 + 3 * 60_000 })
    await afterRespawn.scheduler.tick('boot')
    expect(afterRespawn.started).toHaveLength(0)

    const later = boot({ store, nowMs: t0 + AUTO_BENCH_RETRY_MS + 1 })
    await later.scheduler.tick('boot')
    expect(later.started).toHaveLength(1)
  })

  it('the attempt budget counts across restarts', async () => {
    const store = fakeStore()
    let now = 10_000_000
    for (let i = 0; i < AUTO_BENCH_MAX_ATTEMPTS; i += 1) {
      const run = boot({ store, nowMs: now })
      await run.scheduler.tick('boot')
      expect(run.started).toHaveLength(1)
      now += AUTO_BENCH_RETRY_MS + 1
    }
    const after = boot({ store, nowMs: now })
    await after.scheduler.tick('boot')
    expect(after.started).toHaveLength(0)
  })

  it('without persistence a restart starts at once (the old behaviour this replaces)', async () => {
    const t0 = 10_000_000
    await boot({ nowMs: t0 }).scheduler.tick('boot')
    const again = boot({ nowMs: t0 + 3 * 60_000 })
    await again.scheduler.tick('boot')
    expect(again.started).toHaveLength(1)
  })

  it('a device that gains a usable result is forgotten', async () => {
    const store = fakeStore()
    await boot({ store, nowMs: 10_000_000 }).scheduler.tick('boot')
    const done = boot({
      store,
      nowMs: 11_000_000,
      benchmarked: new Set([benchKey('mac', 'coreml:all')]),
    })
    await done.scheduler.tick('boot')
    expect(JSON.parse(store.raw() ?? '{}')).toEqual({})
  })

  it('an unreadable ledger starts with none and does not stop the scheduler', async () => {
    const broken = {
      load: async () => {
        throw new Error('store down')
      },
      save: async () => undefined,
    }
    const started: NodeBenchmarkPlanInput[] = []
    const logger: IScopedLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => logger,
      withTags: () => logger,
    }
    const scheduler = new AutoBenchmarkScheduler({
      logger,
      readNodes: async () => [MAC],
      benchmarked: async () => new Set<string>(),
      runActive: () => false,
      pickModels: async () => ({ 'coreml:all': 'yolov9m-640' }),
      start: async (plan) => {
        started.push(plan)
        return { kind: 'started' as const, runId: 'r1' }
      },
      now: () => 1,
      persistence: broken,
    })
    await scheduler.tick('boot')
    expect(started).toHaveLength(1)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('attempt ledger unreadable'),
      expect.anything(),
    )
  })
})
