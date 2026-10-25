import { describe, it, expect } from 'vitest'
import { resolveSensorDisplay } from '../resolve-sensor-display'
import { formatNumeric } from '../format-numeric'

describe('resolveSensorDisplay — unit precedence', () => {
  it('device override unit beats role default beats slice beats canonical', () => {
    // canonical only
    expect(resolveSensorDisplay({ canonicalUnit: '°C' }).unit).toBe('°C')
    // slice beats canonical
    expect(resolveSensorDisplay({ sliceUnit: '°F', canonicalUnit: '°C' }).unit).toBe('°F')
    // role default beats slice (same dimension → converts, unit = role default)
    expect(
      resolveSensorDisplay({ roleDefault: { unit: 'K' }, sliceUnit: '°C', canonicalUnit: '°C' })
        .unit,
    ).toBe('K')
    // device override beats role default
    expect(
      resolveSensorDisplay({
        display: { unit: '°F' },
        roleDefault: { unit: 'K' },
        sliceUnit: '°C',
      }).unit,
    ).toBe('°F')
  })

  it('perCap unit beats device-level for the named cap only', () => {
    const input = {
      display: { unit: '°F', perCap: { 'numeric-sensor': { unit: 'K' } } },
      sliceUnit: '°C',
    }
    expect(resolveSensorDisplay({ ...input, capName: 'numeric-sensor' }).unit).toBe('K')
    // Different / absent capName → falls back to device-level.
    expect(resolveSensorDisplay({ ...input, capName: 'power-meter' }).unit).toBe('°F')
    expect(resolveSensorDisplay({ ...input }).unit).toBe('°F')
  })

  it('no units anywhere → empty string, identity value', () => {
    const r = resolveSensorDisplay({})
    expect(r.unit).toBe('')
    expect(r.toDisplayValue(42)).toBe(42)
  })
})

describe('resolveSensorDisplay — precision (?? not ||)', () => {
  it('device precision:0 wins over slice precision:2 (the falsy-0 trap)', () => {
    const r = resolveSensorDisplay({ display: { precision: 0 }, slicePrecision: 2 })
    expect(r.precision).toBe(0)
  })
  it('perCap precision beats device precision; role default beats slice', () => {
    expect(
      resolveSensorDisplay({
        display: { precision: 1, perCap: { 'numeric-sensor': { precision: 3 } } },
        capName: 'numeric-sensor',
      }).precision,
    ).toBe(3)
    expect(
      resolveSensorDisplay({ roleDefault: { precision: 2 }, slicePrecision: 5 }).precision,
    ).toBe(2)
  })
  it('falls back to slice precision, else undefined', () => {
    expect(resolveSensorDisplay({ slicePrecision: 4 }).precision).toBe(4)
    expect(resolveSensorDisplay({}).precision).toBeUndefined()
  })
})

describe('resolveSensorDisplay — render-time conversion', () => {
  it('converts °C slice to °F override; precision applies AFTER conversion', () => {
    const r = resolveSensorDisplay({ display: { unit: '°F', precision: 1 }, sliceUnit: '°C' })
    expect(r.unit).toBe('°F')
    expect(r.toDisplayValue(20)).toBeCloseTo(68, 10)
    expect(formatNumeric(r.toDisplayValue(20), r.precision)).toBe('68.0')
  })

  it('converts against the canonical source unit for a typed role with no slice unit', () => {
    const r = resolveSensorDisplay({ display: { unit: '°F' }, canonicalUnit: '°C' })
    expect(r.unit).toBe('°F')
    expect(r.toDisplayValue(0)).toBeCloseTo(32, 10)
  })

  it('normalizes provider spellings (C / F) before converting', () => {
    const r = resolveSensorDisplay({ display: { unit: 'F' }, sliceUnit: 'C' })
    expect(r.unit).toBe('°F')
    expect(r.toDisplayValue(18.8)).toBeCloseTo(65.84, 5)
    // Source-only path also canonicalizes the label.
    expect(resolveSensorDisplay({ sliceUnit: 'C' }).unit).toBe('°C')
  })
})

describe('resolveSensorDisplay — refusal fallback (label & math never disagree)', () => {
  it('cross-dimension override is ignored: unit stays source, identity value', () => {
    const r = resolveSensorDisplay({ display: { unit: 'hPa' }, sliceUnit: '°C' })
    expect(r.unit).toBe('°C')
    expect(r.toDisplayValue(20)).toBe(20)
  })
  it('override equal to source unit is identity', () => {
    const r = resolveSensorDisplay({ display: { unit: '°C' }, sliceUnit: '°C' })
    expect(r.unit).toBe('°C')
    expect(r.toDisplayValue(20)).toBe(20)
  })
  it('override with no known source unit falls back to empty, identity', () => {
    const r = resolveSensorDisplay({ display: { unit: '°F' } })
    expect(r.unit).toBe('')
    expect(r.toDisplayValue(20)).toBe(20)
  })
})
