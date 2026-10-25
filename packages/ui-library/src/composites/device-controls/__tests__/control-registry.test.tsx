// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { DeviceType } from '@camstack/types'
import { DEVICE_TYPE_CONTROL, resolveDeviceControl, coverHighlight } from '../control-registry'

describe('DEVICE_TYPE_CONTROL', () => {
  it('maps every DeviceType (exhaustive) with InlineControl and HeroCard', () => {
    for (const t of Object.values(DeviceType)) {
      const entry = DEVICE_TYPE_CONTROL[t]
      expect(entry, `Missing entry for DeviceType.${t}`).toBeDefined()
      expect(typeof entry.InlineControl).toBe('function')
      expect(typeof entry.HeroCard).toBe('function')
    }
  })

  it('cover maps to a real non-dummy entry (distinct from others)', () => {
    const cover = DEVICE_TYPE_CONTROL[DeviceType.Cover]
    expect(cover).toBeDefined()
    expect(typeof cover.InlineControl).toBe('function')
    expect(typeof cover.HeroCard).toBe('function')
  })
})

describe('resolveDeviceControl', () => {
  it('returns an entry for a known DeviceType string', () => {
    const entry = resolveDeviceControl('cover')
    expect(entry).toBeDefined()
    expect(entry?.InlineControl).toBeDefined()
    expect(entry?.HeroCard).toBeDefined()
  })

  it('returns null for an unknown string', () => {
    expect(resolveDeviceControl('unknown-type')).toBeNull()
    expect(resolveDeviceControl('')).toBeNull()
  })
})

describe('coverHighlight', () => {
  it('opening → up is accent', () => {
    expect(coverHighlight('opening').up).toBe('accent')
  })

  it('closing → down is accent', () => {
    expect(coverHighlight('closing').down).toBe('accent')
  })

  it('open → up is filled', () => {
    expect(coverHighlight('open').up).toBe('filled')
  })

  it('closed → down is filled', () => {
    expect(coverHighlight('closed').down).toBe('filled')
  })

  it('stopped → all neutral', () => {
    const h = coverHighlight('stopped')
    expect(h.up).toBe('neutral')
    expect(h.stop).toBe('neutral')
    expect(h.down).toBe('neutral')
  })

  it('undefined → all neutral', () => {
    const h = coverHighlight(undefined)
    expect(h.up).toBe('neutral')
    expect(h.stop).toBe('neutral')
    expect(h.down).toBe('neutral')
  })

  it('opening → stop and down are neutral', () => {
    const h = coverHighlight('opening')
    expect(h.stop).toBe('neutral')
    expect(h.down).toBe('neutral')
  })

  it('closing → stop and up are neutral', () => {
    const h = coverHighlight('closing')
    expect(h.stop).toBe('neutral')
    expect(h.up).toBe('neutral')
  })
})
