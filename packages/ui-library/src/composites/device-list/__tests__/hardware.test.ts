import { describe, it, expect } from 'vitest'
import type { DeviceItemDevice } from '../../device-item/helpers'
import { hardwareLabel, metadataEntries, metadataValueString } from '../hardware'

function withMetadata(metadata: Record<string, unknown> | null | undefined): DeviceItemDevice {
  return {
    id: 1,
    stableId: 's-1',
    addonId: 'a',
    type: 'camera',
    name: 'Cam',
    online: true,
    disabled: false,
    parentDeviceId: null,
    features: [],
    metadata,
  }
}

describe('metadataValueString — defensive unknown → string', () => {
  it('passes trimmed non-empty strings', () => {
    expect(metadataValueString('  Reolink ')).toBe('Reolink')
  })
  it('coerces finite numbers + booleans', () => {
    expect(metadataValueString(42)).toBe('42')
    expect(metadataValueString(true)).toBe('true')
  })
  it('skips empty strings, null, objects, arrays, NaN', () => {
    expect(metadataValueString('   ')).toBeNull()
    expect(metadataValueString(null)).toBeNull()
    expect(metadataValueString({ a: 1 })).toBeNull()
    expect(metadataValueString([1, 2])).toBeNull()
    expect(metadataValueString(Number.NaN)).toBeNull()
  })
})

describe('hardwareLabel', () => {
  it('joins manufacturer · model when both present', () => {
    expect(hardwareLabel(withMetadata({ manufacturer: 'Dreame', model: 'X40' }))).toBe(
      'Dreame · X40',
    )
  })
  it('returns whichever single field is present', () => {
    expect(hardwareLabel(withMetadata({ manufacturer: 'Dreame' }))).toBe('Dreame')
    expect(hardwareLabel(withMetadata({ model: 'X40' }))).toBe('X40')
  })
  it('returns null when neither present (or no metadata)', () => {
    expect(hardwareLabel(withMetadata({ firmware: '1.0' }))).toBeNull()
    expect(hardwareLabel(withMetadata(null))).toBeNull()
    expect(hardwareLabel(withMetadata(undefined))).toBeNull()
  })
})

describe('metadataEntries — full identity blob for the tooltip', () => {
  it('includes every string-coercible non-empty entry in insertion order', () => {
    const entries = metadataEntries({
      manufacturer: 'Reolink',
      model: 'RLC-810A',
      firmware: 'v3.1',
      sn: 12345,
      empty: '   ',
      blob: { nested: true },
    })
    expect(entries).toEqual([
      { key: 'manufacturer', value: 'Reolink' },
      { key: 'model', value: 'RLC-810A' },
      { key: 'firmware', value: 'v3.1' },
      { key: 'sn', value: '12345' },
    ])
  })
  it('is empty for absent metadata', () => {
    expect(metadataEntries(null)).toEqual([])
    expect(metadataEntries(undefined)).toEqual([])
  })
})
