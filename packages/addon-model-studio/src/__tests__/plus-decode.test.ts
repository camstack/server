import { describe, expect, it } from 'vitest'
import { UnsupportedPlusDecodeError, resolvePlusDecode } from '../plus-catalog/plus-decode.js'
import { plusInfoToDescriptor } from '../plus-catalog/plus-catalog-api.js'

const BE9 = 'be9c11b486ba0e2b8ea13338d4cc66ee'

describe('resolvePlusDecode', () => {
  it('yolo-generic + tflite override + edgetpu → yolo-split-dfl', () => {
    const d = resolvePlusDecode({ type: 'yolo-generic', supportedDetectors: ['edgetpu'] }, 'tflite')
    expect(d).toEqual({
      format: 'tflite',
      extension: '.tflite',
      postprocessor: 'yolo-split-dfl',
    })
  })

  it('yolov9 + tflite → yolo-split-dfl', () => {
    const d = resolvePlusDecode({ type: 'yolov9', supportedDetectors: ['edgetpu'] }, 'tflite')
    expect(d.postprocessor).toBe('yolo-split-dfl')
    expect(d.format).toBe('tflite')
  })

  it('yolo-generic + edgetpu detectors, no override → yolo-split-dfl', () => {
    const d = resolvePlusDecode({ type: 'yolo-generic', supportedDetectors: ['edgetpu'] })
    expect(d.postprocessor).toBe('yolo-split-dfl')
  })

  it('yolonas + onnx → yolonas', () => {
    expect(
      resolvePlusDecode({ type: 'yolonas', supportedDetectors: ['onnx', 'openvino'] })
        .postprocessor,
    ).toBe('yolonas')
    expect(resolvePlusDecode({ type: 'yolonas' }, 'onnx').postprocessor).toBe('yolonas')
  })

  it('yolov9 + onnx → yolo', () => {
    expect(resolvePlusDecode({ type: 'yolov9' }).postprocessor).toBe('yolo')
  })

  it('mobiledet + edgetpu/tflite → ssd', () => {
    expect(
      resolvePlusDecode({ type: 'mobiledet', supportedDetectors: ['edgetpu'] }).postprocessor,
    ).toBe('ssd')
  })

  it('yolonas + tflite → UnsupportedPlusDecodeError', () => {
    expect(() =>
      resolvePlusDecode({ type: 'yolonas', supportedDetectors: ['edgetpu'] }, 'tflite'),
    ).toThrow(UnsupportedPlusDecodeError)
  })

  it('mobiledet + onnx → UnsupportedPlusDecodeError', () => {
    expect(() => resolvePlusDecode({ type: 'mobiledet' }, 'onnx')).toThrow(
      UnsupportedPlusDecodeError,
    )
  })

  it('hailo type or hailo8-only detectors → UnsupportedPlusDecodeError', () => {
    expect(() => resolvePlusDecode({ type: 'hailo' })).toThrow(UnsupportedPlusDecodeError)
    expect(() =>
      resolvePlusDecode({ type: 'yolo-generic', supportedDetectors: ['hailo8'] }),
    ).toThrow(UnsupportedPlusDecodeError)
  })

  it('unknown type rfdetr → UnsupportedPlusDecodeError', () => {
    expect(() => resolvePlusDecode({ type: 'rfdetr', supportedDetectors: ['onnx'] })).toThrow(
      UnsupportedPlusDecodeError,
    )
  })
})

describe('plusInfoToDescriptor — Edge TPU yolov9', () => {
  it('fixture be9c11… + tflite override sets yolo-split-dfl on the entry', () => {
    const d = plusInfoToDescriptor(
      {
        id: BE9,
        type: 'yolo-generic',
        width: 320,
        height: 320,
        labelMap: { '0': 'person' },
        supportedDetectors: ['edgetpu'],
      },
      {
        modelId: 'plus-y9-edgetpu',
        name: 'y9 tpu',
        filename: 'plus-y9-edgetpu.tflite',
        sizeMB: 3,
        format: 'tflite',
      },
    )
    expect(d.entry.formats.tflite).toBeDefined()
    expect(d.entry.postprocessor).toBe('yolo-split-dfl')
  })
})
