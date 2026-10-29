/**
 * Unit spec for the shared child display-name helpers
 * (`stripParentNamePrefix` / `childListName`). These drive the
 * parent-prefix strip used by BOTH the device-detail children list and the
 * devices list-table so a container child reads as its bare label.
 */
import { describe, expect, it } from 'vitest'
import type { DeviceItemDevice } from '../helpers'
import { childListName, stripParentNamePrefix } from '../helpers'

describe('stripParentNamePrefix', () => {
  it('strips an em-dash-joined prefix (Ecowitt style) to the bare label', () => {
    expect(stripParentNamePrefix('Ecowitt Gateway — gateway', 'Ecowitt Gateway')).toBe('gateway')
    expect(stripParentNamePrefix('Ecowitt Gateway — weather-station', 'Ecowitt Gateway')).toBe(
      'weather-station',
    )
  })

  it('strips a plain-space-joined prefix (Dreame style) to the bare label', () => {
    expect(stripParentNamePrefix('Robot primo piano Filter Time Left', 'Robot primo piano')).toBe(
      'Filter Time Left',
    )
    expect(
      stripParentNamePrefix('Robot primo piano Main Brush Time Left', 'Robot primo piano'),
    ).toBe('Main Brush Time Left')
  })

  it('prefers the em-dash separator so an Ecowitt child never keeps a dangling dash', () => {
    // The plain-space prefix `"Ecowitt Gateway "` also matches, but trying
    // `" — "` first yields the clean `"gateway"` rather than `"— gateway"`.
    expect(stripParentNamePrefix('Ecowitt Gateway — gateway', 'Ecowitt Gateway')).not.toContain('—')
  })

  it('returns the name verbatim when the parent name is empty', () => {
    expect(stripParentNamePrefix('Filter Time Left', '')).toBe('Filter Time Left')
  })

  it('strips hyphen and colon separators', () => {
    expect(stripParentNamePrefix('Hub - Temperature', 'Hub')).toBe('Temperature')
    expect(stripParentNamePrefix('Hub: Temperature', 'Hub')).toBe('Temperature')
  })

  it('matches the parent name case-insensitively', () => {
    expect(stripParentNamePrefix('ROBOT primo piano Filter', 'Robot Primo Piano')).toBe('Filter')
  })

  it('keeps the full name when it equals the parent or nothing follows the prefix', () => {
    expect(stripParentNamePrefix('Hub', 'Hub')).toBe('Hub')
    expect(stripParentNamePrefix('Hub - ', 'Hub')).toBe('Hub - ')
    expect(stripParentNamePrefix('Hub  ', 'Hub')).toBe('Hub  ')
  })

  it('does not strip a prefix that is only part of a longer word', () => {
    expect(stripParentNamePrefix('Hubble Sensor', 'Hub')).toBe('Hubble Sensor')
  })

  it('returns the name verbatim when it does not carry the prefix', () => {
    expect(stripParentNamePrefix('Standalone Sensor', 'Some Other Parent')).toBe(
      'Standalone Sensor',
    )
  })
})

describe('childListName', () => {
  const base: DeviceItemDevice = {
    id: 1,
    stableId: 's-1',
    addonId: 'ecowitt',
    type: 'numeric-sensor',
    name: 'Ecowitt Gateway — gateway',
    online: true,
    disabled: false,
    parentDeviceId: 2,
    role: 'numeric-sensor',
  }

  it('strips the parent prefix when no display.label override is set', () => {
    expect(childListName(base, 'Ecowitt Gateway')).toBe('gateway')
  })

  it("honours an operator's display.label over the auto-strip", () => {
    const withLabel: DeviceItemDevice = { ...base, display: { label: 'Custom Label' } }
    expect(childListName(withLabel, 'Ecowitt Gateway')).toBe('Custom Label')
  })

  it('falls back to the verbatim name when there is no prefix and no label', () => {
    const standalone: DeviceItemDevice = { ...base, name: 'Standalone Sensor' }
    expect(childListName(standalone, 'Ecowitt Gateway')).toBe('Standalone Sensor')
  })
})
