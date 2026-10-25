import { describe, it, expect } from 'vitest'
import { summarizeDeviceLoad } from '../device-load.js'

describe('summarizeDeviceLoad — per-device runner load (C4)', () => {
  it('groups attached cameras by deviceKey, deriving the backend prefix', () => {
    const result = summarizeDeviceLoad([
      'openvino:npu',
      'openvino:npu',
      'openvino:gpu',
      'edgetpu:usb',
      'cpu',
    ])
    expect(result).toEqual([
      { deviceKey: 'cpu', backend: 'cpu', attachedCameras: 1 },
      { deviceKey: 'edgetpu:usb', backend: 'edgetpu', attachedCameras: 1 },
      { deviceKey: 'openvino:gpu', backend: 'openvino', attachedCameras: 1 },
      { deviceKey: 'openvino:npu', backend: 'openvino', attachedCameras: 2 },
    ])
  })

  it('multi-Coral ordinal keys are counted as distinct devices', () => {
    const result = summarizeDeviceLoad(['edgetpu:usb', 'edgetpu:usb:1', 'edgetpu:usb:1'])
    expect(result).toEqual([
      { deviceKey: 'edgetpu:usb', backend: 'edgetpu', attachedCameras: 1 },
      { deviceKey: 'edgetpu:usb:1', backend: 'edgetpu', attachedCameras: 2 },
    ])
  })

  it('ignores cameras with no deviceKey (default-pool / pre-multi-device sessions)', () => {
    expect(summarizeDeviceLoad([undefined, undefined, 'openvino:npu'])).toEqual([
      { deviceKey: 'openvino:npu', backend: 'openvino', attachedCameras: 1 },
    ])
    expect(summarizeDeviceLoad([undefined, undefined])).toEqual([])
  })
})
