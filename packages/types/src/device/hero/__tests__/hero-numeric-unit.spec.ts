import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device-type.js'
import { buildHeroModel } from '../build-hero-model.js'
import type { ReadingQuantity } from '../../../units/quantity.js'

function numeric(value: number, quantity?: ReadingQuantity | null) {
  return buildHeroModel({
    device: {
      id: 1,
      type: DeviceType.Sensor,
      role: 'numeric-sensor',
      name: 's',
      online: true,
      ...(quantity === undefined ? {} : { quantity }),
    },
    caps: ['numeric-sensor'],
    features: [],
    slices: { 'numeric-sensor': { value, lastFetchedAt: 1 } },
    now: 1,
    remoteCommands: null,
    access: { canActuate: true },
  })
}

describe('a numeric-sensor hero names its unit', () => {
  it.each([
    ['percentage', 23, '23 %'],
    ['frequency', 49.9, '49.9 Hz'],
    ['signal-ratio', -9.5, '-9.5 dB'],
  ] as const)('%s reads with its unit', (quantity, value, text) => {
    expect(JSON.stringify(numeric(value, quantity))).toContain(`"${text}"`)
  })

  it('a quantity with no symbol, or none stored, stays a bare number', () => {
    expect(JSON.stringify(numeric(5, 'count'))).toContain('"5"')
    expect(JSON.stringify(numeric(5, null))).toContain('"5"')
    expect(JSON.stringify(numeric(5))).toContain('"5"')
  })
})
