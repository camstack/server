import { DeviceType } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Harness, T0, makeHarness } from '../../__tests__/support/harness.js'
import type { RollupRow } from '../../rollup/rollup-math.js'
import { DAY_MS } from '../../time/bucket-time.js'
import { silentLogger } from '../../__tests__/support/real-door.js'
import { DEFAULT_RETENTION, RetentionJob, retentionCutoffs } from '../retention.js'

let h: Harness
afterEach(async () => {
  await h.close()
})

const SUBJECT = { kind: 'device', deviceId: 1 } as const
const KEY = 'cap:battery.level'

function row(seriesId: number, bucketStart: number): RollupRow {
  return {
    seriesId,
    bucketStart,
    samples: 1,
    sum: 1,
    min: 1,
    max: 1,
    last: 1,
    lastTs: bucketStart,
    twSum: null,
    twMs: null,
    states: null,
  }
}

async function seedAround(cutoffs: ReturnType<typeof retentionCutoffs>) {
  const raw = cutoffs.raw ?? 0
  const m5 = cutoffs['5m'] ?? 0
  const h1 = cutoffs['1h'] ?? 0
  // First seen long before every cutoff (and every row below), so each tier visits it.
  const series = await h.runtime.registry.ensure(KEY, SUBJECT, '', T0 - 4000 * DAY_MS)
  await h.runtime.store.upsertRaw([
    { seriesId: series.id, ts: raw - 1, value: 1 },
    { seriesId: series.id, ts: raw, value: 2 },
    { seriesId: series.id, ts: raw + 1, value: 3 },
  ])
  await h.runtime.store.upsertRollups(
    '5m',
    [m5 - 1, m5, m5 + 1].map((t) => row(series.id, t)),
  )
  await h.runtime.store.upsertRollups(
    '1h',
    [h1 - 1, h1, h1 + 1].map((t) => row(series.id, t)),
  )
  await h.runtime.store.upsertRollups(
    '1d',
    [T0 - 3650 * DAY_MS, T0 - 400 * DAY_MS].map((t) => row(series.id, t)),
  )
  return series
}

describe('retention boundaries per tier', () => {
  it('deletes strictly older than the cutoff of each tier and keeps the day tier forever', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    const now = h.now()
    const cutoffs = retentionCutoffs(DEFAULT_RETENTION, now)
    expect(cutoffs).toEqual({
      raw: now - 7 * DAY_MS,
      '5m': now - 30 * DAY_MS,
      '1h': now - 365 * DAY_MS,
      '1d': null,
    })
    const series = await seedAround(cutoffs)
    await h.runtime.retentionJob.run(DEFAULT_RETENTION, now)

    const raw = await h.runtime.store.readRaw(series.id, 0, Number.MAX_SAFE_INTEGER, 100)
    expect(raw.map((p) => p.ts)).toEqual([cutoffs.raw ?? 0, (cutoffs.raw ?? 0) + 1])
    const m5 = await h.runtime.store.readRollups('5m', series.id, 0, Number.MAX_SAFE_INTEGER, 100)
    expect(m5.map((r) => r.bucketStart)).toEqual([cutoffs['5m'] ?? 0, (cutoffs['5m'] ?? 0) + 1])
    const h1 = await h.runtime.store.readRollups('1h', series.id, 0, Number.MAX_SAFE_INTEGER, 100)
    expect(h1.map((r) => r.bucketStart)).toEqual([cutoffs['1h'] ?? 0, (cutoffs['1h'] ?? 0) + 1])
    const d1 = await h.runtime.store.readRollups('1d', series.id, 0, Number.MAX_SAFE_INTEGER, 100)
    expect(d1).toHaveLength(2)

    expect(h.runtime.status().retention.deleted).toEqual({ raw: 1, '5m': 1, '1h': 1 })
    expect(h.runtime.status().retention.lastRunAt).toBe(now)
  })

  it('applies a configured day retention', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    const policy = { ...DEFAULT_RETENTION, dayDays: 1000 }
    const series = await seedAround(retentionCutoffs(policy, h.now()))
    await h.runtime.retentionJob.run(policy, h.now())
    const d1 = await h.runtime.store.readRollups('1d', series.id, 0, Number.MAX_SAFE_INTEGER, 100)
    expect(d1.map((r) => r.bucketStart)).toEqual([T0 - 400 * DAY_MS])
  })

  it('visits a series again only after the cutoff has moved on by a step', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    const series = await seedAround(retentionCutoffs(DEFAULT_RETENTION, h.now()))
    await h.runtime.retentionJob.run(DEFAULT_RETENTION, h.now())
    const cutoff = retentionCutoffs(DEFAULT_RETENTION, h.now()).raw ?? 0
    await h.runtime.store.upsertRaw([{ seriesId: series.id, ts: cutoff - 5_000, value: 9 }])
    // Ten minutes later: inside the one-hour step, so the straggler is still there.
    h.advance(10 * 60_000)
    await h.runtime.retentionJob.run(DEFAULT_RETENTION, h.now())
    expect((await h.runtime.store.readRaw(series.id, 0, cutoff - 1, 10)).length).toBe(1)
    // An hour later: visited again, gone.
    h.advance(60 * 60_000)
    await h.runtime.retentionJob.run(DEFAULT_RETENTION, h.now())
    expect(await h.runtime.store.readRaw(series.id, 0, cutoff - 1, 10)).toEqual([])
  })
})

