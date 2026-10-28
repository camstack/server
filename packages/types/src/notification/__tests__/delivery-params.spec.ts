import { describe, expect, it } from 'vitest'
import type { DeliveryParam } from '../../capabilities/notification-output.cap.js'
import { deliveryParamsDeclaredBy, resolveDeliveryParams } from '../delivery-params.js'

const DECLARED: readonly DeliveryParam[] = [
  {
    key: 'mode',
    label: 'Mode',
    type: 'enum',
    options: [
      { value: 'speak', label: 'Speak' },
      { value: 'announce', label: 'Announce' },
    ],
  },
  { key: 'volume', label: 'Volume', type: 'number', min: 0, max: 100 },
  { key: 'loud', label: 'Loud', type: 'boolean' },
]

describe('resolveDeliveryParams', () => {
  it('keeps only declared keys carrying a valid value', () => {
    expect(
      resolveDeliveryParams(DECLARED, { mode: 'announce', volume: 70, loud: true, sound: 'x' }),
    ).toEqual({ mode: 'announce', volume: 70, loud: true })
  })

  it('drops an enum value outside the options and a non-finite number', () => {
    expect(resolveDeliveryParams(DECLARED, { mode: 'shout', volume: Number.NaN })).toBeUndefined()
  })

  it('clamps a number into min..max', () => {
    expect(resolveDeliveryParams(DECLARED, { volume: 250 })).toEqual({ volume: 100 })
  })

  it('returns undefined for a kind that declares nothing, whatever the rule carries', () => {
    expect(resolveDeliveryParams(undefined, { mode: 'announce' })).toBeUndefined()
    expect(resolveDeliveryParams([], { mode: 'announce' })).toBeUndefined()
  })
})

describe('deliveryParamsDeclaredBy', () => {
  it('unions the declarations of the selected kinds, first declaration of a key winning', () => {
    const other: DeliveryParam = { key: 'mode', label: 'Other', type: 'string' }
    const merged = deliveryParamsDeclaredBy([DECLARED, undefined, [other]])
    expect(merged.map((p) => p.key)).toEqual(['mode', 'volume', 'loud'])
    expect(merged[0]?.label).toBe('Mode')
  })

  it('is empty when no selected kind declares anything', () => {
    expect(deliveryParamsDeclaredBy([undefined, []])).toEqual([])
  })
})
