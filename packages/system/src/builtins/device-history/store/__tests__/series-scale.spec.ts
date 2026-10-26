import { describe, expect, it } from 'vitest'
import { openRealDoor } from '../../__tests__/support/real-door.js'
import { HistoryStore } from '../history-store.js'
import { SeriesRegistry } from '../series-registry.js'
import {
  DAY_TO_SECONDS,
  DESICCANT_LEGACY_MAX_DAYS,
  GIB_TO_BYTES,
  INFORMATION_LEGACY_MAX,
  rollupIsLegacy,
  scaledMagnitude,
  unraidInformationScale,
} from '../series-scale.js'

describe('scaledMagnitude', () => {
  it('multiplies a day count into seconds and leaves a second count', () => {
    expect(scaledMagnitude(20, DAY_TO_SECONDS, DESICCANT_LEGACY_MAX_DAYS)).toBe(20 * DAY_TO_SECONDS)
    expect(scaledMagnitude(20 * DAY_TO_SECONDS, DAY_TO_SECONDS, DESICCANT_LEGACY_MAX_DAYS)).toBe(
      20 * DAY_TO_SECONDS,
    )
  })

  it('multiplies GiB into bytes and leaves a byte count', () => {
    expect(scaledMagnitude(12, GIB_TO_BYTES, INFORMATION_LEGACY_MAX)).toBe(12 * GIB_TO_BYTES)
    expect(scaledMagnitude(12 * GIB_TO_BYTES, GIB_TO_BYTES, INFORMATION_LEGACY_MAX)).toBe(
      12 * GIB_TO_BYTES,
    )
  })

  it('leaves zero', () => {
    expect(scaledMagnitude(0, GIB_TO_BYTES, INFORMATION_LEGACY_MAX)).toBe(0)
  })
})

describe('rollupIsLegacy', () => {
  it('treats a bucket as legacy from min, max and last, not from the sum', () => {
    expect(rollupIsLegacy({ min: 10, max: 12, last: 11 }, INFORMATION_LEGACY_MAX)).toBe(true)
    expect(
      rollupIsLegacy({ min: 10, max: 12 * GIB_TO_BYTES, last: 11 }, INFORMATION_LEGACY_MAX),
    ).toBe(false)
  })
})

describe('HistoryStore.scaleSeries', () => {
  it('rewrites a day count to seconds once, through the history connection', async () => {
    const rd = await openRealDoor()
    try {
      const store = new HistoryStore(rd.door)
      await store.declare()
      const registry = new SeriesRegistry(store)
      await registry.load()
      const series = await registry.ensure(
        'cap:pet-feeder.desiccantLeftDays',
        { kind: 'device', deviceId: 3 },
        '',
        1_000,
      )
      await store.upsertRaw([{ seriesId: series.id, ts: 1_000, value: 20 }])
      await store.scaleSeries(series.id, DAY_TO_SECONDS, DESICCANT_LEGACY_MAX_DAYS)
      await store.scaleSeries(series.id, DAY_TO_SECONDS, DESICCANT_LEGACY_MAX_DAYS)
      const rows = await store.readRaw(series.id, 0, 10_000, 10)
      expect(rows[0]?.value).toBe(20 * DAY_TO_SECONDS)
    } finally {
      await rd.close()
    }
  })
})

describe('unraidInformationScale', () => {
  it('names only the array byte counters', () => {
    expect(unraidInformationScale(4, 'array_used')?.factor).toBe(GIB_TO_BYTES)
    expect(unraidInformationScale(4, 'array_usage')).toBeNull()
  })
})
