import { describe, it, expect } from 'vitest'
import { DeviceType } from '@camstack/types'
import { mapHaEntityToCamStack, inferParentDeviceType } from '../ha-domain-mapping.js'

describe('ha-domain-mapping — weather', () => {
  it('weather.* → DeviceType.Weather, capabilities: [weather], role null', () => {
    const m = mapHaEntityToCamStack({ domain: 'weather', deviceClass: null, attributes: {} })
    expect(m).not.toBeNull()
    expect(m?.deviceType).toBe(DeviceType.Weather)
    expect(m?.role).toBeNull()
    expect(m?.capabilities).toEqual(['weather'])
  })
})

describe('ha-domain-mapping — image', () => {
  it('image.* → DeviceType.Image, capabilities: [image], role null', () => {
    const m = mapHaEntityToCamStack({ domain: 'image', deviceClass: null, attributes: {} })
    expect(m).not.toBeNull()
    expect(m?.deviceType).toBe(DeviceType.Image)
    expect(m?.role).toBeNull()
    expect(m?.capabilities).toEqual(['image'])
  })
})

describe('ha-domain-mapping — weather/image parent-type priority', () => {
  it('a weather-only device infers DeviceType.Weather', () => {
    const weather = mapHaEntityToCamStack({ domain: 'weather', deviceClass: null, attributes: {} })
    expect(inferParentDeviceType([weather])).toBe(DeviceType.Weather)
  })

  it('an image-only device infers DeviceType.Image', () => {
    const image = mapHaEntityToCamStack({ domain: 'image', deviceClass: null, attributes: {} })
    expect(inferParentDeviceType([image])).toBe(DeviceType.Image)
  })

  it('a sensor + weather device infers Weather (Weather precedes Sensor)', () => {
    const weather = mapHaEntityToCamStack({ domain: 'weather', deviceClass: null, attributes: {} })
    const sensor = mapHaEntityToCamStack({
      domain: 'sensor',
      deviceClass: 'temperature',
      attributes: {},
    })
    expect(inferParentDeviceType([sensor, weather])).toBe(DeviceType.Weather)
    expect(inferParentDeviceType([weather, sensor])).toBe(DeviceType.Weather)
  })

  it('a device with both weather + image infers Weather (Weather precedes Image)', () => {
    const weather = mapHaEntityToCamStack({ domain: 'weather', deviceClass: null, attributes: {} })
    const image = mapHaEntityToCamStack({ domain: 'image', deviceClass: null, attributes: {} })
    expect(inferParentDeviceType([image, weather])).toBe(DeviceType.Weather)
    expect(inferParentDeviceType([weather, image])).toBe(DeviceType.Weather)
  })

  it('an image + sensor device infers Image (Image precedes Sensor)', () => {
    const image = mapHaEntityToCamStack({ domain: 'image', deviceClass: null, attributes: {} })
    const sensor = mapHaEntityToCamStack({
      domain: 'sensor',
      deviceClass: 'temperature',
      attributes: {},
    })
    expect(inferParentDeviceType([sensor, image])).toBe(DeviceType.Image)
  })
})
