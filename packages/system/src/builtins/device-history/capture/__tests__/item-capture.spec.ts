/**
 * Keyed-array series (D917): a cap's `history.items` records one series per
 * (item field, item key), the item key being the series SCOPE. Driven by the
 * REAL generated catalog — the `consumables` cap is the one that declares it,
 * so a regression of its declaration fails here too.
 */
import { DeviceType, HISTORY_ITEM_CATALOG } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { type Harness, T0, makeHarness } from '../../__tests__/support/harness.js'
import { emitState, rawOf, seriesOf } from '../../__tests__/support/read-helpers.js'

let h: Harness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

const LEVEL = 'cap:consumables.items[].level'
const STATUS = 'cap:consumables.items[].status'
const REMAINING = 'cap:consumables.items[].remaining.value'

interface ItemFixture {
  readonly key: string
  readonly label: string
  readonly level: number | null
  readonly status: string | null
  readonly remaining?: { readonly value: number | null; readonly unit: string }
}

function item(over: Partial<ItemFixture> & { key: string }): ItemFixture {
  return { label: over.key, level: null, status: null, ...over }
}

function slice(items: readonly ItemFixture[]): Readonly<Record<string, unknown>> {
  return { items, lastChangedAt: 1 }
}

describe('keyed items are recorded per item key', () => {
  it('the consumables cap declares its items in the generated catalog', () => {
    expect(Object.keys(HISTORY_ITEM_CATALOG.consumables?.fields ?? {})).toEqual([
      'level',
      'status',
      'remaining.value',
    ])
  })

  it('records each item level under its key as scope, never null as zero', async () => {
    h = await makeHarness({ devices: { 7: DeviceType.Vacuum } })
    emitState(
      h,
      7,
      'consumables',
      slice([
        item({ key: 'cleanWater', label: 'Clean water', level: 80 }),
        item({ key: 'dustBin', label: 'Dust bin', level: 20 }),
        item({ key: 'filter', level: null }),
      ]),
    )
    await h.settle()
    expect(await rawOf(h, LEVEL, 7, 'cleanWater')).toEqual([{ ts: T0, value: 80 }])
    expect(await rawOf(h, LEVEL, 7, 'dustBin')).toEqual([{ ts: T0, value: 20 }])
    expect(seriesOf(h, LEVEL, 7, 'filter')).toBeUndefined()
    expect(seriesOf(h, LEVEL, 7)).toBeUndefined()
  })

  it('applies the deadband per item, and an item that appears later gets its series', async () => {
    h = await makeHarness({ devices: { 7: DeviceType.Vacuum } })
    emitState(h, 7, 'consumables', slice([item({ key: 'cleanWater', level: 80 })]))
    h.advance(60_000)
    // 1 point below the 2 % deadband: nothing.
    emitState(
      h,
      7,
      'consumables',
      slice([item({ key: 'cleanWater', level: 79 }), item({ key: 'detergent', level: 50 })]),
    )
    h.advance(60_000)
    emitState(
      h,
      7,
      'consumables',
      slice([item({ key: 'cleanWater', level: 70 }), item({ key: 'detergent', level: 50 })]),
    )
    await h.settle()
    expect((await rawOf(h, LEVEL, 7, 'cleanWater')).map((p) => p.value)).toEqual([80, 70])
    expect(await rawOf(h, LEVEL, 7, 'detergent')).toEqual([{ ts: T0 + 60_000, value: 50 }])
  })

  it('records the status as an enum and remaining as a gauge, per item', async () => {
    h = await makeHarness({ devices: { 7: DeviceType.Vacuum } })
    emitState(
      h,
      7,
      'consumables',
      slice([
        item({ key: 'filter', status: 'ok', remaining: { value: 12, kind: 'duration' } }),
        item({ key: 'salt', status: 'low' }),
      ]),
    )
    await h.settle()
    const values = h.runtime.registry.metric(STATUS)?.values ?? []
    expect((await rawOf(h, STATUS, 7, 'filter')).map((p) => values[p.value])).toEqual(['ok'])
    expect((await rawOf(h, STATUS, 7, 'salt')).map((p) => values[p.value])).toEqual(['low'])
    expect(await rawOf(h, REMAINING, 7, 'filter')).toEqual([{ ts: T0, value: 12 }])
  })

  it('skips an item without a usable key, and a non-array', async () => {
    h = await makeHarness({ devices: { 7: DeviceType.Vacuum } })
    emitState(h, 7, 'consumables', { items: [{ key: '', level: 50 }, { level: 40 }, 'x'] })
    emitState(h, 7, 'consumables', { items: { cleanWater: { key: 'cleanWater', level: 50 } } })
    await h.settle()
    expect(h.runtime.registry.all()).toEqual([])
  })

  it('reconcile restores a missed item change from the snapshot', async () => {
    h = await makeHarness({ devices: { 7: DeviceType.Vacuum } })
    emitState(h, 7, 'consumables', slice([item({ key: 'cleanWater', level: 80 })]))
    await h.settle()
    h.advance(5 * 60_000)
    h.setSnapshots({ '7': { consumables: slice([item({ key: 'cleanWater', level: 40 })]) } })
    await h.runtime.reconcile()
    await h.settle()
    expect((await rawOf(h, LEVEL, 7, 'cleanWater')).map((p) => p.value)).toEqual([80, 40])
  })

  it('a restart repeats nothing for an item series', async () => {
    h = await makeHarness({ devices: { 7: DeviceType.Vacuum } })
    emitState(h, 7, 'consumables', slice([item({ key: 'cleanWater', level: 80 })]))
    await h.settle()
    await h.restart()
    h.advance(60_000)
    emitState(h, 7, 'consumables', slice([item({ key: 'cleanWater', level: 80 })]))
    await h.settle()
    expect(await rawOf(h, LEVEL, 7, 'cleanWater')).toHaveLength(1)
  })
})

describe('listSeries names an item series after the item', () => {
  it('uses the item label, and the key once the item is gone', async () => {
    h = await makeHarness({ devices: { 7: DeviceType.Vacuum } })
    emitState(
      h,
      7,
      'consumables',
      slice([
        item({ key: 'cleanWater', label: 'Clean water', level: 80 }),
        item({ key: 'filter', label: 'Filter', remaining: { value: 12, kind: 'duration' } }),
      ]),
    )
    await h.settle()
    h.slices.set(
      '7:consumables',
      slice([item({ key: 'filter', label: 'Filter', remaining: { value: 12, kind: 'duration' } })]),
    )
    const infos = await h.runtime.query.listSeries({ kind: 'device', deviceId: 7 })
    const byId = new Map(infos.map((s) => [`${s.key}|${s.scope}`, s]))
    expect(byId.get(`${LEVEL}|cleanWater`)).toMatchObject({
      displayName: 'cleanWater · Level',
      unit: '%',
      source: 'cap',
    })
    expect(byId.get(`${REMAINING}|filter`)).toMatchObject({
      displayName: 'Filter · Remaining',
      unit: null,
    })
  })
})
