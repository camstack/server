import { describe, expect, it } from 'vitest'
import { DeviceType } from '../device/device-type.js'
import {
  accessoriesCapability,
  deviceTransitionsCapability,
  powerSourceCapability,
} from '../index.js'

/**
 * The hub device type is gone. A stored `'hub'` is an unknown type: it is not
 * aliased to Gateway, and no live capability accepts it.
 */
describe('retired hub device type', () => {
  it('is not a device type and no live capability accepts it', () => {
    const members: readonly string[] = Object.values(DeviceType)
    expect(members).not.toContain('hub')
    const accessories: readonly string[] = accessoriesCapability.deviceTypes
    const power: readonly string[] = powerSourceCapability.deviceTypes
    const transitions: readonly string[] = deviceTransitionsCapability.deviceTypes
    expect(accessories).not.toContain('hub')
    expect(power).not.toContain('hub')
    expect(transitions).not.toContain('hub')
  })
})
