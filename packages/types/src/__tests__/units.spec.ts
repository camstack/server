import { describe, it, expect } from 'vitest'
import {
  UNIT_TABLE,
  UnitConversionError,
  convertUnit,
  tryConvertUnit,
  canConvertUnit,
  type KnownUnit,
  unitDimension,
  unitsForDimension,
} from '../units/index.js'

describe('unitDimension', () => {
  it('resolves known units to their dimension', () => {
    expect(unitDimension('°C')).toBe('temperature')
    expect(unitDimension('hPa')).toBe('pressure')
    expect(unitDimension('kWh')).toBe('energy')
    expect(unitDimension('%')).toBe('percentage')
  })
  it('returns undefined for unknown units', () => {
    expect(unitDimension('banana')).toBeUndefined()
    expect(unitDimension('')).toBeUndefined()
  })
})

describe('convertUnit — temperature (offset family)', () => {
  it('°C ↔ °F at reference points', () => {
    expect(convertUnit(0, '°C', '°F')).toBeCloseTo(32, 10)
    expect(convertUnit(100, '°C', '°F')).toBeCloseTo(212, 10)
    expect(convertUnit(-40, '°C', '°F')).toBeCloseTo(-40, 10)
    expect(convertUnit(32, '°F', '°C')).toBeCloseTo(0, 10)
    expect(convertUnit(212, '°F', '°C')).toBeCloseTo(100, 10)
  })
  it('round-trips °C → °F → °C (float offsets are irrational)', () => {
    for (const t of [-273.15, -40, 0, 20, 37.5, 100]) {
      expect(convertUnit(convertUnit(t, '°C', '°F'), '°F', '°C')).toBeCloseTo(t, 9)
    }
  })
  it('K ↔ °C', () => {
    expect(convertUnit(273.15, 'K', '°C')).toBeCloseTo(0, 10)
    expect(convertUnit(0, '°C', 'K')).toBeCloseTo(273.15, 10)
    expect(convertUnit(300, 'K', '°F')).toBeCloseTo(80.33, 2)
  })
})

describe('convertUnit — scale families', () => {
  it('pressure', () => {
    expect(convertUnit(1013.25, 'hPa', 'inHg')).toBeCloseTo(29.921, 2)
    expect(convertUnit(1, 'kPa', 'hPa')).toBeCloseTo(10, 10)
    expect(convertUnit(1, 'psi', 'hPa')).toBeCloseTo(68.9476, 4)
  })
  it('speed', () => {
    expect(convertUnit(3.6, 'km/h', 'm/s')).toBeCloseTo(1, 10)
    expect(convertUnit(1, 'm/s', 'km/h')).toBeCloseTo(3.6, 10)
    expect(convertUnit(1, 'mph', 'm/s')).toBeCloseTo(0.44704, 6)
  })
  it('length', () => {
    expect(convertUnit(1, 'in', 'mm')).toBeCloseTo(25.4, 10)
    expect(convertUnit(1000, 'mm', 'm')).toBeCloseTo(1, 10)
  })
  it('energy', () => {
    expect(convertUnit(1, 'kWh', 'Wh')).toBeCloseTo(1000, 10)
    expect(convertUnit(1, 'MWh', 'kWh')).toBeCloseTo(1000, 10)
  })
  it('concentration-volume', () => {
    expect(convertUnit(1, 'ppm', 'ppb')).toBeCloseTo(1000, 10)
  })
  it('mass', () => {
    expect(convertUnit(1, 'kg', 'lb')).toBeCloseTo(2.20462, 4)
    expect(convertUnit(1, 'lb', 'kg')).toBeCloseTo(0.453592, 6)
  })
})

describe('convertUnit — identity', () => {
  it('same unit is identity (single-unit dimensions included)', () => {
    expect(convertUnit(5, 'lx', 'lx')).toBe(5)
    expect(convertUnit(42, '%', '%')).toBe(42)
    expect(convertUnit(7.5, 'W/m²', 'W/m²')).toBe(7.5)
  })
})

describe('convertUnit — refusal (cross-dimension / unknown)', () => {
  it('throws UnitConversionError on cross-dimension', () => {
    expect(() => convertUnit(1, '°C', 'hPa')).toThrow(UnitConversionError)
    try {
      convertUnit(1, '°C', 'hPa')
    } catch (err) {
      expect(err).toBeInstanceOf(UnitConversionError)
      if (err instanceof UnitConversionError) {
        expect(err.reason).toBe('cross-dimension')
        expect(err.from).toBe('°C')
        expect(err.to).toBe('hPa')
      }
    }
  })
  it('refuses VA ↔ W (apparent-power is deliberately separate from power)', () => {
    expect(() => convertUnit(1, 'VA', 'W')).toThrow(UnitConversionError)
    expect(tryConvertUnit(1, 'VA', 'W')).toBeUndefined()
  })
  it('throws on unknown units both directions', () => {
    expect(() => convertUnit(1, 'banana', '°C')).toThrow(UnitConversionError)
    expect(() => convertUnit(1, '°C', 'banana')).toThrow(UnitConversionError)
  })
})

describe('tryConvertUnit — graceful variant', () => {
  it('converts when valid', () => {
    expect(tryConvertUnit(20, '°C', '°F')).toBeCloseTo(68, 10)
  })
  it('returns undefined on refusal, never throws', () => {
    expect(tryConvertUnit(1, '°C', 'hPa')).toBeUndefined()
    expect(tryConvertUnit(1, 'banana', 'kg')).toBeUndefined()
    expect(tryConvertUnit(1, 'kg', 'banana')).toBeUndefined()
  })
})

describe('canConvertUnit', () => {
  it('true for same dimension + identity, false otherwise', () => {
    expect(canConvertUnit('°C', '°F')).toBe(true)
    expect(canConvertUnit('lx', 'lx')).toBe(true)
    expect(canConvertUnit('°C', 'hPa')).toBe(false)
    expect(canConvertUnit('banana', '°C')).toBe(false)
  })
})

describe('unitsForDimension', () => {
  it('returns exactly the temperature units (canonical first)', () => {
    expect(unitsForDimension('temperature')).toEqual(['°C', '°F', 'K'])
  })
  it('returns single-element list for single-unit dimensions', () => {
    expect(unitsForDimension('percentage')).toEqual(['%'])
    expect(unitsForDimension('illuminance')).toEqual(['lx'])
  })
})

describe('UNIT_TABLE integrity', () => {
  it('only the temperature family carries a non-zero offset', () => {
    for (const [unit, spec] of Object.entries(UNIT_TABLE)) {
      if (spec.dimension === 'temperature') continue
      expect(spec.offset, `${unit} offset`).toBe(0)
    }
  })
  it('every canonical unit is factor 1 / offset 0', () => {
    const canonical: readonly KnownUnit[] = [
      '°C',
      'hPa',
      'm/s',
      'mm/h',
      'm',
      'lx',
      'W/m²',
      'W',
      'VA',
      'Wh',
      'V',
      'A',
      'ppm',
      'µg/m³',
      'kg',
      '%',
    ]
    for (const unit of canonical) {
      const spec = UNIT_TABLE[unit]
      expect(spec.factor, `${unit} factor`).toBe(1)
      expect(spec.offset, `${unit} offset`).toBe(0)
    }
  })
})
