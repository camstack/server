/**
 * The rollup engine over a real `history.db`. The zone is pinned BEFORE any date
 * is built: the day tier is hub-local, and a spec that passed only in the zone
 * of the machine running it would prove nothing about DST days.
 */
import { DeviceType } from '@camstack/types'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { type Harness, T0, makeHarness } from '../../__tests__/support/harness.js'
import { emitState, rollupOf, seriesOf } from '../../__tests__/support/read-helpers.js'
import type { HistoryCatalog } from '../../capture/capture-engine.js'
import { FIVE_MINUTES_MS, HOUR_MS } from '../../time/bucket-time.js'

const originalTz = process.env['TZ']
beforeAll(() => {
  process.env['TZ'] = 'Europe/Rome'
})
afterAll(() => {
  if (originalTz === undefined) delete process.env['TZ']
  else process.env['TZ'] = originalTz
})

let h: Harness
afterEach(async () => {
  await h.close()
})

const CATALOG: HistoryCatalog = {
  probe: { v: { kind: 'gauge', unit: 'count', minIntervalMs: 0 } },
}
const KEY = 'cap:probe.v'
const DEVICES = { 1: DeviceType.Sensor }
/** Past a 5-minute bucket's close plus its grace. */
const CLOSED_5M = FIVE_MINUTES_MS + 31_000

describe('5-minute rollup of a point series', () => {
  it('weights by time: 4m59s at 50 then 1s at 100 is a tw mean of ~50, not 75', async () => {
    h = await makeHarness({ catalog: CATALOG, devices: DEVICES })
    emitState(h, 1, 'probe', { v: 50 })
    h.advance(FIVE_MINUTES_MS - 1_000)
    emitState(h, 1, 'probe', { v: 100 })
    h.advance(1_000 + 31_000)
    await h.settle()
    const [row] = await rollupOf(h, '5m', KEY, 1)
    expect(row).toMatchObject({
      bucketStart: T0,
      samples: 2,
      sum: 150,
      min: 50,
      max: 100,
      last: 100,
    })
    expect(row?.twMs).toBe(FIVE_MINUTES_MS)
    expect(row?.twSum).toBe(50 * (FIVE_MINUTES_MS - 1_000) + 100 * 1_000)
    expect((row?.twSum ?? 0) / (row?.twMs ?? 1)).toBeCloseTo(50.17, 2)
  })

  it('does not roll a bucket up before it has closed and its grace has passed', async () => {
    h = await makeHarness({ catalog: CATALOG, devices: DEVICES })
    emitState(h, 1, 'probe', { v: 5 })
    h.advance(FIVE_MINUTES_MS + 10_000)
    await h.settle()
    expect(await rollupOf(h, '5m', KEY, 1)).toHaveLength(0)
    h.advance(25_000)
    await h.settle()
    expect(await rollupOf(h, '5m', KEY, 1)).toHaveLength(1)
  })

  it('rebuilds the still-open bucket from raw after a restart, then replaces it when it closes', async () => {
    h = await makeHarness({ catalog: CATALOG, devices: DEVICES })
    h.advance(10_000)
    emitState(h, 1, 'probe', { v: 5 })
    h.advance(90_000)
    emitState(h, 1, 'probe', { v: 7 })
    h.advance(20_000)
    await h.settle()
    expect(await rollupOf(h, '5m', KEY, 1)).toHaveLength(0)

    await h.restart()
    const [open] = await rollupOf(h, '5m', KEY, 1)
    expect(open).toMatchObject({ bucketStart: T0, samples: 2, sum: 12, last: 7 })
    // time-weighted up to NOW (T0+120s), from the first point (T0+10s)
    expect(open?.twMs).toBe(110_000)

    h.advance(CLOSED_5M)
    await h.settle()
    const [closed] = await rollupOf(h, '5m', KEY, 1)
    expect(closed?.twMs).toBe(FIVE_MINUTES_MS - 10_000)
    expect(await rollupOf(h, '5m', KEY, 1)).toHaveLength(1)
  })

  it('is idempotent: recomputing a closed bucket gives the same row', async () => {
    h = await makeHarness({ catalog: CATALOG, devices: DEVICES })
    emitState(h, 1, 'probe', { v: 3 })
    h.advance(CLOSED_5M)
    await h.settle()
    const before = await rollupOf(h, '5m', KEY, 1)
    const series = seriesOf(h, KEY, 1)
    await h.runtime.rollup.recomputeFiveMinute(series?.id ?? -1, T0, T0 + FIVE_MINUTES_MS, h.now())
    expect(await rollupOf(h, '5m', KEY, 1)).toEqual(before)
  })
})

