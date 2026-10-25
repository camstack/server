import { describe, it, expect } from 'vitest'
import {
  SourceInfoSchema,
  synthesizeSourceInfo,
  mergeSourceInfo,
  normalizeUnit,
  extractSourceInfoFromMetadata,
  SOURCE_INFO_METADATA_KEY,
  type SourceInfo,
} from '../device/source-info.js'

describe('SourceInfoSchema', () => {
  it('accepts a minimal SourceInfo with only id + system', () => {
    const parsed = SourceInfoSchema.parse({ id: 'switch.kitchen', system: 'homeassistant' })
    expect(parsed.id).toBe('switch.kitchen')
    expect(parsed.system).toBe('homeassistant')
  })

  it('accepts a fully-populated SourceInfo (id + system + uniqueId + raw)', () => {
    const full: SourceInfo = {
      id: 'sensor.kitchen_temp',
      system: 'homeassistant',
      uniqueId: '00:11:22:33:44:55-temp',
      raw: { manufacturer: 'Aqara', model: 'WSDCGQ11LM' },
    }
    expect(SourceInfoSchema.parse(full)).toEqual(full)
  })

  it('does NOT accept rendering-hint fields (unit, deviceClass, precision, etc.)', () => {
    // These fields were removed from SourceInfoSchema in the identity-only
    // refactor. Zod strips unknown keys by default (passthrough vs strip mode),
    // but the TypeScript type must no longer reference them.
    const stripped = SourceInfoSchema.parse({
      id: 'sensor.x',
      system: 'homeassistant',
      unit: '°C',
      deviceClass: 'temperature',
      precision: 1,
    })
    // Zod strips unknown fields by default — unit/deviceClass/precision are
    // removed from the parsed output.
    expect(stripped).not.toHaveProperty('unit')
    expect(stripped).not.toHaveProperty('deviceClass')
    expect(stripped).not.toHaveProperty('precision')
  })

  it('rejects missing id', () => {
    expect(SourceInfoSchema.safeParse({ system: 'homeassistant' }).success).toBe(false)
  })

  it('rejects missing system', () => {
    expect(SourceInfoSchema.safeParse({ id: 'foo' }).success).toBe(false)
  })
})

describe('synthesizeSourceInfo', () => {
  it('builds { id: stableId, system: addonId } for backfill', () => {
    const synth = synthesizeSourceInfo({
      stableId: 'mac-aa:bb:cc:dd:ee:ff',
      addonId: 'addon-provider-reolink',
    })
    expect(synth).toEqual({
      id: 'mac-aa:bb:cc:dd:ee:ff',
      system: 'addon-provider-reolink',
    })
  })

  it('passes through Zod validation', () => {
    const synth = synthesizeSourceInfo({ stableId: 's1', addonId: 'a1' })
    expect(SourceInfoSchema.parse(synth)).toEqual(synth)
  })
})

describe('mergeSourceInfo', () => {
  const base: SourceInfo = { id: 'sensor.foo', system: 'homeassistant' }

  it('shallow-merges new fields', () => {
    const merged = mergeSourceInfo(base, { uniqueId: 'abc-123' })
    expect(merged).toEqual({ ...base, uniqueId: 'abc-123' })
  })

  it('overrides existing fields', () => {
    const withId: SourceInfo = { id: 'sensor.old', system: 'homeassistant' }
    const merged = mergeSourceInfo(withId, { id: 'sensor.new' })
    expect(merged.id).toBe('sensor.new')
  })

  it('ignores undefined patch values (no clobber)', () => {
    const withUniqueId: SourceInfo = {
      id: 'sensor.foo',
      system: 'homeassistant',
      uniqueId: 'existing',
    }
    const merged = mergeSourceInfo(withUniqueId, { uniqueId: undefined })
    expect(merged.uniqueId).toBe('existing')
  })

  it('shallow-merges the raw bag instead of replacing it', () => {
    const withRaw: SourceInfo = { ...base, raw: { a: 1, b: 2 } }
    const merged = mergeSourceInfo(withRaw, { raw: { b: 99, c: 3 } })
    expect(merged.raw).toEqual({ a: 1, b: 99, c: 3 })
  })

  it('does not mutate the previous object', () => {
    const snapshot = { ...base }
    mergeSourceInfo(base, { uniqueId: 'new-id' })
    expect(base).toEqual(snapshot)
  })
})

describe('normalizeUnit', () => {
  it.each([
    ['°C', '°C'],
    ['C', '°C'],
    ['celsius', '°C'],
    ['Celsius', '°C'],
    ['°F', '°F'],
    ['fahrenheit', '°F'],
    ['%', '%'],
    ['percent', '%'],
    ['lx', 'lx'],
    ['lux', 'lx'],
    ['hPa', 'hPa'],
    ['hectopascal', 'hPa'],
    ['W', 'W'],
    ['watt', 'W'],
    ['kWh', 'kWh'],
    ['kilowatt-hour', 'kWh'],
    ['V', 'V'],
    ['A', 'A'],
    ['mA', 'mA'],
    ['ppm', 'ppm'],
    ['km/h', 'km/h'],
    ['kph', 'km/h'],
  ])('canonicalises %s → %s', (input, expected) => {
    expect(normalizeUnit(input)).toBe(expected)
  })

  it('returns undefined for null / undefined / empty / whitespace', () => {
    expect(normalizeUnit(null)).toBeUndefined()
    expect(normalizeUnit(undefined)).toBeUndefined()
    expect(normalizeUnit('')).toBeUndefined()
    expect(normalizeUnit('   ')).toBeUndefined()
  })

  it('passes through unknown units (does not lose information)', () => {
    expect(normalizeUnit('quux')).toBe('quux')
    expect(normalizeUnit('rpm')).toBe('rpm')
  })

  it('trims whitespace on passthrough', () => {
    expect(normalizeUnit('  rpm  ')).toBe('rpm')
  })
})

describe('extractSourceInfoFromMetadata', () => {
  it('returns null when metadata is null / undefined', () => {
    expect(extractSourceInfoFromMetadata(null)).toBeNull()
    expect(extractSourceInfoFromMetadata(undefined)).toBeNull()
  })

  it('returns null when the sourceInfo key is missing', () => {
    expect(extractSourceInfoFromMetadata({ manufacturer: 'Reolink' })).toBeNull()
  })

  it('returns null when the persisted sourceInfo fails validation', () => {
    expect(
      extractSourceInfoFromMetadata({
        [SOURCE_INFO_METADATA_KEY]: { id: 42 /* not a string */, system: 'x' },
      }),
    ).toBeNull()
  })

  it('returns the validated SourceInfo when present + valid', () => {
    const inner: SourceInfo = { id: 'sensor.x', system: 'homeassistant', uniqueId: 'abc' }
    expect(extractSourceInfoFromMetadata({ [SOURCE_INFO_METADATA_KEY]: inner })).toEqual(inner)
  })

  it('coexists with other metadata fields', () => {
    const inner: SourceInfo = { id: 'sensor.x', system: 'homeassistant' }
    const got = extractSourceInfoFromMetadata({
      manufacturer: 'Aqara',
      model: 'WSDCGQ11LM',
      firmware: '1.0.0',
      [SOURCE_INFO_METADATA_KEY]: inner,
    })
    expect(got).toEqual(inner)
  })
})
