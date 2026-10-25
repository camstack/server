/**
 * The FORM of a consumable item (`part | tank | product | bin`) decides how
 * Home Assistant draws it — the icon of its level and status sensors — and
 * travels with those sensors as attributes beside its `kind` and `label`.
 * An item that names no form takes the one its kind implies.
 */
import { describe, expect, it } from 'vitest'
import { buildDevicePlan } from '../entity-catalog.js'
import { consumableForm, type ItemEntity, itemEntitiesFor } from '../item-entities.js'
import { toComponentKey } from '../topics.js'
import type { CatalogDevice, HaComponent } from '../types.js'

type RawItem = Readonly<Record<string, unknown>>

function item(key: string, label: string, extra: RawItem): RawItem {
  return { key, label, level: 50, status: null, lastResetAt: null, resettable: false, ...extra }
}

function slice(items: readonly RawItem[]): RawItem {
  return { lastChangedAt: 1, items }
}

function entityOf(raw: RawItem, entity: string): ItemEntity {
  const found = (itemEntitiesFor('consumables', raw) ?? []).find((e) => e.entity === entity)
  if (found === undefined) throw new Error(`no ${entity}`)
  return found
}

describe('consumableForm', () => {
  it('derives the form from the kind when the provider names none', () => {
    expect(consumableForm({ kind: 'wear' })).toBe('part')
    expect(consumableForm({})).toBe('part')
    expect(consumableForm({ kind: 'waste' })).toBe('bin')
    expect(consumableForm({ kind: 'supply' })).toBe('product')
  })

  it('reads the form the provider declared over the kind', () => {
    expect(consumableForm({ kind: 'supply', form: 'tank' })).toBe('tank')
    expect(consumableForm({ kind: 'waste', form: 'tank' })).toBe('tank')
  })

  it('ignores a form it does not know rather than trusting it', () => {
    expect(consumableForm({ kind: 'waste', form: 'bucket' })).toBe('bin')
  })
})

describe('the icon follows the form', () => {
  const tanks = slice([
    item('clean', 'Clean water', { kind: 'supply', form: 'tank', status: 'ok' }),
    item('dirty', 'Dirty water', { kind: 'waste', form: 'tank' }),
    item('salt', 'Salt', { kind: 'supply', level: null, status: 'ok' }),
    item('dust', 'Dust bin', { kind: 'waste' }),
  ])

  it('draws a tank as water, a waste tank as water-off, a product as a shaker, a bin as a bin', () => {
    expect(entityOf(tanks, 'consumable_clean_level').icon).toBe('mdi:water')
    expect(entityOf(tanks, 'consumable_clean_status').icon).toBe('mdi:water')
    expect(entityOf(tanks, 'consumable_dirty_level').icon).toBe('mdi:water-off')
    expect(entityOf(tanks, 'consumable_salt_status').icon).toBe('mdi:shaker-outline')
    expect(entityOf(tanks, 'consumable_dust_level').icon).toBe('mdi:delete')
  })

  it('draws a part by what it is when its key or label says so, else as a filter', () => {
    const parts = slice([
      item('side-brush', 'Side brush', {}),
      item('hepa', 'HEPA filter', {}),
      item('sensor', 'Sensors', {}),
    ])
    expect(entityOf(parts, 'consumable_side_brush_level').icon).toBe('mdi:brush')
    expect(entityOf(parts, 'consumable_hepa_level').icon).toBe('mdi:air-filter')
    expect(entityOf(parts, 'consumable_sensor_level').icon).toBe('mdi:air-filter')
  })
})

describe('form, kind and label are attributes of the level and status sensors', () => {
  const raw = slice([
    item('main-brush', 'Main brush', {
      status: 'ok',
      resettable: true,
      remaining: { value: 3, unit: 'days' },
    }),
    item('clean-water', 'Clean water tank', { kind: 'supply', form: 'tank' }),
  ])
  const entities = itemEntitiesFor('consumables', raw)
  if (entities === null) throw new Error('the fixture slice must parse')
  const device: CatalogDevice = {
    id: 503,
    name: 'Vacuum',
    type: 'vacuum',
    features: [],
    boundCaps: ['consumables'],
    zones: [],
    switches: [],
    slices: ['consumables'],
    itemEntities: { consumables: entities },
  }
  const plan = buildDevicePlan(device)

  function component(platform: string, entity: string): HaComponent {
    const found = plan.cmps[toComponentKey(platform, entity)]
    if (found === undefined) throw new Error(`no ${platform} ${entity}`)
    return found
  }

  it('on the level sensor', () => {
    expect(component('sensor', 'consumable_clean_water_level').attributes).toEqual({
      form: 'tank',
      kind: 'supply',
      label: 'Clean water tank',
    })
  })

  it('on the status sensor', () => {
    expect(component('sensor', 'consumable_main_brush_status').attributes).toEqual({
      form: 'part',
      kind: 'wear',
      label: 'Main brush',
    })
  })

  it('not on the remaining counter or the reset button', () => {
    expect(component('sensor', 'consumable_main_brush_remaining').attributes).toBeUndefined()
    expect(component('button', 'consumable_main_brush_reset').attributes).toBeUndefined()
  })
})
