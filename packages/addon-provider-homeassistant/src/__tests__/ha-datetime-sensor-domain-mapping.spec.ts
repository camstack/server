import { describe, it, expect } from 'vitest'
import { DeviceType, DeviceRole } from '@camstack/types'
import { mapHaEntityToCamStack } from '../ha-domain-mapping.js'

describe('ha-domain-mapping — timestamp / date sensor', () => {
  it('sensor.* device_class=timestamp → DeviceType.Sensor, role DateTimeSensor, caps [enum-sensor], format datetime', () => {
    const m = mapHaEntityToCamStack({ domain: 'sensor', deviceClass: 'timestamp', attributes: {} })
    expect(m).not.toBeNull()
    expect(m?.deviceType).toBe(DeviceType.Sensor)
    expect(m?.role).toBe(DeviceRole.DateTimeSensor)
    expect(m?.capabilities).toEqual(['enum-sensor'])
    expect(m?.dateTimeFormat).toBe('datetime')
  })

  it('sensor.* device_class=date → DeviceType.Sensor, role DateTimeSensor, caps [enum-sensor], format date', () => {
    const m = mapHaEntityToCamStack({ domain: 'sensor', deviceClass: 'date', attributes: {} })
    expect(m).not.toBeNull()
    expect(m?.deviceType).toBe(DeviceType.Sensor)
    expect(m?.role).toBe(DeviceRole.DateTimeSensor)
    expect(m?.capabilities).toEqual(['enum-sensor'])
    expect(m?.dateTimeFormat).toBe('date')
  })

  it('enum-sensor cap reuse means timestamp/date is NOT mapped to numeric-sensor', () => {
    const timestamp = mapHaEntityToCamStack({
      domain: 'sensor',
      deviceClass: 'timestamp',
      attributes: {},
    })
    expect(timestamp?.role).not.toBe(DeviceRole.NumericSensor)
    expect(timestamp?.capabilities).not.toContain('numeric-sensor')
  })
})