describe('1h and 1d rollups', () => {
  it('credits quiet buckets with the held value: 55 min at 10 then 5 min at 100', async () => {
    h = await makeHarness({ catalog: CATALOG, devices: DEVICES })
    emitState(h, 1, 'probe', { v: 10 })
    h.advance(55 * 60_000)
    emitState(h, 1, 'probe', { v: 100 })
    h.advance(5 * 60_000 + 5 * 60_000 + 1_000)
    await h.settle()
    await h.settle()
    const [hour] = await rollupOf(h, '1h', KEY, 1)
    expect(hour).toMatchObject({ bucketStart: T0, samples: 2, min: 10, max: 100, last: 100 })
    expect(hour?.twMs).toBe(HOUR_MS)
    expect((hour?.twSum ?? 0) / (hour?.twMs ?? 1)).toBeCloseTo((10 * 55 + 100 * 5) / 60, 6)
  })

  it('rolls a hub-local day (Europe/Rome) from the hours at local midnight + grace', async () => {
    h = await makeHarness({ catalog: CATALOG, devices: DEVICES })
    emitState(h, 1, 'probe', { v: 10 })
    h.advance(55 * 60_000)
    emitState(h, 1, 'probe', { v: 100 })
    // 2026-10-14 10:00Z is 12:00 CEST; the local day ends 2026-10-14T22:00Z.
    const localMidnightStart = Date.UTC(2026, 9, 13, 22, 0, 0)
    const localMidnightEnd = Date.UTC(2026, 9, 14, 22, 0, 0)
    h.setNow(localMidnightEnd + 14 * 60_000)
    await h.settle()
    expect(await rollupOf(h, '1d', KEY, 1)).toHaveLength(0)
    h.setNow(localMidnightEnd + 16 * 60_000)
    await h.settle()
    await h.settle()
    const [day] = await rollupOf(h, '1d', KEY, 1)
    expect(day?.bucketStart).toBe(localMidnightStart)
    expect(day).toMatchObject({ samples: 2, min: 10, max: 100, last: 100 })
    // 12 h with no data before the first point, then the hour row, then the held 100 to midnight
    expect(day?.twMs).toBe(HOUR_MS + 11 * HOUR_MS)
  })
})

describe('producer buckets and late writes', () => {
  const DECLARE = {
    name: 'load',
    subjectKind: 'node',
    kind: 'gauge',
    displayName: 'Load',
    ingest: 'buckets',
  } as const
  const NODE = { kind: 'node', nodeId: 'hub' } as const

  function bucket(start: number, samples: number, sum: number) {
    return {
      key: 'addon:prod/load',
      subject: NODE,
      scope: '',
      bucketStart: start,
      samples,
      sum,
      min: sum / samples,
      max: sum / samples,
      last: sum / samples,
      lastTs: start + 1_000,
    }
  }

  async function nodeRows(tier: '5m' | '1h' | '1d') {
    const series = h.runtime.registry.find('addon:prod/load', 'n:hub', '')
    if (series === undefined) return []
    return h.runtime.store.readRollups(tier, series.id, 0, Number.MAX_SAFE_INTEGER, 1000)
  }

  it('recordBuckets twice leaves one row with the same values', async () => {
    h = await makeHarness({ catalog: CATALOG })
    await h.runtime.ingest.declareSeries('prod', DECLARE)
    const b = bucket(T0, 4, 40)
    const first = await h.runtime.ingest.recordBuckets('prod', [b])
    const second = await h.runtime.ingest.recordBuckets('prod', [b])
    expect(first.accepted).toBe(1)
    expect(second.accepted).toBe(1)
    const rows = await nodeRows('5m')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ bucketStart: T0, samples: 4, sum: 40, twSum: null, twMs: null })
  })

  it('recomputes an hour and its day after a late bucket lands in an already rolled hour', async () => {
    h = await makeHarness({ catalog: CATALOG })
    await h.runtime.ingest.declareSeries('prod', DECLARE)
    await h.runtime.ingest.recordBuckets('prod', [bucket(T0, 1, 10)])
    const dayEnd = Date.UTC(2026, 9, 14, 22, 0, 0)
    h.setNow(dayEnd + 16 * 60_000)
    await h.settle()
    await h.settle()
    expect((await nodeRows('1h'))[0]).toMatchObject({ bucketStart: T0, samples: 1, sum: 10 })
    expect((await nodeRows('1d'))[0]).toMatchObject({ samples: 1, sum: 10 })

    // A producer's retry lands a bucket in the hour that was already rolled.
    await h.runtime.ingest.recordBuckets('prod', [bucket(T0 + 2 * FIVE_MINUTES_MS, 3, 60)])
    await h.settle()
    await h.settle()
    expect((await nodeRows('1h'))[0]).toMatchObject({
      bucketStart: T0,
      samples: 4,
      sum: 70,
      max: 20,
    })
    expect((await nodeRows('1d'))[0]).toMatchObject({ samples: 4, sum: 70 })
    expect(await nodeRows('1h')).toHaveLength(1)
    expect(await nodeRows('1d')).toHaveLength(1)
  })

  it('never rolls a bucket-ingested series up from raw', async () => {
    h = await makeHarness({ catalog: CATALOG })
    await h.runtime.ingest.declareSeries('prod', DECLARE)
    await h.runtime.ingest.recordBuckets('prod', [bucket(T0, 2, 20)])
    h.advance(CLOSED_5M)
    await h.settle()
    await h.restart()
    expect(await nodeRows('5m')).toHaveLength(1)
    const series = h.runtime.registry.find('addon:prod/load', 'n:hub', '')
    expect(await h.runtime.store.readRaw(series?.id ?? -1, 0, Number.MAX_SAFE_INTEGER, 10)).toEqual(
      [],
    )
    expect((await nodeRows('5m'))[0]).toMatchObject({ samples: 2, sum: 20 })
  })
})
