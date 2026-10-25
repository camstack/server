import type { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { BoschHomeConnectProviderAddon } from '../home-connect/addon.js'
import { BoschHomeComProviderAddon } from '../homecom/addon.js'
import { BoschShcProviderAddon } from '../shc/addon.js'

class ShcStableIdProbe extends BoschShcProviderAddon {
  expose(type: DeviceType, config?: Record<string, unknown>): string {
    return this.generateStableId(type, config)
  }
}

class HomeComStableIdProbe extends BoschHomeComProviderAddon {
  expose(type: DeviceType, config?: Record<string, unknown>): string {
    return this.generateStableId(type, config)
  }
}

class HomeConnectStableIdProbe extends BoschHomeConnectProviderAddon {
  expose(type: DeviceType, config?: Record<string, unknown>): string {
    return this.generateStableId(type, config)
  }
}

describe('Bosch provider generateStableId', () => {
  it('SHC: throws without brokerId or shcDeviceId', () => {
    const probe = new ShcStableIdProbe()
    expect(() => probe.expose('climate' as DeviceType, {})).toThrow(/brokerId/)
    expect(() => probe.expose('climate' as DeviceType, { brokerId: 'int-1' })).toThrow(
      /shcDeviceId/,
    )
  })

  it('SHC: stable id from broker + device', () => {
    const probe = new ShcStableIdProbe()
    expect(probe.expose('climate' as DeviceType, { brokerId: 'int-1', shcDeviceId: 'dev-a' })).toBe(
      'bosch-shc:int-1:dev-a',
    )
  })

  it('HomeCom: throws without brokerId or nativeId', () => {
    const probe = new HomeComStableIdProbe()
    expect(() => probe.expose('climate' as DeviceType, {})).toThrow(/brokerId/)
    expect(() => probe.expose('climate' as DeviceType, { brokerId: 'int-1' })).toThrow(/nativeId/)
  })

  it('Home Connect: throws without brokerId or haId', () => {
    const probe = new HomeConnectStableIdProbe()
    expect(() => probe.expose('dishwasher' as DeviceType, {})).toThrow(/brokerId/)
    expect(() => probe.expose('dishwasher' as DeviceType, { brokerId: 'int-1' })).toThrow(/haId/)
  })
})