describe('purging the series of a departed device (D49)', () => {
  const DAYS = DAY_MS

  async function twoDevices() {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    const now = h.now()
    // Both series are STABLE: change-only capture wrote them a month ago and nothing since.
    const stable = await h.runtime.registry.ensure(KEY, SUBJECT, '', now - 30 * DAYS)
    const other = await h.runtime.registry.ensure(
      KEY,
      { kind: 'device', deviceId: 99 },
      '',
      now - 30 * DAYS,
    )
    for (const s of [stable, other]) {
      await h.runtime.store.upsertRaw([{ seriesId: s.id, ts: now - 30 * DAYS, value: 1 }])
    }
    return { now, stable, other }
  }

  it('a partial but SUCCESSFUL listing, and a stable old series, purge nothing', async () => {
    const { now, other } = await twoDevices()
    // The provider of device 99 is still booting: the listing answers, without it.
    await h.runtime.departures.observe(new Set([1]), now)
    await h.runtime.retentionJob.run(DEFAULT_RETENTION, now)
    expect(h.runtime.registry.byIdOf(other.id)).toBeDefined()
    // Still missing six days later: the clock has not run out.
    await h.runtime.departures.observe(new Set([1]), now + 6 * DAYS)
    await h.runtime.retentionJob.run(DEFAULT_RETENTION, now + 6 * DAYS)
    expect(h.runtime.registry.byIdOf(other.id)).toBeDefined()
    expect(h.runtime.status().retention.purgedSeries).toBe(0)
  })

  it('a device that comes back restarts the clock, however old its series is', async () => {
    const { now, other } = await twoDevices()
    await h.runtime.departures.observe(new Set([1]), now)
    expect(h.runtime.departures.missingSince(99)).toBe(now)
    await h.runtime.departures.observe(new Set([1, 99]), now + 6 * DAYS)
    expect(h.runtime.departures.missingSince(99)).toBeUndefined()
    await h.runtime.retentionJob.run(DEFAULT_RETENTION, now + 30 * DAYS)
    expect(h.runtime.registry.byIdOf(other.id)).toBeDefined()
  })

  it('purges only a series whose device was absent from every listing for a week', async () => {
    const { now, stable, other } = await twoDevices()
    await h.runtime.departures.observe(new Set([1]), now)
    await h.runtime.departures.observe(new Set([1]), now + 7 * DAYS)
    await h.runtime.retentionJob.run(DEFAULT_RETENTION, now + 7 * DAYS)
    expect(h.runtime.registry.byIdOf(other.id)).toBeUndefined()
    expect(h.runtime.registry.byIdOf(stable.id)).toBeDefined()
    expect(await h.runtime.store.readRaw(other.id, 0, Number.MAX_SAFE_INTEGER, 10)).toEqual([])
    expect(await h.runtime.store.findSeries(KEY, 'd:99', '')).toBeNull()
    expect(h.runtime.status().retention.purgedSeries).toBe(1)
  })

  it('a DELETE (tombstone) purges the device now; an unregistered device is untouched (D865)', async () => {
    const { now, stable, other } = await twoDevices()
    // Absent from the listing is NOT deleted: nothing happens on a miss.
    await h.runtime.departures.observe(new Set([1]), now)
    await h.runtime.retentionJob.run(DEFAULT_RETENTION, now)
    expect(h.runtime.registry.byIdOf(other.id)).toBeDefined()

    // The removal hook is told the device was deleted.
    expect(await h.runtime.removeDevice(99)).toEqual({ series: 1 })

    expect(h.runtime.registry.byIdOf(other.id)).toBeUndefined()
    expect(h.runtime.registry.byIdOf(stable.id)).toBeDefined()
    expect(await h.runtime.store.findSeries(KEY, 'd:99', '')).toBeNull()
    expect(h.runtime.departures.missingSince(99)).toBeUndefined()
    // Idempotent: the reconcile may call it again.
    expect(await h.runtime.removeDevice(99)).toEqual({ series: 0 })
  })

  it('keeps the clock across a restart: it neither resets to now nor reads as old', async () => {
    const { now } = await twoDevices()
    await h.runtime.departures.observe(new Set([1]), now)
    // A day passes before the restart, so a clock re-armed at boot would read now + 1 d.
    h.setNow(now + DAYS)
    await h.restart()
    expect(h.runtime.departures.missingSince(99)).toBe(now)
    // A listing made the day after the restart does not move it.
    h.setNow(now + DAYS)
    await h.runtime.departures.observe(new Set([1]), now + DAYS)
    expect(h.runtime.departures.missingSince(99)).toBe(now)
  })

  it('a failed listing moves no clock', async () => {
    const { now } = await twoDevices()
    h.devices.clear()
    const listAll = vi.spyOn(h.runtime.directory, 'refresh').mockResolvedValue(false)
    await h.runtime.reconcile()
    expect(listAll).toHaveBeenCalled()
    expect(h.runtime.departures.missingSince(99)).toBeUndefined()
    void now
  })

  it('leaves no state behind for a purged series', async () => {
    const { now, other } = await twoDevices()
    h.devices.set(99, DeviceType.Sensor)
    await h.runtime.directory.ensure(99)
    h.devices.delete(99)
    h.runtime.capture.handleState(99, 'battery', { level: 5 }, now)
    expect(h.runtime.capture.lastRecorded(KEY, 'd:99')).toBeDefined()
    await h.runtime.departures.observe(new Set([1]), now)
    await h.runtime.departures.observe(new Set([1]), now + 8 * DAYS)
    await h.runtime.retentionJob.run(DEFAULT_RETENTION, now + 8 * DAYS)
    expect(h.runtime.registry.byIdOf(other.id)).toBeUndefined()
    expect(h.runtime.capture.lastRecorded(KEY, 'd:99')).toBeUndefined()
    expect(h.runtime.rollup.dirtyCounts().m5).toBe(0)
  })
})

