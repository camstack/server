/**
 * The addon half of per-item entities: a `consumables` slice change pushes
 * the values of the items the plan announced, re-derives the structure when
 * the item set moved, and a removed item leaves Home Assistant only when two
 * reads agree (D49).
 *
 * Disarm: drop the `isItemEntityCap` branch in `onSliceChanged` — the push
 * and the re-announce tests fail; resolve the item mirror with the raw read
 * instead of the mirror — "holds a removal for one read" fails.
 */
import type { ConsumablesStatus, IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { HaExportAddon } from '../ha-export.addon.js'
import { itemEntitiesFor } from '../item-entities.js'
import type { StateValue } from '../types.js'

const silent: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
  withTags: () => silent,
}

const KEY = 'camstack-503'

const TWO_ITEMS: ConsumablesStatus = {
  lastChangedAt: 1,
  items: [
    {
      key: 'main-brush',
      label: 'Main brush',
      level: 63,
      status: null,
      lastResetAt: null,
      resettable: true,
    },
    {
      key: 'clean-water',
      label: 'Clean water tank',
      kind: 'supply',
      level: 40,
      status: null,
      lastResetAt: null,
      resettable: false,
    },
  ],
}

const ONE_ITEM: ConsumablesStatus = { ...TWO_ITEMS, items: TWO_ITEMS.items.slice(0, 1) }

interface Harness {
  readonly addon: HaExportAddon
  readonly pushed: StateValue[]
  readonly reconciles: { count: number }
  readonly slice: (data: unknown) => void
}

function harness(announced: ConsumablesStatus): Harness {
  const addon = new HaExportAddon()
  const pushed: StateValue[] = []
  const reconciles = { count: 0 }
  Reflect.set(addon, '_ctx', { logger: silent })
  Reflect.set(addon, 'keyByDeviceId', new Map([[503, KEY]]))
  Reflect.set(
    addon,
    'exported',
    new Map([
      [
        KEY,
        {
          plan: { deviceKey: KEY, deviceId: 503, dev: {}, cmps: {} },
          deviceId: 503,
          target: {
            deviceId: 503,
            type: 'vacuum',
            boundCaps: ['consumables'],
            itemEntities: itemEntitiesFor('consumables', announced) ?? [],
          },
          brokerIds: ['b'],
          streams: [],
          cameraFunctions: null,
        },
      ],
    ]),
  )
  Reflect.set(addon, 'push', (_deviceId: number, values: readonly StateValue[]) => {
    pushed.push(...values)
  })
  Reflect.set(addon, 'reconcileSoon', async () => {
    reconciles.count += 1
  })
  const handler: unknown = Reflect.get(addon, 'onSliceChanged')
  if (typeof handler !== 'function') throw new Error('no onSliceChanged')
  return {
    addon,
    pushed,
    reconciles,
    slice: (data) => {
      handler.call(addon, data)
    },
  }
}

describe('a consumables slice change', () => {
  it('pushes the item values onto the announced entities', () => {
    const h = harness(TWO_ITEMS)
    h.slice({ deviceId: 503, capName: 'consumables', slice: TWO_ITEMS })
    expect(h.pushed).toEqual(
      expect.arrayContaining([
        { topic: `camstack/${KEY}/consumable_main_brush_level`, value: '63' },
        { topic: `camstack/${KEY}/consumable_clean_water_level`, value: '40' },
      ]),
    )
    expect(h.reconciles.count).toBe(0)
  })

  it('re-announces the device when an item appears, and pushes nothing for it yet', () => {
    const h = harness(ONE_ITEM)
    h.slice({ deviceId: 503, capName: 'consumables', slice: TWO_ITEMS })
    expect(h.reconciles.count).toBe(1)
    expect(h.pushed.some((v) => v.topic.includes('clean_water'))).toBe(false)
    expect(h.pushed).toContainEqual({
      topic: `camstack/${KEY}/consumable_main_brush_level`,
      value: '63',
    })
  })

  it('re-announces the device when an item leaves', () => {
    const h = harness(TWO_ITEMS)
    h.slice({ deviceId: 503, capName: 'consumables', slice: ONE_ITEM })
    expect(h.reconciles.count).toBe(1)
  })
})

describe('the item mirror', () => {
  function settle(addon: HaExportAddon, slice: ConsumablesStatus | undefined): readonly string[] {
    const fn: unknown = Reflect.get(addon, 'settleItemEntities')
    if (typeof fn !== 'function') throw new Error('no settleItemEntities')
    const result: unknown = fn.call(
      addon,
      503,
      ['consumables'],
      slice === undefined ? {} : { consumables: slice },
    )
    const entities: unknown = Reflect.get(Object(result), 'entities')
    const list: unknown = Reflect.get(Object(entities), 'consumables')
    if (!Array.isArray(list)) throw new Error('no consumables entities')
    return list.map((item: unknown) => String(Reflect.get(Object(item), 'entity'))).sort()
  }

  it('announces a new item at once', () => {
    const h = harness(ONE_ITEM)
    expect(settle(h.addon, ONE_ITEM)).toEqual([
      'consumable_main_brush_level',
      'consumable_main_brush_reset',
    ])
    expect(settle(h.addon, TWO_ITEMS)).toContain('consumable_clean_water_level')
  })

  it('holds a removal for one read and applies it on the second', () => {
    const h = harness(TWO_ITEMS)
    settle(h.addon, TWO_ITEMS)
    expect(settle(h.addon, ONE_ITEM)).toContain('consumable_clean_water_level')
    expect(settle(h.addon, ONE_ITEM)).not.toContain('consumable_clean_water_level')
  })

  it('treats an absent slice as no items, under the same two-read rule', () => {
    const h = harness(TWO_ITEMS)
    settle(h.addon, TWO_ITEMS)
    expect(settle(h.addon, undefined)).toHaveLength(3)
    expect(settle(h.addon, undefined)).toEqual([])
  })
})
