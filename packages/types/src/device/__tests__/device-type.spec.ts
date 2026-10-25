import { describe, it, expect } from 'vitest'
import { DeviceType, DeviceFeature, ChargingStatus } from '../device-type.js'

describe('DeviceType', () => {
  it('has expected values', () => {
    expect(DeviceType.Camera).toBe('camera')
    expect(DeviceType.Hub).toBe('hub')
    expect(DeviceType.Light).toBe('light')
    expect(DeviceType.Siren).toBe('siren')
    expect(DeviceType.Switch).toBe('switch')
    expect(DeviceType.Sensor).toBe('sensor')
  })
})

describe('DeviceFeature', () => {
  it('has expected values', () => {
    expect(DeviceFeature.BatteryOperated).toBe('battery-operated')
    expect(DeviceFeature.Rebootable).toBe('rebootable')
    expect(DeviceFeature.NativeSnapshot).toBe('native-snapshot')
  })
})

describe('ChargingStatus', () => {
  it('has expected values', () => {
    expect(ChargingStatus.ChargingDC).toBe('charging-dc')
    expect(ChargingStatus.ChargingSolar).toBe('charging-solar')
    expect(ChargingStatus.NotCharging).toBe('not-charging')
  })
})
