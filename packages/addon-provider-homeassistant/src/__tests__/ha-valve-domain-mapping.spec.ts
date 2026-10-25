import { describe, it, expect } from 'vitest'
import { DeviceType, DeviceFeature } from '@camstack/types'
import { mapHaEntityToCamStack, inferParentDeviceType } from '../ha-domain-mapping.js'

describe('ha-domain-mapping — valve', () => {
  it('valve.* → DeviceType.Valve, capabilities: [valve]', () => {
    const m = mapHaEntityToCamStack({ domain: 'valve', deviceClass: null, attributes: {} })
    expect(m).not.toBeNull()
    expect(m?.deviceType).toBe(DeviceType.Valve)
    expect(m?.role).toBeNull()
    expect(m?.capabilities).toEqual(['valve'])
  })

  it('sets ValvePositionable iff supported_features & 4 (SET_POSITION)', () => {
    // SET_POSITION bit set (4) → positionable.
    const withPos = mapHaEntityToCamStack({
      domain: 'valve',
      deviceClass: 'water',
      attributes: { supported_features: 1 | 2 | 4 | 8 },
    })
    expect(withPos?.features).toContain(DeviceFeature.ValvePositionable)

    // OPEN | CLOSE | STOP only (no SET_POSITION) → not positionable.
    const noPos = mapHaEntityToCamStack({
      domain: 'valve',
      deviceClass: 'gas',
      attributes: { supported_features: 1 | 2 | 8 },
    })
    expect(noPos?.features).not.toContain(DeviceFeature.ValvePositionable)
    expect(noPos?.features).toEqual([])
  })

  it('omits ValvePositionable when supported_features is absent', () => {
    const m = mapHaEntityToCamStack({ domain: 'valve', deviceClass: null, attributes: {} })
    expect(m?.features).toEqual([])
  })
})

describe('ha-domain-mapping — valve parent-type priority', () => {
  it('a valve-only device infers DeviceType.Valve', () => {
    const valve = mapHaEntityToCamStack({ domain: 'valve', deviceClass: null, attributes: {} })
    expect(inferParentDeviceType([valve])).toBe(DeviceType.Valve)
  })

  it('a device with both cover + valve infers Cover (Cover precedes Valve)', () => {
    const cover = mapHaEntityToCamStack({ domain: 'cover', deviceClass: null, attributes: {} })
    const valve = mapHaEntityToCamStack({ domain: 'valve', deviceClass: null, attributes: {} })
    expect(inferParentDeviceType([valve, cover])).toBe(DeviceType.Cover)
    expect(inferParentDeviceType([cover, valve])).toBe(DeviceType.Cover)
  })

  it('valve outranks a sensor-only sibling', () => {
    const valve = mapHaEntityToCamStack({ domain: 'valve', deviceClass: null, attributes: {} })
    const sensor = mapHaEntityToCamStack({
      domain: 'sensor',
      deviceClass: 'temperature',
      attributes: {},
    })
    expect(inferParentDeviceType([sensor, valve])).toBe(DeviceType.Valve)
  })
})
