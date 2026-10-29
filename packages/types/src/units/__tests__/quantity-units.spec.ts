import { describe, expect, it } from 'vitest'
import { READING_QUANTITIES } from '../quantity.js'
import { baseUnitForQuantity, unitsForQuantity } from '../quantity-units.js'
import { canConvertUnit } from '../convert.js'

describe('unitsForQuantity', () => {
  it('lists the mass units, the stored base first', () => {
    const units = unitsForQuantity('mass')
    expect(units[0]).toBe('kg')
    expect(units).toEqual(expect.arrayContaining(['g', 'lb', 'oz']))
  })

  it('lists the temperature units with the stored °C first', () => {
    expect(unitsForQuantity('temperature')).toEqual(['°C', '°F', 'K'])
  })

  it('puts the quantity base unit first even when it is not the canonical unit', () => {
    expect(unitsForQuantity('energy')[0]).toBe('kWh')
    expect(unitsForQuantity('duration-ms')[0]).toBe('ms')
    expect(unitsForQuantity('concentration-ppb')[0]).toBe('ppb')
  })

  it('is empty for a quantity with no unit', () => {
    for (const quantity of ['none', 'count', 'index', 'ratio', 'device'] as const) {
      expect(unitsForQuantity(quantity)).toEqual([])
      expect(baseUnitForQuantity(quantity)).toBeUndefined()
    }
  })

  it('every unit offered converts to the base of its quantity', () => {
    for (const quantity of READING_QUANTITIES) {
      const base = baseUnitForQuantity(quantity)
      for (const unit of unitsForQuantity(quantity)) {
        expect(base).toBeDefined()
        expect(canConvertUnit(unit, base ?? '')).toBe(true)
      }
    }
  })

  it('baseUnitForQuantity is the stored unit', () => {
    expect(baseUnitForQuantity('mass')).toBe('kg')
  })
})
