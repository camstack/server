import { describe, expect, it } from 'vitest'
import {
  alarmDeviceBlocksArming,
  alarmDeviceSecureOnArm,
  secureActuationFor,
} from '../alarm-controllable.js'

describe('alarmDeviceBlocksArming', () => {
  it('contacts block unless on nonBlocking', () => {
    expect(
      alarmDeviceBlocksArming({
        controllable: false,
        deviceId: 1,
        nonBlocking: [],
        blocking: [],
      }),
    ).toBe(true)
    expect(
      alarmDeviceBlocksArming({
        controllable: false,
        deviceId: 1,
        nonBlocking: [1],
        blocking: [],
      }),
    ).toBe(false)
  })

  it('controllables do not block unless on blocking', () => {
    expect(
      alarmDeviceBlocksArming({
        controllable: true,
        deviceId: 2,
        nonBlocking: [],
        blocking: [],
      }),
    ).toBe(false)
    expect(
      alarmDeviceBlocksArming({
        controllable: true,
        deviceId: 2,
        nonBlocking: [],
        blocking: [2],
      }),
    ).toBe(true)
  })
})

describe('alarmDeviceSecureOnArm', () => {
  it('contacts never secure; controllables do unless opted out', () => {
    expect(alarmDeviceSecureOnArm({ controllable: false, deviceId: 1, secureOnArmOff: [] })).toBe(
      false,
    )
    expect(alarmDeviceSecureOnArm({ controllable: true, deviceId: 2, secureOnArmOff: [] })).toBe(
      true,
    )
    expect(alarmDeviceSecureOnArm({ controllable: true, deviceId: 2, secureOnArmOff: [2] })).toBe(
      false,
    )
  })
})

describe('secureActuationFor', () => {
  it('maps cover / lock / switch; contacts are null', () => {
    expect(secureActuationFor('cover')).toEqual({ cap: 'cover', method: 'close', args: {} })
    expect(secureActuationFor('lock-control')).toEqual({
      cap: 'lock-control',
      method: 'lock',
      args: {},
    })
    expect(secureActuationFor('switch')).toEqual({
      cap: 'switch',
      method: 'setState',
      args: { on: false },
    })
    expect(secureActuationFor('contact')).toBeNull()
  })
})
