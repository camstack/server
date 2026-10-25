import { describe, it, expect } from 'vitest'
import { DeviceType } from '@camstack/types'
import { mapHaEntityToCamStack, inferParentDeviceType } from '../ha-domain-mapping.js'

describe('ha-domain-mapping — humidifier', () => {
  it('humidifier.* → DeviceType.Humidifier, capabilities: [humidifier]', () => {
    const m = mapHaEntityToCamStack({ domain: 'humidifier', deviceClass: null, attributes: {} })
    expect(m).not.toBeNull()
    expect(m?.deviceType).toBe(DeviceType.Humidifier)
    expect(m?.role).toBeNull()
    expect(m?.capabilities).toEqual(['humidifier'])
    expect(m?.features).toEqual([])
  })
})

describe('ha-domain-mapping — water_heater', () => {
  it('water_heater.* → DeviceType.WaterHeater, capabilities: [water-heater]', () => {
    const m = mapHaEntityToCamStack({ domain: 'water_heater', deviceClass: null, attributes: {} })
    expect(m).not.toBeNull()
    expect(m?.deviceType).toBe(DeviceType.WaterHeater)
    expect(m?.role).toBeNull()
    expect(m?.capabilities).toEqual(['water-heater'])
    expect(m?.features).toEqual([])
  })
})

describe('ha-domain-mapping — climate-family parent-type priority', () => {
  it('a humidifier-only device infers DeviceType.Humidifier', () => {
    const humidifier = mapHaEntityToCamStack({
      domain: 'humidifier',
      deviceClass: null,
      attributes: {},
    })
    expect(inferParentDeviceType([humidifier])).toBe(DeviceType.Humidifier)
  })

  it('a water_heater-only device infers DeviceType.WaterHeater', () => {
    const wh = mapHaEntityToCamStack({ domain: 'water_heater', deviceClass: null, attributes: {} })
    expect(inferParentDeviceType([wh])).toBe(DeviceType.WaterHeater)
  })

  it('a device with both thermostat + humidifier infers Thermostat (Thermostat precedes Humidifier)', () => {
    const climate = mapHaEntityToCamStack({ domain: 'climate', deviceClass: null, attributes: {} })
    const humidifier = mapHaEntityToCamStack({
      domain: 'humidifier',
      deviceClass: null,
      attributes: {},
    })
    expect(inferParentDeviceType([humidifier, climate])).toBe(DeviceType.Thermostat)
    expect(inferParentDeviceType([climate, humidifier])).toBe(DeviceType.Thermostat)
  })

  it('humidifier precedes water_heater when a device owns both', () => {
    const humidifier = mapHaEntityToCamStack({
      domain: 'humidifier',
      deviceClass: null,
      attributes: {},
    })
    const wh = mapHaEntityToCamStack({ domain: 'water_heater', deviceClass: null, attributes: {} })
    expect(inferParentDeviceType([wh, humidifier])).toBe(DeviceType.Humidifier)
    expect(inferParentDeviceType([humidifier, wh])).toBe(DeviceType.Humidifier)
  })

  it('both outrank a sensor-only sibling', () => {
    const humidifier = mapHaEntityToCamStack({
      domain: 'humidifier',
      deviceClass: null,
      attributes: {},
    })
    const wh = mapHaEntityToCamStack({ domain: 'water_heater', deviceClass: null, attributes: {} })
    const sensor = mapHaEntityToCamStack({
      domain: 'sensor',
      deviceClass: 'temperature',
      attributes: {},
    })
    expect(inferParentDeviceType([sensor, humidifier])).toBe(DeviceType.Humidifier)
    expect(inferParentDeviceType([sensor, wh])).toBe(DeviceType.WaterHeater)
  })
})
