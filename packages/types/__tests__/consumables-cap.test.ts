import { describe, it, expect } from 'vitest'
import {
  ConsumableItemSchema,
  ConsumablesStatusSchema,
  consumableFormOf,
  consumableKindOf,
  consumablesCapability,
  type ConsumableItem,
} from '../src/capabilities/consumables.cap.js'
import { WELL_KNOWN_TAB_MAP } from '../src/interfaces/config-ui.js'
import { DeviceType } from '../src/device/device-type.js'

const baseItem: ConsumableItem = {
  key: 'main-brush',
  label: 'Main Brush',
  level: null,
  status: null,
  lastResetAt: null,
  resettable: true,
}

describe('ConsumableItemSchema', () => {
  it('accepts a level-only item (status null)', () => {
    const parsed = ConsumableItemSchema.parse({ ...baseItem, level: 42 })
    expect(parsed.level).toBe(42)
    expect(parsed.status).toBeNull()
  })

  it('accepts a status-only item (level null)', () => {
    const parsed = ConsumableItemSchema.parse({ ...baseItem, status: 'replace' })
    expect(parsed.status).toBe('replace')
    expect(parsed.level).toBeNull()
  })

  it('accepts both level and status', () => {
    const parsed = ConsumableItemSchema.parse({ ...baseItem, level: 80, status: 'ok' })
    expect(parsed).toMatchObject({ level: 80, status: 'ok' })
  })

  it('accepts both null (existence only)', () => {
    const parsed = ConsumableItemSchema.parse(baseItem)
    expect(parsed.level).toBeNull()
    expect(parsed.status).toBeNull()
  })

  it('accepts a lastResetAt timestamp', () => {
    const ts = 1_700_000_000_000
    const parsed = ConsumableItemSchema.parse({ ...baseItem, lastResetAt: ts })
    expect(parsed.lastResetAt).toBe(ts)
  })

  it('rejects an out-of-range level', () => {
    expect(() => ConsumableItemSchema.parse({ ...baseItem, level: 120 })).toThrow()
    expect(() => ConsumableItemSchema.parse({ ...baseItem, level: -1 })).toThrow()
  })

  it('accepts every status a supply, a waste item or a wear part can report (D915)', () => {
    for (const status of ['ok', 'low', 'empty', 'full', 'replace'] as const) {
      expect(ConsumableItemSchema.parse({ ...baseItem, status }).status).toBe(status)
    }
  })

  it('rejects an unknown status token', () => {
    expect(() => ConsumableItemSchema.parse({ ...baseItem, status: 'overflowing' })).toThrow()
  })

  it('takes an optional kind, and an absent kind reads as wear', () => {
    expect(ConsumableItemSchema.parse({ ...baseItem, kind: 'waste' }).kind).toBe('waste')
    expect(() => ConsumableItemSchema.parse({ ...baseItem, kind: 'fuel' })).toThrow()
    expect(consumableKindOf(ConsumableItemSchema.parse(baseItem))).toBe('wear')
    expect(consumableKindOf({ kind: 'supply' })).toBe('supply')
  })

  it('takes an optional form; an absent one is derived from the kind (wear→part, waste→bin, supply→product)', () => {
    expect(ConsumableItemSchema.parse({ ...baseItem, form: 'tank' }).form).toBe('tank')
    expect(() => ConsumableItemSchema.parse({ ...baseItem, form: 'bottle' })).toThrow()
    expect(consumableFormOf(ConsumableItemSchema.parse(baseItem))).toBe('part')
    expect(consumableFormOf({ kind: 'waste' })).toBe('bin')
    expect(consumableFormOf({ kind: 'supply' })).toBe('product')
    expect(consumableFormOf({ kind: 'wear' })).toBe('part')
  })

  it('an explicit form wins over the derivation (a water tank is a supply TANK)', () => {
    expect(consumableFormOf({ kind: 'supply', form: 'tank' })).toBe('tank')
    expect(consumableFormOf({ kind: 'waste', form: 'tank' })).toBe('tank')
  })

  it('rejects an empty key or label', () => {
    expect(() => ConsumableItemSchema.parse({ ...baseItem, key: '' })).toThrow()
    expect(() => ConsumableItemSchema.parse({ ...baseItem, label: '' })).toThrow()
  })
})

describe('ConsumablesStatusSchema', () => {
  it('round-trips a status with multiple items', () => {
    const status = {
      items: [
        { ...baseItem, key: 'filter', label: 'Filter', level: 30 },
        { ...baseItem, key: 'side-brush', label: 'Side Brush', status: 'replace' as const },
      ],
      lastChangedAt: 123,
    }
    const parsed = ConsumablesStatusSchema.parse(status)
    expect(parsed).toEqual(status)
  })

  it('accepts an empty items list (inert cap)', () => {
    const parsed = ConsumablesStatusSchema.parse({ items: [], lastChangedAt: 0 })
    expect(parsed.items).toEqual([])
  })

  it('requires lastChangedAt', () => {
    expect(() => ConsumablesStatusSchema.parse({ items: [] })).toThrow()
  })
})

describe('consumablesCapability reset input', () => {
  it('accepts a valid { deviceId, key } input', () => {
    const parsed = consumablesCapability.methods.reset.input.parse({ deviceId: 7, key: 'filter' })
    expect(parsed).toEqual({ deviceId: 7, key: 'filter' })
  })

  it('rejects a negative deviceId or empty key', () => {
    expect(() =>
      consumablesCapability.methods.reset.input.parse({ deviceId: -1, key: 'filter' }),
    ).toThrow()
    expect(() =>
      consumablesCapability.methods.reset.input.parse({ deviceId: 1, key: '' }),
    ).toThrow()
  })
})

describe('consumables deviceConfig widget', () => {
  it('declares ONE host widget placed under the hero — not a tab (D915)', () => {
    expect(consumablesCapability.deviceConfig.ui).toMatchObject({
      kind: 'widget',
      widgetId: 'host/consumables-panel',
      placement: 'hero',
      label: 'Consumables',
    })
    expect(consumablesCapability.deviceConfig.ui).not.toHaveProperty('topTab')
  })
})

describe('consumables deviceTypes (device-agnostic)', () => {
  it('binds on every DeviceType member', () => {
    const all = Object.values(DeviceType)
    expect([...consumablesCapability.deviceTypes].sort()).toEqual([...all].sort())
  })
})

describe('consumables runtimeState', () => {
  it('extends the status schema with lastFetchedAt', () => {
    const parsed = consumablesCapability.runtimeState.parse({
      items: [],
      lastChangedAt: 0,
      lastFetchedAt: 42,
    })
    expect(parsed.lastFetchedAt).toBe(42)
  })

  it('requires lastFetchedAt', () => {
    expect(() =>
      consumablesCapability.runtimeState.parse({ items: [], lastChangedAt: 0 }),
    ).toThrow()
  })
})

describe('WELL_KNOWN_TAB_MAP', () => {
  it('has a consumables entry', () => {
    const tab = WELL_KNOWN_TAB_MAP['consumables']
    expect(tab).toBeDefined()
    expect(tab.label).toBe('Consumables')
    expect(typeof tab.icon).toBe('string')
    expect(tab.icon.length).toBeGreaterThan(0)
  })
})
