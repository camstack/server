import { describe, expect, it } from 'vitest'
import { findStaleDevicePins } from '../stale-device-pins.js'

describe('findStaleDevicePins (D748)', () => {
  const nodes = [
    {
      devices: [
        { key: 'openvino:npu', enabled: true, available: true },
        { key: 'edgetpu:usb', enabled: false, available: true },
      ],
    },
    { devices: [{ key: 'coreml:all', enabled: true, available: true }] },
  ]

  it('names a pin to a device enabled nowhere as disabled, and to an unknown key as absent', () => {
    expect(
      findStaleDevicePins(
        [
          { deviceId: 3836, deviceKey: 'edgetpu:usb' },
          { deviceId: 7, deviceKey: 'cuda:0' },
          { deviceId: 1441, deviceKey: 'openvino:npu' },
        ],
        nodes,
      ),
    ).toEqual([
      { deviceId: 7, deviceKey: 'cuda:0', reason: 'absent' },
      { deviceId: 3836, deviceKey: 'edgetpu:usb', reason: 'disabled' },
    ])
  })

  it('a key enabled on ANY node is not stale', () => {
    const twoNodes = [
      { devices: [{ key: 'openvino:gpu', enabled: false, available: true }] },
      { devices: [{ key: 'openvino:gpu', enabled: true, available: true }] },
    ]
    expect(findStaleDevicePins([{ deviceId: 1, deviceKey: 'openvino:gpu' }], twoNodes)).toEqual([])
  })

  it('an enabled but unavailable device (unplugged) counts as disabled', () => {
    const unplugged = [{ devices: [{ key: 'edgetpu:usb', enabled: true, available: false }] }]
    expect(findStaleDevicePins([{ deviceId: 1, deviceKey: 'edgetpu:usb' }], unplugged)).toEqual([
      { deviceId: 1, deviceKey: 'edgetpu:usb', reason: 'disabled' },
    ])
  })
})
