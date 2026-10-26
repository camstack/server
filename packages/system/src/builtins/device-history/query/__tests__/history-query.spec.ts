import { DeviceType } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Harness, T0, makeHarness } from '../../__tests__/support/harness.js'
import type { RollupRow } from '../../rollup/rollup-math.js'
import { DAY_MS, FIVE_MINUTES_MS, HOUR_MS } from '../../time/bucket-time.js'
import type { QueryInput } from '../history-query.js'

let h: Harness
afterEach(async () => {
  vi.restoreAllMocks()
  await h.close()
})

const KEY = 'cap:battery.percentage'
const SUBJECT = { kind: 'device', deviceId: 1 } as const

function row(seriesId: number, bucketStart: number, mean: number): RollupRow {
  return {
    seriesId,
    bucketStart,
    samples: 2,
    sum: mean * 2,
    min: mean - 1,
    max: mean + 1,
    last: mean,
    lastTs: bucketStart + 1_000,
    twSum: mean * 1000,
    twMs: 1000,
    states: null,
  }
}

async function seed() {
  h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
  const series = await h.runtime.registry.ensure(KEY, SUBJECT, '', T0 - 400 * DAY_MS)
  return series
}

async function fill(
  seriesId: number,
  tier: '5m' | '1h' | '1d',
  width: number,
  from: number,
  to: number,
) {
  const rows: RollupRow[] = []
  for (let t = from; t < to; t += width) rows.push(row(seriesId, t, 50))
  await h.runtime.store.upsertRollups(tier, rows)
}

const query = (over: Partial<QueryInput>) =>
  h.runtime.query.query({
    key: KEY,
    subject: SUBJECT,
    from: T0 - HOUR_MS,
    to: T0,
    resolution: 'auto',
    maxPoints: 1000,
    ...over,
  })

describe('auto resolution', () => {
  it('uses raw while the raw points of the window fit', async () => {
    const s = await seed()
    await h.runtime.store.upsertRaw(
      Array.from({ length: 20 }, (_, i) => ({
        seriesId: s.id,
        ts: T0 - HOUR_MS + i * 60_000,
        value: i,
      })),
    )
    const out = await query({})
    expect(out.resolution).toBe('raw')
    expect(out.series[0]?.points).toHaveLength(20)
    expect(out.series[0]?.points[0]).toEqual({
      t: T0 - HOUR_MS,
      samples: 1,
      mean: 0,
      twMean: null,
      min: 0,
      max: 0,
      last: 0,
      delta: null,
      state: null,
      states: null,
    })
    expect(out.truncated).toBe(false)
  })

  it('falls to the 5-minute tier when the raw points exceed maxPoints', async () => {
    const s = await seed()
    const from = T0 - 33 * HOUR_MS
    await h.runtime.store.upsertRaw(
      Array.from({ length: 2000 }, (_, i) => ({ seriesId: s.id, ts: from + i * 60_000, value: i })),
    )
    await fill(s.id, '5m', FIVE_MINUTES_MS, from, T0)
    const out = await query({ from, maxPoints: 1000 })
    expect(out.resolution).toBe('5m')
    expect(out.series[0]?.points.length).toBeGreaterThan(300)
    expect(out.truncated).toBe(false)
  })

  it('skips a tier whose retention does not cover the window', async () => {
    const s = await seed()
    await fill(s.id, '1h', HOUR_MS, T0 - 30 * DAY_MS, T0)
    await fill(s.id, '1d', DAY_MS, T0 - 30 * DAY_MS, T0)
    const out = await query({ from: T0 - 30 * DAY_MS })
    // raw (7 d) and 5m (14 d) do not reach back 30 days; 1h does and 720 points fit
    expect(out.resolution).toBe('1h')
    expect(out.series[0]?.points).toHaveLength(720)
  })

  it('goes coarser when the finer tier would exceed maxPoints', async () => {
    const s = await seed()
    await fill(s.id, '1h', HOUR_MS, T0 - 30 * DAY_MS, T0)
    await fill(s.id, '1d', DAY_MS, T0 - 30 * DAY_MS, T0)
    const reads = vi.spyOn(h.runtime.store, 'readRollups')
    const out = await query({ from: T0 - 30 * DAY_MS, maxPoints: 100 })
    expect(out.resolution).toBe('1d')
    expect(out.series[0]?.points).toHaveLength(30)
    // 720 hourly buckets cannot fit 100 points: the hour tier is not even read.
    expect(reads.mock.calls.map((c) => c[0])).not.toContain('1h')
  })

  it('answers from the daily tier for a window older than a year', async () => {
    const s = await seed()
    await fill(s.id, '1d', DAY_MS, T0 - 700 * DAY_MS, T0 - 600 * DAY_MS)
    const out = await query({ from: T0 - 700 * DAY_MS, to: T0 - 600 * DAY_MS })
    expect(out.resolution).toBe('1d')
    expect(out.series[0]?.points).toHaveLength(100)
  })

  it('truncates the coarsest tier to its newest maxPoints, oldest first, and says so', async () => {
    const s = await seed()
    await fill(s.id, '1d', DAY_MS, T0 - 1200 * DAY_MS, T0)
    const out = await query({ from: T0 - 1200 * DAY_MS, maxPoints: 10 })
    expect(out.resolution).toBe('1d')
    expect(out.truncated).toBe(true)
    const points = out.series[0]?.points ?? []
    expect(points).toHaveLength(10)
    expect(points.map((p) => p.t)).toEqual([...points.map((p) => p.t)].sort((a, b) => a - b))
    expect(points[points.length - 1]?.t).toBeGreaterThan(T0 - 2 * DAY_MS)
  })
})

