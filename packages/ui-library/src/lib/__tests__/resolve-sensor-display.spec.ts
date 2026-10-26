import { describe, expect, it } from 'vitest'
import { resolveSensorDisplay } from '../resolve-sensor-display'

describe('resolveSensorDisplay', () => {
  it('shows the base unit for a metric temperature', () => {
    const resolved = resolveSensorDisplay({ quantity: 'temperature' })
    expect(resolved.unit).toBe('°C')
    expect(resolved.format(21)).toEqual({ text: '21', unit: '°C' })
  })

  it('converts a base temperature to Fahrenheit for an imperial preference', () => {
    const resolved = resolveSensorDisplay({ quantity: 'temperature', preference: 'imperial' })
    expect(resolved.unit).toBe('°F')
    expect(resolved.toDisplayValue(0)).toBeCloseTo(32)
  })

  it('converts from the base when the operator overrides the unit', () => {
    const resolved = resolveSensorDisplay({
      quantity: 'temperature',
      display: { unit: '°F', precision: 1 },
    })
    expect(resolved.unit).toBe('°F')
    expect(resolved.precision).toBe(1)
    expect(resolved.toDisplayValue(0)).toBeCloseTo(32)
  })

  it('keeps the base label when an override is a different dimension', () => {
    const resolved = resolveSensorDisplay({
      quantity: 'temperature',
      display: { unit: 'hPa' },
    })
    expect(resolved.unit).toBe('°C')
    expect(resolved.toDisplayValue(21)).toBe(21)
  })

  it('uses the device quantity for a polymorphic reading', () => {
    const resolved = resolveSensorDisplay({
      quantity: 'device',
      deviceQuantity: 'signal-level',
    })
    expect(resolved.unit).toBe('dBm')
  })

  it('renders nothing unit-like when the device has not chosen a quantity', () => {
    const resolved = resolveSensorDisplay({ quantity: 'device' })
    expect(resolved.unit).toBe('')
  })

  it('lets precision 0 win over a declaration', () => {
    const resolved = resolveSensorDisplay({
      quantity: 'humidity',
      display: { precision: 0 },
      declarationPrecision: 2,
    })
    expect(resolved.precision).toBe(0)
  })

  it('scopes a per-cap override to the named cap', () => {
    const display = {
      unit: '°F',
      perCap: { 'numeric-sensor': { unit: 'K' } },
    }
    expect(
      resolveSensorDisplay({ quantity: 'temperature', display, capName: 'numeric-sensor' }).unit,
    ).toBe('K')
    expect(
      resolveSensorDisplay({ quantity: 'temperature', display, capName: 'power-meter' }).unit,
    ).toBe('°F')
  })
})
