/**
 * A device without configuration cannot be online (D376).
 */
import { describe, expect, it } from 'vitest'
import { persistedOnlineFallback } from '../device-online-fallback.js'

describe('persisted online fallback', () => {
  it('refuses to call a config-less top-level row online', () => {
    expect(
      persistedOnlineFallback({ registryPresent: true, parentDeviceId: null, config: {} }),
    ).toBe(false)
    expect(
      persistedOnlineFallback({ registryPresent: true, parentDeviceId: null, config: undefined }),
    ).toBe(false)
  })

  it('keeps the legacy assumption for a configured top-level row', () => {
    expect(
      persistedOnlineFallback({
        registryPresent: true,
        parentDeviceId: null,
        config: { host: '192.168.10.40' },
      }),
    ).toBe(true)
  })

  it('leaves children alone — an accessory legitimately carries no config', () => {
    expect(
      persistedOnlineFallback({ registryPresent: true, parentDeviceId: 105, config: {} }),
    ).toBe(true)
  })

  it('never reports online in the offline view (no registry)', () => {
    expect(
      persistedOnlineFallback({
        registryPresent: false,
        parentDeviceId: null,
        config: { host: '192.168.10.40' },
      }),
    ).toBe(false)
  })
})
