import { describe, expect, it } from 'vitest'

import { carryForward } from '../exposed-entry.js'

interface Entry {
  deviceId: string
  displayName: string
  settings?: { streamPreference: string }
  capabilities?: readonly string[]
}

describe('carryForward', () => {
  it('keeps the settings a re-expose would otherwise destroy', () => {
    // The live failure: the operator pinned `low`, the accessory came back
    // advertising `auto`, and the pin looked like it had never been written.
    const base: Entry = { deviceId: '101', displayName: 'Camera front door' }
    const existing: Entry = {
      deviceId: '101',
      displayName: 'old',
      settings: { streamPreference: 'low' },
    }

    const merged = carryForward(base, existing, ['settings', 'capabilities'])

    expect(merged.settings).toEqual({ streamPreference: 'low' })
    // Only the listed keys travel — a stale display name must NOT come back.
    expect(merged.displayName).toBe('Camera front door')
  })

  it('lets an EXPLICIT value win over the stored one', () => {
    // A caller passing capabilities is stating a new truth. Preserving the
    // stored list instead would freeze a camera's feature set at whatever it
    // had the first time it was exposed.
    const base: Entry = { deviceId: '101', displayName: 'x', capabilities: ['camera', 'ptz'] }
    const existing: Entry = { deviceId: '101', displayName: 'x', capabilities: ['camera'] }

    expect(carryForward(base, existing, ['capabilities']).capabilities).toEqual(['camera', 'ptz'])
  })

  it('returns the base untouched when nothing was stored before', () => {
    const base: Entry = { deviceId: '101', displayName: 'x' }
    expect(carryForward(base, undefined, ['settings'])).toEqual(base)
  })

  it('does not carry keys that were not asked for', () => {
    const base: Entry = { deviceId: '101', displayName: 'x' }
    const existing: Entry = {
      deviceId: '101',
      displayName: 'x',
      settings: { streamPreference: 'low' },
    }
    expect(carryForward(base, existing, ['capabilities']).settings).toBeUndefined()
  })
})
