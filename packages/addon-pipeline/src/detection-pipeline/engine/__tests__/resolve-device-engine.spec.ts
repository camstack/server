import { describe, it, expect } from 'vitest'
import { resolveDeviceEngine } from '../resolve-device-engine.js'

describe('resolveDeviceEngine', () => {
  it('maps openvino:gpu → openvino engine on gpu', () => {
    expect(resolveDeviceEngine('openvino:gpu')).toEqual({
      runtime: 'python',
      backend: 'openvino',
      format: 'openvino',
      device: 'gpu',
    })
  })

  it('maps edgetpu:usb → tflite engine on usb', () => {
    expect(resolveDeviceEngine('edgetpu:usb')).toEqual({
      runtime: 'python',
      backend: 'edgetpu',
      format: 'tflite',
      device: 'usb',
    })
  })

  it('maps bare cpu → onnx cpu', () => {
    expect(resolveDeviceEngine('cpu')).toEqual({
      runtime: 'python',
      backend: 'cpu',
      format: 'onnx',
      device: 'cpu',
    })
  })

  it('throws on an unknown backend', () => {
    expect(() => resolveDeviceEngine('bogus:x')).toThrow()
  })
})
