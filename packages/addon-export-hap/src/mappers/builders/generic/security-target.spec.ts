import type { AlarmArmMode } from '@camstack/types'
import { Characteristic } from '@homebridge/hap-nodejs'
import { describe, expect, it } from 'vitest'
import { armModeForTarget, targetValidValuesFor } from './security-target.js'

const T = Characteristic.SecuritySystemTargetState

describe('targetValidValuesFor — what HomeKit is allowed to ask for', () => {
  it('offers DISARM plus one value per mode the panel accepts', () => {
    expect(targetValidValuesFor(['home', 'away'])).toEqual([T.STAY_ARM, T.AWAY_ARM, T.DISARM])
  })

  it('never offers an arm HomeKit could not be honoured on', () => {
    // A night-only panel must not render a STAY tile the panel will refuse.
    expect(targetValidValuesFor(['night'])).toEqual([T.NIGHT_ARM, T.DISARM])
  })

  it('collapses the two modes that share a HomeKit value without duplicating it', () => {
    // vacation and away both read AWAY; home and custom_bypass both read STAY.
    expect(targetValidValuesFor(['away', 'vacation'])).toEqual([T.AWAY_ARM, T.DISARM])
    expect(targetValidValuesFor(['home', 'custom_bypass'])).toEqual([T.STAY_ARM, T.DISARM])
  })

  it('always keeps DISARM — disarming is not one of the panel’s arm modes', () => {
    expect(targetValidValuesFor(['away'])).toContain(T.DISARM)
  })

  it('constrains NOTHING when the panel named no modes — empty is unknown, not none', () => {
    // A provider that has not populated `availableModes` is indistinguishable
    // from one that answered "none", and locking HomeKit down to DISARM-only
    // on a guess takes a working panel's controls away. `null` means "leave
    // HomeKit's own four values alone"; the caller logs it.
    expect(targetValidValuesFor([])).toBeNull()
  })
})

describe('armModeForTarget — the mode the PANEL takes, not the one HomeKit named', () => {
  it('maps the three HomeKit arms onto the panel’s primary mode', () => {
    const all: readonly AlarmArmMode[] = ['home', 'away', 'night', 'vacation', 'custom_bypass']
    expect(armModeForTarget(T.STAY_ARM, all)).toBe('home')
    expect(armModeForTarget(T.AWAY_ARM, all)).toBe('away')
    expect(armModeForTarget(T.NIGHT_ARM, all)).toBe('night')
  })

  it('falls back to the second mode sharing that HomeKit value when the first is not offered', () => {
    // The bug this prevents: a panel that only does `custom_bypass` publishes a
    // STAY tile (STAY is the value custom_bypass maps to) and the naive
    // translation sends `home`, which the panel refuses.
    expect(armModeForTarget(T.STAY_ARM, ['custom_bypass'])).toBe('custom_bypass')
    expect(armModeForTarget(T.AWAY_ARM, ['vacation'])).toBe('vacation')
  })

  it('prefers the primary when BOTH modes behind a value are available', () => {
    expect(armModeForTarget(T.STAY_ARM, ['custom_bypass', 'home'])).toBe('home')
    expect(armModeForTarget(T.AWAY_ARM, ['vacation', 'away'])).toBe('away')
  })

  it('refuses a value the panel accepts NO mode for', () => {
    expect(armModeForTarget(T.NIGHT_ARM, ['away'])).toBeNull()
  })

  it('trusts the panel when it named no modes at all', () => {
    // Same reading as `targetValidValuesFor([])`: unknown, not empty. The arm
    // goes through with the primary mode and the panel is the one that refuses.
    expect(armModeForTarget(T.STAY_ARM, [])).toBe('home')
  })

  it('returns null for DISARM — that is a different COMMAND, not an arm mode', () => {
    expect(armModeForTarget(T.DISARM, ['away'])).toBeNull()
  })
})
