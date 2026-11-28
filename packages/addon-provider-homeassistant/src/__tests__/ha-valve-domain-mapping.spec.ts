import { describe, it, expect } from 'vitest'
import { DeviceType } from '@dominevo/types'
import { mapHaEntityToCamStack, inferParentDeviceType } from '../ha-domain-mapping.js'

describe('ha-domain-mapping — valve', () => {
  it('valve.* → DeviceType.Valve, capabilities: [valve]', () => {
    const m = mapHaEntityToCamStack({ domain: 'valve', deviceClass: null, attributes: {} })
    expect(m).not.toBeNull()
    expect(m?.deviceType).toBe(DeviceType.Valve)
    expect(m?.role).toBeNull()
    expect(m?.capabilities).toEqual(['valve'])
  })

  it('carries supported_features through for the child; no feature is listed (derived from the cap, #459)', () => {
    const withPos = mapHaEntityToCamStack({
      domain: 'valve',
      deviceClass: 'water',
      attributes: { supported_features: 1 | 2 | 4 | 8 },
    })
    expect(withPos?.supportedFeatures).toBe(15)
    expect(withPos?.features).toBeUndefined()
  })

  it('omits supportedFeatures when the attribute is absent', () => {
    const m = mapHaEntityToCamStack({ domain: 'valve', deviceClass: null, attributes: {} })
    expect(m?.supportedFeatures).toBeUndefined()
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
