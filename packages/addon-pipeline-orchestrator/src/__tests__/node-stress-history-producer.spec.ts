import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { HISTORY_BUCKET_MS } from '@camstack/types'
import {
  NodeStressHistoryProducer,
  type NodeStressHistoryClient,
} from '../node-stress-history-producer.js'

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

describe('NodeStressHistoryProducer', () => {
  it('flushDue passes closed buckets with node subject to recordBuckets', async () => {
    const T0 = 1_700_000_000_000
    const deviceHistory: NodeStressHistoryClient & {
      recordBuckets: ReturnType<typeof vi.fn>
    } = {
      declareSeries: vi.fn(async (input: { name: string }) => ({
        key: `addon:pipeline-orchestrator/${input.name}`,
      })),
      recordBuckets: vi.fn(async (input) => ({
        accepted: input.buckets.length,
        refused: [],
      })),
      queryNode: vi.fn(async () => ({ series: [] })),
    }
    const prod = new NodeStressHistoryProducer({
      deviceHistory,
      logger: silentLogger(),
      now: () => T0 + HISTORY_BUCKET_MS + 1,
    })
    await prod.declare()
    prod.noteSignals(
      'hub',
      {
        score: 0.7,
        queuePressure: 0.2,
        dropRatio: 0.1,
        fpsDeficit: 0.3,
        deficitCorroborated: true,
      },
      T0 + 30_000,
    )
    await prod.flushDue()
    expect(deviceHistory.recordBuckets).toHaveBeenCalledOnce()
    const buckets = deviceHistory.recordBuckets.mock.calls[0]![0]!.buckets
    expect(buckets.length).toBeGreaterThanOrEqual(4)
    for (const b of buckets) {
      expect(b.subject.kind).toBe('node')
      if (b.subject.kind === 'node') expect(b.subject.nodeId).toBe('hub')
    }
  })

  describe('declare-until-success and refusals', () => {
    const T0 = 1_700_000_000_000
    const signals = {
      score: 0.7,
      queuePressure: 0.2,
      dropRatio: 0.1,
      fpsDeficit: 0.3,
      deficitCorroborated: true,
    }
    function client(): NodeStressHistoryClient & {
      declareSeries: ReturnType<typeof vi.fn>
      recordBuckets: ReturnType<typeof vi.fn>
    } {
      return {
        declareSeries: vi.fn(async (input: { name: string }) => ({ key: input.name })),
        recordBuckets: vi.fn(async (input) => ({ accepted: input.buckets.length, refused: [] })),
        queryNode: vi.fn(async () => ({ series: [] })),
      }
    }

    it('a failed declare is retried by the next flush, which then writes', async () => {
      const dh = client()
      dh.declareSeries.mockRejectedValueOnce(new Error('not found'))
      const prod = new NodeStressHistoryProducer({
        deviceHistory: dh,
        logger: silentLogger(),
        now: () => T0 + 2 * HISTORY_BUCKET_MS,
      })
      await prod.declare().catch(() => undefined)
      prod.noteSignals('hub', signals, T0 + 1_000)
      await prod.flushDue()
      expect(dh.declareSeries.mock.calls.length).toBeGreaterThan(1)
      expect(dh.recordBuckets).toHaveBeenCalledOnce()
    })

    it('an undeclared refusal is logged, re-declares and requeues', async () => {
      const dh = client()
      dh.recordBuckets.mockResolvedValueOnce({
        accepted: 0,
        refused: [{ key: 'k', reason: 'undeclared', count: 4 }],
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
      const prod = new NodeStressHistoryProducer({
        deviceHistory: dh,
        logger,
        now: () => T0 + 2 * HISTORY_BUCKET_MS,
      })
      await prod.declare()
      prod.noteSignals('hub', signals, T0 + 1_000)
      await prod.flushDue()
      expect(warn).toHaveBeenCalledOnce()
      expect(JSON.stringify(warn.mock.calls[0])).toContain('undeclared')
      const before = dh.declareSeries.mock.calls.length
      await prod.flushDue()
      expect(dh.declareSeries.mock.calls.length).toBeGreaterThan(before)
      expect(dh.recordBuckets).toHaveBeenCalledTimes(2)
    })
  })
})
