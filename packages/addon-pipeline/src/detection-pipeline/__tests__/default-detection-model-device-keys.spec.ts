/**
 * The runner's default per device key — the table the orchestrator's
 * `defaultModelIdForDevice` (the admin-ui column header) must equal
 * (`default-model-for-device.spec.ts` there asserts the same literals).
 */
import { deviceBackendToFormat } from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { resolveDefaultDetectionModel } from '../default-detection-model.js'

const TABLE: readonly (readonly [string, string])[] = [
  ['cpu', 'yolov9s-320'],
  ['cuda:0', 'yolov9m-320'],
  ['onnx:cuda', 'yolov9m-320'],
  ['openvino:gpu', 'yolov9m-320-int8'],
  ['openvino:npu', 'yolov9m-320-int8'],
  ['openvino:cpu', 'yolov9m-320-int8'],
  ['coreml:all', 'yolov9m-640'],
  ['onnx:webgpu', 'yolov9t-320'],
  ['edgetpu:usb', 'yolov9s-320-edgetpu'],
]

describe('resolveDefaultDetectionModel per device key', () => {
  it.each(TABLE)('%s -> %s', (key, expected) => {
    const colon = key.indexOf(':')
    const backend = colon >= 0 ? key.slice(0, colon) : key
    const device = colon >= 0 ? key.slice(colon + 1) : null
    expect(resolveDefaultDetectionModel(backend, device, deviceBackendToFormat(backend))).toBe(
      expected,
    )
  })
})