describe('auto resolution over a bucket-ingested series', () => {
  it('a 5-minute-bucket series over 24 h answers from the 5m tier, not an empty raw read', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    const { key } = await h.runtime.ingest.declareSeries('producer', {
      name: 'load',
      subjectKind: 'node',
      kind: 'gauge',
      displayName: 'Load',
      ingest: 'buckets',
    })
    const node = { kind: 'node', nodeId: 'agent-a' } as const
    const from = T0 - DAY_MS
    const buckets = Array.from({ length: 288 }, (_, i) => {
      const start = from + i * FIVE_MINUTES_MS
      return {
        key,
        subject: node,
        scope: '',
        bucketStart: start,
        samples: 1,
        sum: 3,
        min: 3,
        max: 3,
        last: 3,
        lastTs: start,
      }
    })
    const ingested = await h.runtime.ingest.recordBuckets('producer', buckets)
    expect(ingested.accepted).toBe(288)
    const out = await h.runtime.query.query({
      key,
      subject: node,
      from,
      to: T0,
      resolution: 'auto',
      maxPoints: 1000,
    })
    expect(out.resolution).toBe('5m')
    expect(out.series[0]?.points).toHaveLength(288)
  })
})

describe('explicit resolution and the point shape', () => {
  it('honours a requested tier and maps a rollup row to mean, twMean, min, max, last', async () => {
    const s = await seed()
    await fill(s.id, '5m', FIVE_MINUTES_MS, T0 - HOUR_MS, T0)
    const out = await query({ resolution: '5m' })
    expect(out.resolution).toBe('5m')
    expect(out.series[0]?.points[0]).toEqual({
      t: T0 - HOUR_MS,
      samples: 2,
      mean: 50,
      twMean: 50,
      min: 49,
      max: 51,
      last: 50,
      delta: null,
      state: null,
      states: null,
    })
  })

  it('reports the last point before the window so a step chart can start at the held value', async () => {
    const s = await seed()
    await h.runtime.store.upsertRaw([
      { seriesId: s.id, ts: T0 - 3 * HOUR_MS, value: 42 },
      { seriesId: s.id, ts: T0 - 30 * 60_000, value: 7 },
    ])
    const out = await query({ resolution: 'raw' })
    expect(out.series[0]?.before).toEqual({ t: T0 - 3 * HOUR_MS, value: 42, state: null })
    expect(out.series[0]?.points.map((p) => p.last)).toEqual([7])
  })

  it('returns every scope of a key, or just the one asked for', async () => {
    const s = await seed()
    const zone = await h.runtime.registry.ensure(KEY, SUBJECT, 'zone:a', T0 - 400 * DAY_MS)
    await h.runtime.store.upsertRaw([
      { seriesId: s.id, ts: T0 - 60_000, value: 1 },
      { seriesId: zone.id, ts: T0 - 60_000, value: 2 },
    ])
    const all = await query({ resolution: 'raw' })
    expect(all.series.map((x) => x.scope)).toEqual(['', 'zone:a'])
    const one = await query({ resolution: 'raw', scope: 'zone:a' })
    expect(one.series.map((x) => x.scope)).toEqual(['zone:a'])
    expect(one.series[0]?.points[0]?.last).toBe(2)
  })

  it('answers an empty series list, not an error, for a series that does not exist', async () => {
    await seed()
    const out = await query({ key: 'cap:nope.x' })
    expect(out.series).toEqual([])
  })
})

describe('listSeries', () => {
  it('lists the subject’s series with kind, display name, source and span', async () => {
    const s = await seed()
    await h.runtime.store.upsertRaw([{ seriesId: s.id, ts: T0, value: 1 }])
    await h.runtime.store.touchSeries([{ id: s.id, lastTs: T0 }])
    h.runtime.registry.noteSpan(s.id, T0 - 400 * DAY_MS, T0)
    const list = await h.runtime.query.listSeries(SUBJECT)
    expect(list).toEqual([
      {
        key: KEY,
        scope: '',
        kind: 'gauge',
        unit: '%',
        displayName: 'battery percentage',
        source: 'cap',
        values: null,
        firstTs: T0 - 400 * DAY_MS,
        lastTs: T0,
      },
    ])
  })

  it('keeps the span of a series across a restart (written by the flush, not just remembered)', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    h.runtime.capture.handleState(1, 'battery', { percentage: 80 }, T0)
    h.runtime.capture.handleState(1, 'battery', { percentage: 70 }, T0 + 60_000)
    await h.runtime.flushNow()
    await h.restart()
    const [info] = await h.runtime.query.listSeries(SUBJECT)
    expect(info?.firstTs).toBe(T0)
    expect(info?.lastTs).toBe(T0 + 60_000)
  })

  it('reports the catalog base unit, not a slice sibling', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor, 2: DeviceType.Sensor } })
    await h.runtime.registry.ensure('cap:weather.temperature', SUBJECT, '', T0)
    await h.runtime.registry.ensure(
      'cap:weather.temperature',
      { kind: 'device', deviceId: 2 },
      '',
      T0,
    )
    h.slices.set('1:weather', { temperature: 21 })
    const one = await h.runtime.query.listSeries(SUBJECT)
    expect(one[0]?.unit).toBe('°C')
    const two = await h.runtime.query.listSeries({ kind: 'device', deviceId: 2 })
    expect(two[0]?.unit).toBe('°C')
  })

  it('labels a numeric-sensor series with the device quantity base', async () => {
    h = await makeHarness({ devices: { 1: DeviceType.Sensor } })
    h.quantities.set(1, 'information')
    await h.runtime.registry.ensure('cap:numeric-sensor.value', SUBJECT, '', T0)
    const [info] = await h.runtime.query.listSeries(SUBJECT)
    expect(info?.unit).toBe('B')
  })
})
