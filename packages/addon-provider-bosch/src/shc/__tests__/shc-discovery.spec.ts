import { describe, expect, it } from 'vitest'
import { DeviceType } from '@camstack/types'
import { buildShcCandidates } from '../shc-discovery.js'
import type { ShcDeviceSummary } from '../shc-types.js'

const roomClimate: ShcDeviceSummary = {
  id: 'roomClimateControl_hz_abc',
  deviceModel: 'ROOM_CLIMATE_CONTROL',
  name: 'Office',
  services: ['RoomClimateControl'],
  childDeviceIds: ['hdm1:trv1'],
}

const trv: ShcDeviceSummary = {
  id: 'hdm1:trv1',
  deviceModel: 'TRV_GEN2_DUAL',
  name: 'Radiator office',
  services: ['TemperatureLevel', 'ValveTappet', 'BatteryLevel'],
  parentDeviceId: 'roomClimateControl_hz_abc',
}

const plug: ShcDeviceSummary = {
  id: 'hdm1:plug1',
  deviceModel: 'TWR_SWITCH',
  name: 'Desk lamp',
  services: ['PowerSwitch'],
}

describe('buildShcCandidates', () => {
  it('maps room climate to one Container with climate + TRV children, not a top-level TRV', () => {
    const candidates = buildShcCandidates({
      devices: [roomClimate, trv, plug],
      adopted: new Map(),
    })
    expect(candidates).toHaveLength(2)
    const container = candidates.find((c) => c.childNativeId === roomClimate.id)
    expect(container?.type).toBe(DeviceType.Container)
    expect(container?.children).toBeDefined()
    const climateChild = container?.children?.find((c) => c.childNativeId.endsWith('#climate'))
    expect(climateChild?.name).toBe('Climate Office')
    expect(climateChild?.type).toBe(DeviceType.Climate)
    expect(climateChild?.capabilities).toContain('climate-control')
    const trvChild = container?.children?.find((c) => c.childNativeId === trv.id)
    expect(trvChild?.type).toBe(DeviceType.Thermostat)
    expect(trvChild?.capabilities).toEqual(
      expect.arrayContaining(['temperature-sensor', 'battery', 'heating-valve']),
    )
    expect(trvChild?.capabilities).not.toContain('climate-control')
    expect(candidates.some((c) => c.childNativeId === trv.id)).toBe(false)
    const switchCand = candidates.find((c) => c.childNativeId === plug.id)
    expect(switchCand?.capabilities).toContain('switch')
  })

  it('keeps standalone TRV as top-level Thermostat with sensor caps', () => {
    const standalone: ShcDeviceSummary = {
      id: 'hdm1:trv2',
      deviceModel: 'TRV_GEN2_DUAL',
      name: 'Hall TRV',
      services: ['TemperatureLevel', 'ValveTappet', 'BatteryLevel'],
    }
    const candidates = buildShcCandidates({
      devices: [standalone],
      adopted: new Map(),
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.type).toBe(DeviceType.Thermostat)
    expect(candidates[0]?.capabilities).toEqual(
      expect.arrayContaining(['temperature-sensor', 'battery', 'heating-valve']),
    )
  })

  it('marks already-adopted devices', () => {
    const candidates = buildShcCandidates({
      devices: [roomClimate],
      adopted: new Map([[roomClimate.id, 42]]),
    })
    expect(candidates[0]?.alreadyAdopted).toBe(true)
    expect(candidates[0]?.adoptedDeviceId).toBe(42)
  })

  it('omits unsupported devices', () => {
    const candidates = buildShcCandidates({
      devices: [
        {
          id: 'motion1',
          deviceModel: 'MOTION_DETECTOR',
          name: 'Hall motion',
          services: ['MotionDetection'],
        },
      ],
      adopted: new Map(),
    })
    expect(candidates).toHaveLength(0)
  })

  it('omits HOMECONNECT dishwasher app-link devices', () => {
    const candidates = buildShcCandidates({
      devices: [
        {
          id: 'hc-dish',
          deviceModel: 'HOMECONNECT_DISHWASHER',
          name: 'Dishwasher',
          services: ['HCDishwasher'],
        },
        plug,
      ],
      adopted: new Map(),
    })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.childNativeId).toBe(plug.id)
  })
})
