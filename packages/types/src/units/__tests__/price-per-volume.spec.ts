import { describe, expect, it } from 'vitest'
import { convertUnit } from '../convert.js'
import { formatReading } from '../format-reading.js'
import { ingestReading, quantityFromUnit } from '../ingest-reading.js'
import { isReadingQuantity, QUANTITY_BASE } from '../quantity.js'
import { unitsForQuantity } from '../quantity-units.js'

describe('price-per-volume quantity', () => {
  it('is a reading quantity stored in EUR/L', () => {
    expect(isReadingQuantity('price-per-volume')).toBe(true)
    expect(QUANTITY_BASE['price-per-volume']).toBe('EUR/L')
  })

  it('offers EUR/L first, then ct/L', () => {
    expect(unitsForQuantity('price-per-volume')).toEqual(['EUR/L', 'ct/L'])
  })

  it('converts cents per litre into stored EUR/L', () => {
    const result = ingestReading({ value: 189.9, rawUnit: 'ct/L', quantity: 'price-per-volume' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBeCloseTo(1.899, 9)
    expect(convertUnit(1.899, 'EUR/L', 'ct/L')).toBeCloseTo(189.9, 6)
  })

  it('refuses a volume unit on a price', () => {
    expect(ingestReading({ value: 1, rawUnit: 'L', quantity: 'price-per-volume' })).toEqual({
      ok: false,
      reason: 'cross-dimension',
    })
  })

  it('derives the quantity from the unit symbol', () => {
    expect(quantityFromUnit('EUR/L')).toBe('price-per-volume')
    expect(quantityFromUnit('ct/L')).toBe('price-per-volume')
  })

  it('formats a price with its unit', () => {
    const out = formatReading({ value: 1.899, quantity: 'price-per-volume', precision: 3 })
    expect(out.text).toBe('1.899')
    expect(out.unit).toBe('EUR/L')
  })
})
