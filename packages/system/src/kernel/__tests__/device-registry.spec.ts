import { describe, it, expect, vi } from 'vitest'
import { DeviceRegistry } from '../device-registry.js'
import { DeviceType, DeviceFeature } from '@camstack/types'
import type { IDevice } from '@camstack/types'

let mockIdCounter = 1

function mockDevice(overrides: Partial<IDevice> & { stableId: string }): IDevice {
  return {
    id: mockIdCounter++,
    type: DeviceType.Camera,
    name: 'Test',
    location: null,
    disabled: false,
    online: false,
    features: [],
    config: {} as never,
    ctx: {} as never,
    parentDeviceId: null,
    removeDevice: vi.fn(),
    markOnline: vi.fn(),
    getSettingsUISchema: () => ({ sections: [] }),
    applySettingsPatch: vi.fn(),
    runDeviceAction: vi.fn(),
    ...overrides,
  }
}

function findByStableId(
  registry: DeviceRegistry,
  addonId: string,
  stableId: string,
): IDevice | null {
  return registry.getAllForAddon(addonId).find((d) => d.stableId === stableId) ?? null
}

describe('DeviceRegistry', () => {
  it('registers and retrieves a device by numeric id', () => {
    const registry = new DeviceRegistry()
    const device = mockDevice({ stableId: 'cam-01' })
    registry.register('reolink', device)
    expect(registry.getById(device.id)).toBe(device)
  })

  it('throws on duplicate numeric id', () => {
    const registry = new DeviceRegistry()
    const first = mockDevice({ stableId: 'cam-01' })
    registry.register('reolink', first)
    const duplicate = mockDevice({ stableId: 'cam-02', id: first.id })
    expect(() => registry.register('reolink', duplicate)).toThrow()
  })

  it('allows same stableId across different addons', () => {
    const registry = new DeviceRegistry()
    const a = mockDevice({ stableId: 'cam-01' })
    const b = mockDevice({ stableId: 'cam-01' })
    registry.register('reolink', a)
    registry.register('onvif', b)
    expect(findByStableId(registry, 'reolink', 'cam-01')).toBe(a)
    expect(findByStableId(registry, 'onvif', 'cam-01')).toBe(b)
  })

  it('lists all devices for an addon', () => {
    const registry = new DeviceRegistry()
    registry.register('reolink', mockDevice({ stableId: 'cam-01' }))
    registry.register('reolink', mockDevice({ stableId: 'cam-02' }))
    registry.register('onvif', mockDevice({ stableId: 'cam-03' }))
    expect(registry.getAllForAddon('reolink')).toHaveLength(2)
  })

  it('lists children by parentDeviceId', () => {
    const registry = new DeviceRegistry()
    const parent = mockDevice({ stableId: 'nvr-01' })
    registry.register('reolink', parent)
    registry.register('reolink', mockDevice({ stableId: 'cam-ch1', parentDeviceId: parent.id }))
    registry.register('reolink', mockDevice({ stableId: 'cam-ch2', parentDeviceId: parent.id }))
    registry.register('reolink', mockDevice({ stableId: 'cam-standalone' }))
    expect(registry.getChildren(parent.id)).toHaveLength(2)
  })

  it('removes a device by numeric id', () => {
    const registry = new DeviceRegistry()
    const device = mockDevice({ stableId: 'cam-01' })
    registry.register('reolink', device)
    registry.remove(device.id)
    expect(registry.getById(device.id)).toBeNull()
  })

  it('finds device by feature', () => {
    const registry = new DeviceRegistry()
    registry.register(
      'reolink',
      mockDevice({ stableId: 'cam-01', features: [DeviceFeature.NativeSnapshot] }),
    )
    registry.register('reolink', mockDevice({ stableId: 'cam-02', features: [] }))
    const withSnapshot = registry
      .getAllForAddon('reolink')
      .filter((d) => d.features.includes(DeviceFeature.NativeSnapshot))
    expect(withSnapshot).toHaveLength(1)
    expect(withSnapshot[0]?.stableId).toBe('cam-01')
  })
})
