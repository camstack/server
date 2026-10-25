import { describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { HISTORY_BUCKET_MS } from '@camstack/types'
import {
  ANALYTICS_AUDIO_LEVEL_KEY,
  ANALYTICS_HISTORY_BUCKET_SERIES,
  AnalyticsHistoryProducer,
  type DeviceHistoryWriteClient,
} from '../store/analytics-history-producer.js'

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

function fakeDeviceHistory(): DeviceHistoryWriteClient & {
  declareSeries: ReturnType<typeof vi.fn>
  record: ReturnType<typeof vi.fn>
  recordBuckets: ReturnType<typeof vi.fn>
  query: ReturnType<typeof vi.fn>
} {
  return {
    declareSeries: vi.fn(async (input: { name: string }) => ({
      key: `addon:pipeline-analytics/${input.name}`,
    })),
    record: vi.fn(async () => ({ accepted: 1, refused: [] })),
    recordBuckets: vi.fn(async () => ({ accepted: 1, refused: [] })),
    query: vi.fn(async () => ({ resolution: '5m' as const, series: [] })),
  }
}

describe('AnalyticsHistoryProducer', () => {
  it('declareSeries registers bucket series and audio-level points', async () => {
    const dh = fakeDeviceHistory()
    const prod = new AnalyticsHistoryProducer({ deviceHistory: dh, logger: silentLogger() })
    await prod.declare()
    expect(dh.declareSeries).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'motion', ingest: 'buckets', subjectKind: 'device' }),
    )
    expect(dh.declareSeries).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'audio-level', ingest: 'points' }),
    )
  })

  it('flushDue sends closed buckets to recordBuckets with device subject and keys', async () => {
    const T0 = 1_700_000_000_000
    const dh = fakeDeviceHistory()
    const prod = new AnalyticsHistoryProducer({
      deviceHistory: dh,
      logger: silentLogger(),
      now: () => T0 + HISTORY_BUCKET_MS + 1,
    })
    await prod.declare()
    prod.note('motion', 101, 3, T0 + 60_000)
    await prod.flushDue()
    expect(dh.recordBuckets).toHaveBeenCalledOnce()
    const arg = dh.recordBuckets.mock.calls[0]![0] as {
      buckets: ReadonlyArray<{ key: string; subject: { kind: string; deviceId: number } }>
    }
    expect(arg.buckets).toHaveLength(1)
    expect(arg.buckets[0]!.key).toBe(ANALYTICS_HISTORY_BUCKET_SERIES.motion)
    expect(arg.buckets[0]!.subject).toEqual({ kind: 'device', deviceId: 101 })
  })

  it('recordAudioLevel calls deviceHistory.record, not a store insert', async () => {
    const dh = fakeDeviceHistory()
    const prod = new AnalyticsHistoryProducer({ deviceHistory: dh, logger: silentLogger() })
    await prod.declare()
    prod.recordAudioLevel(102, -42.5, 9_000)
    await vi.waitFor(() => expect(dh.record).toHaveBeenCalled())
    const arg = dh.record.mock.calls[0]![0] as {
      points: ReadonlyArray<{ key: string; value: number; subject: { deviceId: number } }>
    }
    expect(arg.points[0]!.key).toBe(ANALYTICS_AUDIO_LEVEL_KEY)
    expect(arg.points[0]!.value).toBe(-42.5)
    expect(arg.points[0]!.subject.deviceId).toBe(102)
  })

  describe('observeAudioLevel — one PEAK point per window', () => {
    async function points(dh: ReturnType<typeof fakeDeviceHistory>) {
      await vi.waitFor(() => expect(dh.record).toHaveBeenCalled())
      return dh.record.mock.calls.flatMap(
        (c) => (c[0] as { points: ReadonlyArray<{ ts: number; value: number }> }).points,
      )
    }

    it("a 2 s spike inside a stable window is that window's peak", async () => {
      const dh = fakeDeviceHistory()
      const prod = new AnalyticsHistoryProducer({ deviceHistory: dh, logger: silentLogger() })
      for (let t = 0; t < 10_000; t += 1_000) {
        prod.observeAudioLevel(102, t === 4_000 || t === 5_000 ? -10 : -50, 100_000 + t)
      }
      prod.observeAudioLevel(102, -50, 110_000) // closes the window
      const pts = await points(dh)
      expect(pts).toEqual([expect.objectContaining({ ts: 100_000, value: -10 })])
    })

    it('stable audio still yields one point per window', async () => {
      const dh = fakeDeviceHistory()
      const prod = new AnalyticsHistoryProducer({ deviceHistory: dh, logger: silentLogger() })
      for (let t = 0; t <= 40_000; t += 1_000) prod.observeAudioLevel(102, -45, 200_000 + t)
      await vi.waitFor(() => expect(dh.record.mock.calls.length).toBe(4))
      const ts = (await points(dh)).map((p) => p.ts)
      expect(ts).toEqual([200_000, 210_000, 220_000, 230_000])
    })

    it('records measured silence as a finite value, never -Infinity', async () => {
      const dh = fakeDeviceHistory()
      const prod = new AnalyticsHistoryProducer({ deviceHistory: dh, logger: silentLogger() })
      prod.observeAudioLevel(102, Number.NEGATIVE_INFINITY, 300_000)
      prod.observeAudioLevel(102, Number.NEGATIVE_INFINITY, 310_000)
      const pts = await points(dh)
      expect(Number.isFinite(pts[0]!.value)).toBe(true)
    })
  })

  it('readLongTermBuckets queries device-history at 5m resolution', async () => {
    const dh = fakeDeviceHistory()
    dh.query.mockResolvedValueOnce({
      resolution: '5m',
      series: [
        {
          scope: '',
          points: [{ t: 100, samples: 2, min: 3, max: 7, mean: 5, twMean: null, last: 7 }],
        },
      ],
    })
    const prod = new AnalyticsHistoryProducer({ deviceHistory: dh, logger: silentLogger() })
    const rows = await prod.readLongTermBuckets({
      deviceId: 101,
      series: 'occupancy',
      from: 0,
      to: 600_000,
    })
    expect(dh.query).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 101,
        key: ANALYTICS_HISTORY_BUCKET_SERIES.occupancy,
        resolution: '5m',
      }),
    )
    expect(rows[0]).toEqual(
      expect.objectContaining({ bucketStart: 100, samples: 2, sum: 10, min: 3, max: 7 }),
    )
  })

  it('readLongTermBuckets skips points whose mean is null (never invents sum 0)', async () => {
    const dh = fakeDeviceHistory()
    dh.query.mockResolvedValueOnce({
      resolution: '5m',
      series: [
        {
          scope: '',
          points: [
            { t: 100, samples: 4, min: 1, max: 9, mean: null, twMean: null, last: null },
            { t: 200, samples: 2, min: 3, max: 7, mean: 5, twMean: null, last: 7 },
          ],
        },
      ],
    })
    const prod = new AnalyticsHistoryProducer({ deviceHistory: dh, logger: silentLogger() })
    const rows = await prod.readLongTermBuckets({
      deviceId: 101,
      series: 'motion',
      from: 0,
      to: 600_000,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual(expect.objectContaining({ bucketStart: 200, samples: 2, sum: 10 }))
  })

  describe('declare-until-success and refusals', () => {
    function warnLogger(): { logger: IScopedLogger; warn: ReturnType<typeof vi.fn> } {
      const warn = vi.fn()
      const noop = vi.fn()
      const logger = {
        debug: noop,
        info: noop,
        warn,
        error: noop,
        child: (): IScopedLogger => logger,
        withTags: (): IScopedLogger => logger,
      }
      return { logger: logger as unknown as IScopedLogger, warn }
    }

    it('a failed boot declare is retried by the next flush, which then writes', async () => {
      const dh = fakeDeviceHistory()
      dh.declareSeries.mockRejectedValueOnce(new Error('device-history is starting'))
      const T0 = 1_700_000_000_000
      const prod = new AnalyticsHistoryProducer({
        deviceHistory: dh,
        logger: silentLogger(),
        now: () => T0 + 2 * HISTORY_BUCKET_MS,
      })
      await prod.declare().catch(() => undefined)
      prod.note('motion', 102, 3, T0 + 1_000)
      await prod.flushDue()
      expect(dh.declareSeries.mock.calls.length).toBeGreaterThan(1)
      expect(dh.recordBuckets).toHaveBeenCalledOnce()
    })

    it('recordAudioLevel declares first when nothing is declared yet', async () => {
      const dh = fakeDeviceHistory()
      const prod = new AnalyticsHistoryProducer({ deviceHistory: dh, logger: silentLogger() })
      prod.recordAudioLevel(102, -40, 9_000)
      await vi.waitFor(() => expect(dh.record).toHaveBeenCalledOnce())
      expect(dh.declareSeries).toHaveBeenCalled()
    })

    it('an undeclared refusal is logged with counts, re-declares and requeues', async () => {
      const dh = fakeDeviceHistory()
      dh.recordBuckets.mockResolvedValueOnce({
        accepted: 0,
        refused: [{ key: ANALYTICS_HISTORY_BUCKET_SERIES.motion, reason: 'undeclared', count: 2 }],
      })
      const { logger, warn } = warnLogger()
      const T0 = 1_700_000_000_000
      const prod = new AnalyticsHistoryProducer({
        deviceHistory: dh,
        logger,
        now: () => T0 + 2 * HISTORY_BUCKET_MS,
      })
      await prod.declare()
      prod.note('motion', 102, 3, T0 + 1_000)
      await prod.flushDue()
      expect(warn).toHaveBeenCalledOnce()
      expect(JSON.stringify(warn.mock.calls[0])).toContain('undeclared')
      const declaresBefore = dh.declareSeries.mock.calls.length
      await prod.flushDue()
      expect(dh.declareSeries.mock.calls.length).toBeGreaterThan(declaresBefore)
      expect(dh.recordBuckets).toHaveBeenCalledTimes(2)
    })
  })
})
