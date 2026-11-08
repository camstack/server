import { describe, expect, it } from 'vitest'
import type { AutomationDevice } from '../automation-data'
import { deviceIdOfBinding, globalBindingFor } from '../expression-binding-devices'

const devices: readonly AutomationDevice[] = [
  { id: 1, name: 'Lamp A', stableId: 'lamp', addonId: 'hue' },
  { id: 2, name: 'Lamp B', stableId: 'lamp', addonId: 'tuya' },
  { id: 3, name: 'Solo', stableId: 'solo', addonId: 'hue' },
]

describe('expression binding devices', () => {
  it('authors the owning addon with the stable id', () => {
    expect(globalBindingFor(devices, { deviceId: 2, cap: 'switch', fieldPath: 'on' })).toEqual({
      kind: 'global',
      sourceStableId: 'lamp',
      addonId: 'tuya',
      cap: 'switch',
      fieldPath: 'on',
    })
  })

  it('reads the pair back to the right device when two addons share a stable id', () => {
    const binding = globalBindingFor(devices, { deviceId: 2, cap: 'switch', fieldPath: 'on' })
    expect(deviceIdOfBinding(devices, binding)).toBe(2)
  })

  it('resolves a legacy binding only while its stable id is unique', () => {
    const legacy = {
      kind: 'global',
      sourceStableId: 'solo',
      cap: 'switch',
      fieldPath: 'on',
    } as const
    expect(deviceIdOfBinding(devices, legacy)).toBe(3)
    expect(deviceIdOfBinding(devices, { ...legacy, sourceStableId: 'lamp' })).toBe(0)
  })
})
