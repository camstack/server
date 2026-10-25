import { DeviceType } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Harness, T0, makeHarness } from '../../__tests__/support/harness.js'
import { emitState, rawOf } from '../../__tests__/support/read-helpers.js'
import { MAX_BUFFER_AGE_MS, MAX_QUEUE_POINTS } from '../../capture/point-writer.js'
import { FIVE_MINUTES_MS, HOUR_MS } from '../../time/bucket-time.js'

let h: Harness
afterEach(async () => {
  vi.restoreAllMocks()
  await h.close()
})

const BATTERY = 'cap:battery.percentage'

describe('a dropped point is forgotten, so the next reconcile re-emits it', () => {
  it('evicts the "recorded" value of points the store never took', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    emitState(h, 1, 'battery', { percentage: 80 })
    const failing = vi.spyOn(h.runtime.store, 'upsertRaw').mockRejectedValue(new Error('down'))
    h.advance(MAX_BUFFER_AGE_MS + 1_000)
    await h.runtime.flushNow()
    expect(h.runtime.status().capture.pointsDropped).toBe(1)
    expect(h.runtime.capture.lastRecorded(BATTERY, 'd:1')).toBeUndefined()

    failing.mockRestore()
    h.setSnapshots({ '1': { battery: { percentage: 80 } } })
    await h.runtime.reconcile()
    await h.settle()
    // Without the eviction the unchanged 80 would be "already recorded" and the hole would stay.
    expect((await rawOf(h, BATTERY, 1)).map((p) => p.value)).toEqual([80])
  })

  it('names each device on a tagged line, capped per drop event', async () => {
    const devices = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [i + 1, DeviceType.Sensor]),
    )
    h = await makeHarness({ devices })
    vi.spyOn(h.runtime.store, 'upsertRaw').mockRejectedValue(new Error('down'))
    for (let id = 1; id <= 12; id++) emitState(h, id, 'battery', { percentage: 80 })
    h.advance(MAX_BUFFER_AGE_MS + 1_000)
    await h.runtime.flushNow()
    const tagged = h.logs.filter((l) => l.level === 'warn' && l.tags['deviceId'] !== undefined)
    expect(tagged).toHaveLength(10)
    expect(h.logs.filter((l) => l.level === 'error')).toHaveLength(1)
    expect(h.runtime.status().capture.pointsDropped).toBe(12)
  })
})

describe('the queue is bounded while a flush hangs', () => {
  it('drops the OLDEST points past the cap and says so', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    const subject = { kind: 'device', deviceId: 1 } as const
    for (let i = 0; i <= MAX_QUEUE_POINTS; i++) {
      h.runtime.writer.enqueue({ key: BATTERY, subject, scope: '', ts: T0 + i, value: i })
    }
    const status = h.runtime.status()
    expect(status.capture.pointsDropped).toBe(MAX_QUEUE_POINTS / 10)
    expect(status.capture.bufferDepth).toBe(MAX_QUEUE_POINTS + 1 - MAX_QUEUE_POINTS / 10)
    const error = h.logs.find((l) => l.level === 'error')
    expect(error?.meta['reason']).toBe('queue full')
    expect(error?.meta['dropped']).toBe(MAX_QUEUE_POINTS / 10)
  })
})

describe('one aggregated INFO per pass (D391)', () => {
  it('names the skips, refusals, deletes and flush failures since the last report, then goes quiet', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Hub, 2: DeviceType.Camera } })
    emitState(h, 1, 'battery', { percentage: 1 })
    emitState(h, 2, 'motion', { detected: true })
    await h.runtime.ingest.record('nobody', [
      { key: 'addon:x/y', subject: { kind: 'node', nodeId: 'hub' }, scope: '', ts: T0, value: 1 },
    ])
    vi.spyOn(h.runtime.store, 'upsertRaw').mockRejectedValueOnce(new Error('disk'))
    emitState(h, 2, 'battery', { percentage: 5 })
    await h.runtime.flushNow()

    h.runtime.reportWindow()
    const infos = h.logs.filter(
      (l) => l.level === 'info' && l.message.includes('since the last report'),
    )
    expect(infos).toHaveLength(1)
    expect(infos[0]?.meta).toMatchObject({
      skipped: { 'not-a-real-device': 1, 'excluded-device-type': 1 },
      refused: { undeclared: 1 },
      flushFailures: 1,
    })
    h.runtime.reportWindow()
    expect(h.logs.filter((l) => l.message.includes('since the last report'))).toHaveLength(1)
  })
})

describe('row counts move with the writes instead of rescanning', () => {
  it('counts once, then follows writes and deletes without another scan', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    emitState(h, 1, 'battery', { percentage: 50 })
    await h.settle()
    const count = vi.spyOn(h.runtime.store, 'countRows')
    await h.runtime.refreshCounts()
    expect(count).toHaveBeenCalledTimes(4)
    const raw = (): number | null =>
      h.runtime.status().tiers.find((t) => t.tier === 'raw')?.rows ?? null
    expect(raw()).toBe(1)

    h.advance(60_000)
    emitState(h, 1, 'battery', { percentage: 40 })
    await h.settle()
    expect(raw()).toBe(2)
    h.advance(31_000 + FIVE_MINUTES_MS)
    await h.settle()
    const five = (): number | null =>
      h.runtime.status().tiers.find((t) => t.tier === '5m')?.rows ?? null
    expect(five()).toBeGreaterThanOrEqual(1)
    expect(count).toHaveBeenCalledTimes(4)

    // retention takes the raw rows away: the estimate follows
    const series = h.runtime.registry.all()[0]
    expect(series).toBeDefined()
    await h.runtime.retentionJob.run(
      { rawDays: 1, fiveMinuteDays: 14, hourDays: 365, dayDays: null },
      h.now() + 10 * 86_400_000,
    )
    expect(raw()).toBe(0)
    void HOUR_MS
  })
})

describe('a re-mark during a recompute is not erased', () => {
  it('keeps an hour dirty when a late bucket renews its mark while the recompute awaits', async () => {
    h = await makeHarness()
    await h.runtime.ingest.declareSeries('prod', {
      name: 'load',
      subjectKind: 'node',
      kind: 'gauge',
      displayName: 'Load',
      ingest: 'buckets',
    })
    const node = { kind: 'node', nodeId: 'hub' } as const
    const bucket = (start: number) => ({
      key: 'addon:prod/load',
      subject: node,
      scope: '',
      bucketStart: start,
      samples: 1,
      sum: 1,
      min: 1,
      max: 1,
      last: 1,
      lastTs: start,
    })
    await h.runtime.ingest.recordBuckets('prod', [bucket(T0)])
    const series = h.runtime.registry.find('addon:prod/load', 'n:hub', '')
    const real = h.runtime.store.upsertRollups.bind(h.runtime.store)
    vi.spyOn(h.runtime.store, 'upsertRollups').mockImplementation(async (tier, rows) => {
      if (tier === '1h') h.runtime.rollup.markFiveMinuteRow(series?.id ?? -1, T0 + FIVE_MINUTES_MS)
      await real(tier, rows)
    })
    h.setNow(T0 + HOUR_MS + 6 * 60_000)
    await h.runtime.rollup.tick()
    // the hour was recomputed once, and the renewed mark survived the clean-up
    expect(h.runtime.rollup.dirtyCounts().h1).toBe(1)
  })
})
