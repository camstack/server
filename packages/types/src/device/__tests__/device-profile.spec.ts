import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BATTERY_DEVICE_PROFILE,
  DEVICE_PROFILES,
  deviceMatchesProfile,
  resolveDeviceProfile,
} from '../device-profile.js'
import { DeviceFeature } from '../device-type.js'

describe('resolveDeviceProfile', () => {
  it('matches a battery camera on its feature', () => {
    expect(resolveDeviceProfile(['native-snapshot', DeviceFeature.BatteryOperated])).toBe(
      BATTERY_DEVICE_PROFILE,
    )
  })

  it('returns null for a mains camera', () => {
    expect(resolveDeviceProfile(['native-snapshot', 'pan-tilt-zoom'])).toBeNull()
  })

  /**
   * The load-bearing consequence, and the reason 4f exists: an EMPTY or
   * undefined feature array resolves to no profile, so a battery camera silently
   * becomes `audioMode: 'always-on'` and gets dialed. Callers must therefore
   * never hand `[]` to this function to mean "I could not read the features" —
   * see `DeviceFeaturesMirror` in addon-pipeline-orchestrator.
   */
  it('cannot tell "no features" from "features unknown" — callers must not conflate them', () => {
    expect(resolveDeviceProfile([])).toBeNull()
    expect(resolveDeviceProfile(undefined)).toBeNull()
    expect(deviceMatchesProfile([], BATTERY_DEVICE_PROFILE)).toBe(false)
  })
})

describe('BATTERY_DEVICE_PROFILE', () => {
  it('keeps a battery camera off the always-on paths', () => {
    expect(BATTERY_DEVICE_PROFILE.defaults.audioMode).toBe('disabled')
    expect(BATTERY_DEVICE_PROFILE.defaults.detectionMode).toBe('on-motion')
  })

  it('is the only registered profile, and is reachable from the registry', () => {
    expect(DEVICE_PROFILES).toContain(BATTERY_DEVICE_PROFILE)
  })

  /**
   * `DeviceProfile.settings` is a declared extension point with **no reader
   * anywhere in the workspace**. It used to carry
   * `snapshot.minRefreshIntervalSec: 3600` and `streamBroker.preBufferEnabled:
   * false`, both of which read as live policy and were neither. The real
   * enforcement is elsewhere and keyed off `DeviceFeature.BatteryOperated`
   * directly: `BATTERY_DEFAULT_MAX_AGE_S` in `snapshot.addon.ts`, and
   * `getEffectivePreBufferSec` in `stream-broker-manager.ts`.
   *
   * A leftover that describes the right design is worse than nothing — it
   * reads as verification. Keep this empty until something actually consumes it.
   */
  it('declares no settings — nothing reads them, so an entry here would be fiction', () => {
    expect(Object.keys(BATTERY_DEVICE_PROFILE.settings)).toEqual([])
  })

  it('no profile in the registry claims settings while the field has no consumer', () => {
    for (const profile of DEVICE_PROFILES) {
      expect(Object.keys(profile.settings)).toEqual([])
    }
  })

  it('the settings field documents that it is unread', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, '../device-profile.ts'), 'utf8')
    expect(source).toMatch(/no consumer|unread|nothing reads/i)
  })
})
