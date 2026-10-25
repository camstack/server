/**
 * `enum` series end to end, over a real history.db: a state is stored as the
 * ordinal of its value, change-only; the 5-minute rollup keeps the time spent
 * in each state; a query names the states; the value list is append-only, so a
 * reordered `z.enum` or a restart never changes what a stored ordinal means.
 */
import { DEVICE_HISTORY_ENERGY_KEY, DeviceType } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { type Harness, T0, makeHarness } from '../../__tests__/support/harness.js'
import { emitState, rawOf, rollupOf } from '../../__tests__/support/read-helpers.js'
import { MAX_ENUM_VALUES } from '../../store/series-registry.js'
import { FIVE_MINUTES_MS } from '../../time/bucket-time.js'
import type { HistoryCatalog } from '../capture-engine.js'

let h: Harness
afterEach(async () => {
  await h.close()
})

const LOCK = 'cap:lock-control.state'
const SENSOR = 'cap:enum-sensor.value'
const CATALOG: HistoryCatalog = {
  'lock-control': {
    state: { kind: 'enum', values: ['locked', 'unlocked', 'locking', 'unlocking', 'jammed'] },
  },
  'enum-sensor': { value: { kind: 'enum', skipWhenSet: 'format' } },
}

async function lockHarness(catalog: HistoryCatalog = CATALOG): Promise<Harness> {
  return makeHarness({ catalog, devices: { 1: DeviceType.Lock, 2: DeviceType.Sensor } })
}

describe('enum capture', () => {
  it('stores each change as the ordinal of its value, and only changes', async () => {
    h = await lockHarness()
    emitState(h, 1, 'lock-control', { state: 'locked' })
    h.advance(60_000)
    emitState(h, 1, 'lock-control', { state: 'locked' })
    h.advance(1_000)
    emitState(h, 1, 'lock-control', { state: 'unlocked' })
    h.advance(1_000)
    emitState(h, 1, 'lock-control', { state: 'jammed' })
    await h.settle()
    expect((await rawOf(h, LOCK, 1)).map((p) => p.value)).toEqual([0, 1, 4])
  })

  it('a 5-minute bucket keeps the time in each state, and the query names them', async () => {
    h = await lockHarness()
    emitState(h, 1, 'lock-control', { state: 'locked' })
    h.advance(60_000)
    emitState(h, 1, 'lock-control', { state: 'unlocked' })
    h.advance(FIVE_MINUTES_MS)
    await h.settle()
    h.advance(60_000)
    await h.runtime.rollup.tick()
    const [row] = await rollupOf(h, '5m', LOCK, 1)
    expect(row?.states).toEqual({ '0': 60_000, '1': FIVE_MINUTES_MS - 60_000 })

    const out = await h.runtime.query.query({
      key: LOCK,
      subject: { kind: 'device', deviceId: 1 },
      from: T0,
      to: T0 + FIVE_MINUTES_MS,
      resolution: '5m',
      maxPoints: 100,
    })
    expect(out.series[0]?.points[0]).toMatchObject({
      t: T0,
      mean: null,
      twMean: null,
      state: 'unlocked',
      states: { locked: 60_000, unlocked: FIVE_MINUTES_MS - 60_000 },
    })
    const raw = await h.runtime.query.query({
      key: LOCK,
      subject: { kind: 'device', deviceId: 1 },
      from: T0,
      to: T0 + FIVE_MINUTES_MS,
      resolution: 'raw',
      maxPoints: 100,
    })
    expect(raw.series[0]?.points.map((p) => p.state)).toEqual(['locked', 'unlocked'])
    const [info] = await h.runtime.query.listSeries({ kind: 'device', deviceId: 1 })
    expect(info).toMatchObject({
      key: LOCK,
      kind: 'enum',
      values: CATALOG['lock-control']?.state?.values,
    })
  })

  it('a reordered value list never moves a stored ordinal (the merge only appends)', async () => {
    h = await lockHarness()
    const stored = h.runtime.registry.metric(LOCK)
    if (stored === undefined) throw new Error('lock metric not declared')
    // The z.enum is reordered and gains a value; the next boot declares that list.
    await h.runtime.registry.declareMetric({
      ...stored,
      values: ['open', 'jammed', 'unlocked', 'locked'],
    })
    expect(h.runtime.registry.metric(LOCK)?.values).toEqual([
      'locked',
      'unlocked',
      'locking',
      'unlocking',
      'jammed',
      'open',
    ])
    const [row] = await h.runtime.store
      .loadMetrics()
      .then((all) => all.filter((m) => m.key === LOCK))
    expect(row?.values?.[5]).toBe('open')
  })

  it('keeps the stored list when the catalog reorders it on the next boot', async () => {
    h = await lockHarness()
    emitState(h, 1, 'lock-control', { state: 'unlocked' })
    await h.settle()
    await h.restart()
    expect(h.runtime.registry.metric(LOCK)?.values?.indexOf('unlocked')).toBe(1)
    expect(h.runtime.capture.lastRecorded(LOCK, 'd:1')?.value).toBe(1)
  })
})