describe('deletes are sliced by time with a yield between slices', () => {
  it('retention deletes a long backlog one day per statement', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    const now = h.now()
    const cutoff = retentionCutoffs(DEFAULT_RETENTION, now).raw ?? 0
    const series = await h.runtime.registry.ensure(KEY, SUBJECT, '', cutoff - 6 * DAY_MS)
    await h.runtime.store.upsertRaw(
      Array.from({ length: 6 }, (_, i) => ({
        seriesId: series.id,
        ts: cutoff - (i + 1) * DAY_MS + 5,
        value: i,
      })),
    )
    const yields: number[] = []
    const job = new RetentionJob({
      store: h.runtime.store,
      registry: h.runtime.registry,
      departures: h.runtime.departures,
      counters: h.runtime.counters,
      logger: silentLogger(),
      yieldNow: async () => {
        yields.push(1)
      },
    })
    const spy = vi.spyOn(h.runtime.store, 'deleteRange')
    await job.run(DEFAULT_RETENTION, now)
    const raw = spy.mock.calls.filter((c) => c[0] === 'raw')
    expect(raw.length).toBeGreaterThanOrEqual(6)
    for (const [, , lo, hi] of raw) expect(hi - lo + 1).toBeLessThanOrEqual(DAY_MS)
    expect(yields.length).toBeGreaterThanOrEqual(raw.length)
    expect(await h.runtime.store.readRaw(series.id, 0, cutoff - 1, 100)).toEqual([])
  })

  it('purging a series deletes tier by tier in slices before the series row', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    const now = h.now()
    const gone = await h.runtime.registry.ensure(
      KEY,
      { kind: 'device', deviceId: 99 },
      '',
      now - 5 * DAY_MS,
    )
    await h.runtime.store.upsertRaw(
      Array.from({ length: 5 }, (_, i) => ({
        seriesId: gone.id,
        ts: now - (i + 1) * DAY_MS,
        value: i,
      })),
    )
    await h.runtime.departures.observe(new Set([1]), now - 8 * DAY_MS)
    const spy = vi.spyOn(h.runtime.store, 'deleteRange')
    await h.runtime.retentionJob.run(DEFAULT_RETENTION, now)
    expect(h.runtime.registry.byIdOf(gone.id)).toBeUndefined()
    const raw = spy.mock.calls.filter((c) => c[0] === 'raw' && c[1] === gone.id)
    expect(raw.length).toBeGreaterThanOrEqual(5)
    for (const [, , lo, hi] of raw) expect(hi - lo + 1).toBeLessThanOrEqual(DAY_MS)
  })
})
