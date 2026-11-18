/**
 * A workload Host (a UniFi console, D1064) reboots through the `reboot` capability, so the cap
 * applies to `Workload` devices: a Host binds it only when its provider serves it.
 */
import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../device/device-type.js'
import { rebootCapability } from '../reboot.cap.js'

describe('reboot capability', () => {
  it('applies to a workload Host', () => {
    expect(rebootCapability.deviceTypes).toContain(DeviceType.Workload)
  })
})
