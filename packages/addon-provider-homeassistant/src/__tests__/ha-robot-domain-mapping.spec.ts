import { describe, it, expect } from 'vitest'
import { DeviceType } from '@camstack/types'
import { mapHaEntityToCamStack } from '../ha-domain-mapping.js'

describe('ha-domain-mapping — vacuum / lawn_mower', () => {
  it('vacuum.* → DeviceType.Vacuum, capabilities: [vacuum-control]', () => {
    const m = mapHaEntityToCamStack({ domain: 'vacuum', deviceClass: null, attributes: {} })
    expect(m).not.toBeNull()
    expect(m?.deviceType).toBe(DeviceType.Vacuum)
    expect(m?.role).toBeNull()
    expect(m?.capabilities).toEqual(['vacuum-control'])
    expect(m?.features).toEqual([])
  })

  it('vacuum.* maps regardless of attributes (battery / fan_speed live via slice)', () => {
    const m = mapHaEntityToCamStack({
      domain: 'vacuum',
      deviceClass: null,
      attributes: { battery_level: 88, fan_speed: 'turbo', fan_speed_list: ['quiet', 'turbo'] },
    })
    expect(m?.deviceType).toBe(DeviceType.Vacuum)
    expect(m?.capabilities).toEqual(['vacuum-control'])
  })

  it('lawn_mower.* → DeviceType.LawnMower, capabilities: [lawn-mower-control]', () => {
    const m = mapHaEntityToCamStack({ domain: 'lawn_mower', deviceClass: null, attributes: {} })
    expect(m).not.toBeNull()
    expect(m?.deviceType).toBe(DeviceType.LawnMower)
    expect(m?.role).toBeNull()
    expect(m?.capabilities).toEqual(['lawn-mower-control'])
    expect(m?.features).toEqual([])
  })
})
