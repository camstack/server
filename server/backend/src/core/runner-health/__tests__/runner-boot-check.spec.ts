import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  evaluateRunnerBootCheck,
  isRunnerBootCheckDegraded,
  isRunnerBootCheckSettled,
  RunnerBootCheckService,
  type RunnerStateRow,
} from '../runner-boot-check.js'

const row = (name: string, state: string, reason?: string): RunnerStateRow => ({
  name,
  addonIds: [name],
  state,
  ...(reason !== undefined ? { refusal: { reason } } : {}),
})

describe('evaluateRunnerBootCheck (D877)', () => {
  it('names failed, refused and missing runners against the hub plan', () => {
    const check = evaluateRunnerBootCheck({
      planned: ['a', 'b', 'c', 'd', 'e'],
      processes: [
        row('a', 'running'),
        row('b', 'failed'),
        row('c', 'refused', 'legacy blobs'),
        row('d', 'crashed'),
        row('stray', 'running'),
      ],
      now: 7,
    })
    expect(check).toEqual({
      checkedAtMs: 7,
      expected: 5,
      running: 1,
      failed: ['b'],
      refused: [{ runnerId: 'c', addonIds: ['c'], reason: 'legacy blobs' }],
      missing: ['e'],
      pending: ['d'],
      planKnown: true,
    })
    expect(isRunnerBootCheckDegraded(check)).toBe(true)
  })

  it('starting and crashed-in-backoff are PENDING, not failed: a slow boot is not an outage', () => {
    const check = evaluateRunnerBootCheck({
      planned: ['a', 'b', 'c'],
      processes: [row('a', 'starting'), row('b', 'crashed'), row('c', 'running')],
      now: 1,
    })
    expect(check).toMatchObject({ failed: [], pending: ['a', 'b'], running: 1 })
    expect(isRunnerBootCheckSettled(check)).toBe(false)
  })

  it('an agent has no plan: it judges the runners it holds and cannot name a missing one', () => {
    const check = evaluateRunnerBootCheck({
      planned: null,
      processes: [row('a', 'running'), row('b', 'failed')],
      now: 1,
    })
    expect(check).toMatchObject({
      expected: 2,
      running: 1,
      failed: ['b'],
      missing: [],
      planKnown: false,
    })
  })

  it('a clean node is not degraded, and "not checked yet" is not degraded either', () => {
    const ok = evaluateRunnerBootCheck({ planned: ['a'], processes: [row('a', 'running')], now: 1 })
    expect(isRunnerBootCheckDegraded(ok)).toBe(false)
    expect(isRunnerBootCheckDegraded(undefined)).toBe(false)
  })
})

describe('RunnerBootCheckService', () => {
  const logger = (): { logger: IScopedLogger; error: ReturnType<typeof vi.fn> } => {
    const error = vi.fn()
    const noop = vi.fn()
    const l = { error, warn: noop, info: noop, debug: noop }
    return { logger: l as unknown as IScopedLogger, error }
  }

  it('stores the verdict, logs the degraded node loudly and hands it to the result handler', async () => {
    const { logger: log, error } = logger()
    const seen: unknown[] = []
    const svc = new RunnerBootCheckService({
      logger: log,
      nodeId: 'hub',
      planned: () => ['a', 'b'],
      listProcesses: async () => [row('a', 'running')],
      onResult: (c) => seen.push(c),
      now: () => 5,
    })
    expect(svc.current()).toBeUndefined()
    await svc.run()
    expect(svc.current()?.missing).toEqual(['b'])
    expect(error).toHaveBeenCalledTimes(1)
    expect(seen).toHaveLength(1)
  })

  it('a process service that cannot answer records NO verdict (unknown is not "all well")', async () => {
    const { logger: log } = logger()
    const svc = new RunnerBootCheckService({
      logger: log,
      nodeId: 'hub',
      planned: () => ['a'],
      listProcesses: async () => {
        throw new Error('down')
      },
    })
    await svc.run()
    expect(svc.current()).toBeUndefined()
  })

  it('announces nothing until every runner settled, then re-evaluates on a runner change (no timer)', async () => {
    const { logger: log } = logger()
    let rows: RunnerStateRow[] = [row('a', 'starting'), row('b', 'failed')]
    const seen: unknown[] = []
    const svc = new RunnerBootCheckService({
      logger: log,
      nodeId: 'hub',
      planned: () => ['a', 'b'],
      listProcesses: async () => rows,
      onResult: (c) => seen.push(c),
    })
    await svc.run()
    expect(svc.current()?.pending).toEqual(['a'])
    expect(seen).toHaveLength(0) // 'b' failed, but the verdict is not final: nothing pushed
    svc.noteRunnerChange() // nothing changed yet: re-evaluates, still pending
    await vi.waitFor(() => expect(seen).toHaveLength(0))
    rows = [row('a', 'running'), row('b', 'failed')]
    svc.noteRunnerChange()
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(svc.current()).toMatchObject({ pending: [], failed: ['b'] })
    svc.noteRunnerChange() // settled: no more evaluations
    await new Promise((r) => setTimeout(r, 10))
    expect(seen).toHaveLength(1)
  })

  it('is one-shot: arming twice schedules one run', async () => {
    vi.useFakeTimers()
    try {
      const { logger: log } = logger()
      const list = vi.fn(async () => [row('a', 'running')])
      const svc = new RunnerBootCheckService({
        logger: log,
        nodeId: 'hub',
        planned: () => ['a'],
        listProcesses: list,
      })
      svc.scheduleAfterBoot(60_000)
      svc.scheduleAfterBoot(60_000)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(list).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
