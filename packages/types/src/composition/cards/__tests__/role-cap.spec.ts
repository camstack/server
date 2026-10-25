import { describe, expect, it } from 'vitest'
import { DeviceRole } from '../../../device/device-type.js'
import { primaryCapForRole } from '../role-cap.js'

describe('primaryCapForRole', () => {
  it('maps aliased roles', () => {
    expect(primaryCapForRole(DeviceRole.BinarySensor)).toBe('binary')
    expect(primaryCapForRole(DeviceRole.MotionSensor)).toBe('motion')
  })

  it('uses the role string when it is a cap name', () => {
    expect(primaryCapForRole(DeviceRole.TemperatureSensor)).toBe('temperature-sensor')
  })

  it('returns null for unknown roles', () => {
    expect(primaryCapForRole('not-a-cap')).toBeNull()
    expect(primaryCapForRole(null)).toBeNull()
  })
})
