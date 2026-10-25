/**
 * D934: every form stays in one consumables slice list.
 */
import { describe, expect, it } from 'vitest'
import { consumablesSliceOf, parseConsumableSliceItem } from '../consumable-routing.js'

const base = { key: 'k', label: 'Item', level: null, status: null } as const

describe('parseConsumableSliceItem', () => {
  it('a wear item keeps a wear reading; supply/waste do not', () => {
    expect(parseConsumableSliceItem({ ...base, kind: undefined, level: 40 })).toMatchObject({
      form: 'part',
      wear: { level: 40, status: null },
    })
    expect(parseConsumableSliceItem({ ...base, kind: 'supply', status: 'low' })).toMatchObject({
      form: 'product',
      wear: null,
      status: 'low',
    })
    expect(
      parseConsumableSliceItem({ ...base, kind: 'supply', form: 'tank', status: 'low' }),
    ).toMatchObject({ form: 'tank' })
  })
})

describe('consumablesSliceOf', () => {
  const event = (slice: unknown, capName = 'consumables') => ({
    category: 'device.state-changed',
    data: { capName, deviceId: 7, slice },
  })

  it('returns one list with every item', () => {
    const out = consumablesSliceOf(
      event({
        items: [
          { key: 'cleanWater', kind: 'supply', form: 'tank', status: 'low', label: 'Water' },
          { key: 'filter', kind: 'wear', level: 5, label: 'Filter' },
          { key: 'salt', kind: 'supply', status: 'low', label: 'Salt' },
        ],
      }),
    )
    expect(out?.items).toHaveLength(3)
    expect(out?.items.map((i) => i.key)).toEqual(['cleanWater', 'filter', 'salt'])
  })
})
