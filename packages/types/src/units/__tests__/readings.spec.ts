import { describe, expect, it } from 'vitest'
import { formatReading } from '../format-reading.js'
import { ingestReading, quantityFromUnit } from '../ingest-reading.js'
import { QUANTITY_BASE, historyUnitFor } from '../quantity.js'

describe('ingestReading', () => {
  it('converts Fahrenheit into stored Celsius', () => {
    const result = ingestReading({ value: 32, rawUnit: '°F', quantity: 'temperature' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBeCloseTo(0, 5)
  })

  it('converts watt-hours into stored kilowatt-hours', () => {
    const result = ingestReading({ value: 2500, rawUnit: 'Wh', quantity: 'energy' })
    expect(result).toEqual({ ok: true, value: 2.5 })
  })

  it('keeps parts-per-billion on the VOC quantity', () => {
    const result = ingestReading({ value: 40, rawUnit: 'ppb', quantity: 'concentration-ppb' })
    expect(result).toEqual({ ok: true, value: 40 })
  })

  it('treats a missing unit as already in the base', () => {
    const result = ingestReading({ value: 21.5, rawUnit: undefined, quantity: 'temperature' })
    expect(result).toEqual({ ok: true, value: 21.5 })
  })

  it('refuses an unknown unit', () => {
    const result = ingestReading({ value: 3, rawUnit: 'rpm', quantity: 'rate' })
    expect(result).toEqual({ ok: false, reason: 'unknown-unit' })
  })

  it('refuses a unit from another dimension', () => {
    const result = ingestReading({ value: 10, rawUnit: '°C', quantity: 'power' })
    expect(result).toEqual({ ok: false, reason: 'cross-dimension' })
  })

  it('refuses a non-finite value', () => {
    expect(ingestReading({ value: Number.NaN, rawUnit: '°C', quantity: 'temperature' })).toEqual({
      ok: false,
      reason: 'non-finite',
    })
  })

  it('converts gibibytes into bytes', () => {
    const result = ingestReading({ value: 2, rawUnit: 'GiB', quantity: 'information' })
    expect(result).toEqual({ ok: true, value: 2 * 1024 ** 3 })
  })
})

describe('quantityFromUnit', () => {
  it('maps a unit symbol onto its quantity', () => {
    expect(quantityFromUnit('°F')).toBe('temperature')
    expect(quantityFromUnit('ppb')).toBe('concentration-ppb')
    expect(quantityFromUnit('kWh')).toBe('energy')
    expect(quantityFromUnit('rpm')).toBeUndefined()
  })
})

describe('formatReading', () => {
  it('defaults to the metric base', () => {
    expect(formatReading({ value: 21.5, quantity: 'temperature', precision: 1 })).toEqual({
      text: '21.5',
      unit: '°C',
      value: 21.5,
    })
  })

  it('converts to Fahrenheit when the preference is imperial', () => {
    const formatted = formatReading({
      value: 0,
      quantity: 'temperature',
      preference: 'imperial',
      precision: 0,
    })
    expect(formatted.unit).toBe('°F')
    expect(formatted.value).toBeCloseTo(32, 5)
    expect(formatted.text).toBe('32')
  })

  it('scales a duration in seconds up to days', () => {
    expect(formatReading({ value: 2 * 86400, quantity: 'duration', precision: 0 })).toEqual({
      text: '2',
      unit: 'd',
      value: 2,
    })
  })

  it('uses the device quantity for a polymorphic reading', () => {
    expect(
      formatReading({
        value: 1000,
        quantity: 'device',
        deviceQuantity: 'power',
        preference: 'metric',
        precision: 0,
      }).unit,
    ).toBe('W')
  })
})

describe('QUANTITY_BASE', () => {
  it('stores energy in kilowatt-hours', () => {
    expect(QUANTITY_BASE.energy).toBe('kWh')
    expect(historyUnitFor('energy')).toBe('kWh')
    expect(historyUnitFor('index')).toBe('count')
    expect(historyUnitFor('device')).toBeUndefined()
  })
})
