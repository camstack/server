import { describe, it, expect } from 'vitest'
import { DiscoveredChildDeviceSchema } from '../capabilities/device-discovery.cap.js'
import { DeviceType } from '../device/device-type.js'

describe('DiscoveredChildDevice — shared adoption candidate fields', () => {
  it('accepts a flat Hub candidate with the new optional fields omitted', () => {
    const flat = DiscoveredChildDeviceSchema.parse({
      childNativeId: 'reolink:ch0',
      name: 'Channel 0',
      type: DeviceType.Camera,
      status: 'online',
      metadata: {},
      alreadyAdopted: false,
      adoptedDeviceId: null,
    })
    expect(flat.children).toBeUndefined()
    expect(flat.sourceInfo).toBeUndefined()
  })

  it('accepts a nested integration candidate with children + sourceInfo + caps', () => {
    const nested = DiscoveredChildDeviceSchema.parse({
      childNativeId: 'ha:dev:abc',
      name: 'Kitchen Light',
      type: DeviceType.Light,
      status: 'online',
      metadata: {},
      alreadyAdopted: false,
      adoptedDeviceId: null,
      capabilities: ['switch', 'brightness'],
      features: ['light-color-rgb'],
      sourceInfo: { id: 'light.kitchen', system: 'homeassistant', deviceClass: 'light' },
      children: [
        {
          childNativeId: 'ha:ent:light.kitchen',
          name: 'Kitchen Light',
          type: DeviceType.Light,
          status: 'online',
          metadata: {},
          alreadyAdopted: false,
          adoptedDeviceId: null,
        },
      ],
    })
    expect(nested.children).toHaveLength(1)
    expect(nested.capabilities).toContain('brightness')
    expect(nested.sourceInfo?.system).toBe('homeassistant')
  })

  it('accepts manufacturer + integration metadata and round-trips them', () => {
    const parsed = DiscoveredChildDeviceSchema.parse({
      childNativeId: 'ha:dev:robot',
      name: 'Robot piano terra',
      type: DeviceType.Generic,
      status: 'online',
      metadata: {
        model: 'dreame.vacuum.r2538z',
        manufacturer: 'Dreametech™',
        integration: 'dreame_vacuum',
      },
      alreadyAdopted: false,
      adoptedDeviceId: null,
    })
    expect(parsed.metadata.model).toBe('dreame.vacuum.r2538z')
    expect(parsed.metadata.manufacturer).toBe('Dreametech™')
    expect(parsed.metadata.integration).toBe('dreame_vacuum')
  })

  it('treats manufacturer + integration as optional (backward-compatible)', () => {
    const parsed = DiscoveredChildDeviceSchema.parse({
      childNativeId: 'reolink:ch0',
      name: 'Channel 0',
      type: DeviceType.Camera,
      status: 'online',
      metadata: {},
      alreadyAdopted: false,
      adoptedDeviceId: null,
    })
    expect(parsed.metadata.manufacturer).toBeUndefined()
    expect(parsed.metadata.integration).toBeUndefined()
  })

  it('rejects a malformed nested child (invalid status)', () => {
    expect(() =>
      DiscoveredChildDeviceSchema.parse({
        childNativeId: 'ha:dev:bad',
        name: 'Bad',
        type: DeviceType.Light,
        status: 'online',
        metadata: {},
        alreadyAdopted: false,
        adoptedDeviceId: null,
        children: [
          {
            childNativeId: 'ha:ent:bad',
            name: 'Bad child',
            type: DeviceType.Light,
            status: 'not-a-real-status',
            metadata: {},
            alreadyAdopted: false,
            adoptedDeviceId: null,
          },
        ],
      }),
    ).toThrow()
  })
})
