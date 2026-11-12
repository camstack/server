import { describe, expect, it } from 'vitest'
import { isDoPickerDeviceType } from '../device-do-actions.js'
import { DeviceType } from '../device-type.js'

describe('isDoPickerDeviceType', () => {
  it('never offers a container, offers an actuatable device', () => {
    expect(isDoPickerDeviceType(DeviceType.Container)).toBe(false)
    expect(isDoPickerDeviceType(DeviceType.Lock)).toBe(true)
  })
})