describe('a learned (string) enum', () => {
  it('learns values as they are first seen and stores the list before the points', async () => {
    h = await lockHarness()
    emitState(h, 2, 'enum-sensor', { value: 'Eco50' })
    h.advance(1_000)
    emitState(h, 2, 'enum-sensor', { value: 'Intensive70' })
    await h.settle()
    expect((await rawOf(h, SENSOR, 2)).map((p) => p.value)).toEqual([0, 1])
    await h.restart()
    expect(h.runtime.registry.metric(SENSOR)?.values).toEqual(['Eco50', 'Intensive70'])
  })

  it('skips a slice whose skipWhenSet sibling is set (a timestamp is not a state)', async () => {
    h = await lockHarness()
    emitState(h, 2, 'enum-sensor', { value: '2026-10-21T10:00:00Z', format: 'datetime' })
    await h.settle()
    expect(await rawOf(h, SENSOR, 2)).toEqual([])
    expect(h.runtime.registry.metric(SENSOR)?.values).toEqual([])
  })

  it('refuses (and counts) a new value once the list is full', async () => {
    h = await lockHarness()
    for (let i = 0; i <= MAX_ENUM_VALUES; i += 1) {
      emitState(h, 2, 'enum-sensor', { value: `v${i}` })
      h.advance(1_000)
    }
    await h.settle()
    expect(h.runtime.registry.metric(SENSOR)?.values).toHaveLength(MAX_ENUM_VALUES)
    expect(h.runtime.status().capture.skipped['enum-overflow']).toBe(1)
  })
})

describe('derived energy', () => {
  const POWER: HistoryCatalog = {
    'power-meter': {
      watts: { kind: 'gauge', unit: 'W' },
      kwhTotal: { kind: 'counter', unit: 'kWh' },
    },
  }

  it('integrates watts into kWh per bucket when the device has no meter', async () => {
    h = await makeHarness({ catalog: POWER, devices: { 3: DeviceType.Switch } })
    emitState(h, 3, 'power-meter', { watts: 1200 })
    h.advance(2 * FIVE_MINUTES_MS)
    await h.settle()
    h.advance(60_000)
    await h.runtime.rollup.tick()
    const out = await h.runtime.query.query({
      key: DEVICE_HISTORY_ENERGY_KEY,
      subject: { kind: 'device', deviceId: 3 },
      from: T0,
      to: T0 + FIVE_MINUTES_MS,
      resolution: 'auto',
      maxPoints: 100,
    })
    expect(out.resolution).toBe('5m')
    expect(out.series[0]?.derivedFrom).toBe('cap:power-meter.watts')
    // 1 200 W for 5 minutes = 0.1 kWh.
    expect(out.series[0]?.points[0]?.delta).toBeCloseTo(0.1, 9)
    const list = await h.runtime.query.listSeries({ kind: 'device', deviceId: 3 })
    expect(list.map((s) => s.key)).toContain(DEVICE_HISTORY_ENERGY_KEY)
  })

  it('prefers the meter when the device has both, and counts a reset from zero', async () => {
    h = await makeHarness({ catalog: POWER, devices: { 3: DeviceType.Switch } })
    emitState(h, 3, 'power-meter', { watts: 5000, kwhTotal: 10 })
    h.advance(FIVE_MINUTES_MS)
    emitState(h, 3, 'power-meter', { kwhTotal: 10.5 })
    h.advance(FIVE_MINUTES_MS)
    emitState(h, 3, 'power-meter', { kwhTotal: 0.2 })
    h.advance(FIVE_MINUTES_MS)
    await h.settle()
    h.advance(60_000)
    await h.runtime.rollup.tick()
    const out = await h.runtime.query.query({
      key: DEVICE_HISTORY_ENERGY_KEY,
      subject: { kind: 'device', deviceId: 3 },
      from: T0,
      to: T0 + 3 * FIVE_MINUTES_MS,
      resolution: '5m',
      maxPoints: 100,
    })
    expect(out.series[0]?.derivedFrom).toBe('cap:power-meter.kwhTotal')
    const deltas = out.series[0]?.points.map((p) => p.delta) ?? []
    expect(deltas[0]).toBe(0)
    expect(deltas[1]).toBeCloseTo(0.5, 9)
    expect(deltas[2]).toBeCloseTo(0.2, 9)
  })
})
