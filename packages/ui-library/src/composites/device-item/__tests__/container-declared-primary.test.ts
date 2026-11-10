import { describe, expect, it } from 'vitest'
import { effectiveIconDevice, effectiveOnline, type DeviceItemDevice } from '../helpers'

/**
 * A container whose children all share one type (an energy installation whose
 * PV, battery and house readings are all `sensor` children) stands for the
 * child its provider DECLARED (`primaryChildPreference`), whatever order the
 * children arrive in.
 */
describe('a container row follows its declared primary child', () => {
  const base = { addonId: 'enpal', disabled: false, type: 'sensor' }
  const house: DeviceItemDevice = {
    ...base,
    id: 11,
    stableId: 'sys-house',
    name: 'House',
    online: true,
    parentDeviceId: 10,
  }
  const pv: DeviceItemDevice = {
    ...base,
    id: 12,
    stableId: 'sys-pv',
    name: 'PV',
    online: false,
    parentDeviceId: 10,
  }
  const container: DeviceItemDevice = {
    ...base,
    id: 10,
    stableId: 'sys',
    type: 'container',
    name: 'System',
    online: true,
    parentDeviceId: null,
    primaryChildPreference: ['pv', 'house'],
  }

  it('resolves the declared child for the icon and the status dot', () => {
    expect(effectiveIconDevice(container, [house, pv]).id).toBe(12)
    expect(effectiveOnline(container, [house, pv])).toBe(false)
  })
})
