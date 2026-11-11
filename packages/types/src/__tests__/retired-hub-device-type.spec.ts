import { describe, expect, it } from 'vitest'
import {
  accessoriesCapability,
  deviceTransitionsCapability,
  powerSourceCapability,
} from '../index.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Hub devices are retired: every vendor is an integration instance plus an
 * adoptable Gateway device. `DeviceType.Hub` survives only for the migrations
 * that read old stored records, so no live capability accepts it.
 */
describe('retired hub device type', () => {
  it('is not an accepted device type of a live capability', () => {
    expect(accessoriesCapability.deviceTypes).not.toContain(DeviceType.Hub)
    expect(powerSourceCapability.deviceTypes).not.toContain(DeviceType.Hub)
    expect(deviceTransitionsCapability.deviceTypes).not.toContain(DeviceType.Hub)
  })

  it('stays readable as the legacy stored value', () => {
    expect(DeviceType.Hub).toBe('hub')
  })
})
