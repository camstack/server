import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device/device-type.js'
import { accessoriesCapability } from '../accessories.cap.js'

describe('accessories cap — a vehicle parent', () => {
  it('lists a vehicle as a device type that can have accessory children', () => {
    expect(accessoriesCapability.deviceTypes).toContain(DeviceType.Vehicle)
  })
})
