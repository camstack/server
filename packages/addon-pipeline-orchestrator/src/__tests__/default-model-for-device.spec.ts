/**
 * The column header's elected default (`defaultModelIdForDevice`) mirrors the
 * runner's `resolveDefaultDetectionModel`; the same table is asserted against
 * the runner in `addon-pipeline` (`default-detection-model-device-keys.spec.ts`).
 */
import { describe, expect, it } from 'vitest'
import { defaultModelIdForDevice } from '../inference-device-model.js'

const TABLE: readonly (readonly [string, string])[] = [
  ['cpu', 'yolov9s-320'],
  ['cuda:0', 'yolov9s-320'],
  ['openvino:gpu', 'yolov9m-320-int8'],
  ['openvino:npu', 'yolov9m-320-int8'],
  ['openvino:cpu', 'yolov9m-320-int8'],
  ['coreml:all', 'yolov9m-640'],
  ['onnx:webgpu', 'yolov9t-320'],
  ['edgetpu:usb', 'yolov9s-320-edgetpu'],
]

describe('defaultModelIdForDevice', () => {
  it.each(TABLE)('%s -> %s', (key, expected) => {
    expect(defaultModelIdForDevice(key)).toBe(expected)
  })
})
