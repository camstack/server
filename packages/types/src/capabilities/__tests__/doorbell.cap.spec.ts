import { describe, it, expect } from 'vitest'
import { EXTENSION_SLOT_IDS } from '../../generated/extension-slots.js'
import { doorbellCapability } from '../doorbell.cap.js'
import { DeviceType } from '../../device/device-type.js'

/**
 * The `doorbell` cap is served by per-device driver natives (Reolink registers
 * at camera level via `registerNativeCap`) and by a composed doorbell — a
 * camera's customization (D670, D671). These assertions pin the declaration
 * both depend on.
 */
describe('doorbellCapability', () => {
  it('applies to cameras (measured Reolink camera-level registration) and buttons', () => {
    expect(doorbellCapability.deviceTypes).toContain(DeviceType.Camera)
    expect(doorbellCapability.deviceTypes).toContain(DeviceType.Button)
  })

  it('stays device-native so per-device driver registrations keep working', () => {
    expect(doorbellCapability.deviceNative).toBe(true)
    expect(doorbellCapability.scope).toBe('device')
  })

  it('contributes no settings section', () => {
    expect('exposesDeviceSettings' in doorbellCapability).toBe(false)
  })

  it('keeps the press-counter runtime-state slice', () => {
    const parsed = doorbellCapability.runtimeState.safeParse({
      lastPressedAt: 123,
      pressCountSinceStart: 4,
    })
    expect(parsed.success).toBe(true)
  })
})

describe('the doorbell after slice 6 (D671)', () => {
  it('is native or composed — no wrapper registration, no extension slot', () => {
    expect('kind' in doorbellCapability).toBe(false)
    expect('defaultActive' in doorbellCapability).toBe(false)
    expect('extensionSlots' in doorbellCapability).toBe(false)
    expect(EXTENSION_SLOT_IDS).toEqual(['linked-devices'])
  })
})
