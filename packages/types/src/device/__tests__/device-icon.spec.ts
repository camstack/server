import { describe, expect, it } from 'vitest'
import {
  DEVICE_ROLE_ICON,
  DEVICE_TYPE_ICON,
  deviceIconKey,
  deviceRoleIconKey,
  deviceTypeIconKey,
} from '../device-icon.js'
import { DeviceRole, DeviceType } from '../device-type.js'
import { isIconKey } from '../icon-catalog.js'

describe('device icon — one resolver keyed on type and role', () => {
  it('every device type has a catalog icon', () => {
    for (const type of Object.values(DeviceType)) {
      expect(isIconKey(DEVICE_TYPE_ICON[type]), type).toBe(true)
    }
  })

  it('every role has a catalog icon', () => {
    for (const role of Object.values(DeviceRole)) {
      expect(isIconKey(DEVICE_ROLE_ICON[role]), role).toBe(true)
    }
  })

  it('every type × role pair resolves to a catalog icon, the role winning', () => {
    for (const type of Object.values(DeviceType)) {
      for (const role of Object.values(DeviceRole)) {
        expect(deviceIconKey(type, role)).toBe(DEVICE_ROLE_ICON[role])
      }
    }
  })

  it('a switch with the light role is a light', () => {
    expect(deviceIconKey(DeviceType.Switch, DeviceRole.SwitchLight)).toBe(
      DEVICE_TYPE_ICON[DeviceType.Light],
    )
  })

  it('a switch without a role is drawn as its type', () => {
    expect(deviceIconKey(DeviceType.Switch, null)).toBe(DEVICE_TYPE_ICON[DeviceType.Switch])
    expect(deviceIconKey(DeviceType.Switch)).toBe('toggle-left')
  })

  it('an unknown role falls back to the type, never to another role', () => {
    expect(deviceRoleIconKey('not-a-role')).toBeNull()
    expect(deviceIconKey(DeviceType.Climate, 'not-a-role')).toBe(
      DEVICE_TYPE_ICON[DeviceType.Climate],
    )
  })

  it('an unknown type draws the generic icon', () => {
    expect(deviceTypeIconKey('not-a-type')).toBe(DEVICE_TYPE_ICON[DeviceType.Generic])
    expect(deviceIconKey('not-a-type', 'not-a-role')).toBe('box')
  })
})
