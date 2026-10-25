import type { ModelFormat, PostprocessorType } from '@camstack/types'

export class UnsupportedPlusDecodeError extends Error {
  readonly type: string
  readonly format: string
  readonly detectors: readonly string[]

  constructor(type: string, format: string, detectors: readonly string[]) {
    const detList = detectors.length > 0 ? detectors.join(', ') : '(none)'
    super(
      `plus catalog import refused — no decoder for type "${type}", format "${format}", detectors ${detList}`,
    )
    this.name = 'UnsupportedPlusDecodeError'
    this.type = type
    this.format = format
    this.detectors = detectors
  }
}

export interface PlusArtifactDecode {
  readonly format: 'onnx' | 'tflite'
  readonly extension: '.onnx' | '.tflite'
  readonly postprocessor: PostprocessorType
}

const YOLO_FAMILIES = new Set(['yolo-generic', 'yolov9'])
const SSD_FAMILIES = new Set(['mobiledet', 'ssd'])
const YOLONAS_FAMILIES = new Set(['yolonas'])

function familyDefaultArtifact(type: string): 'onnx' | 'tflite' | null {
  if (YOLO_FAMILIES.has(type) || YOLONAS_FAMILIES.has(type)) return 'onnx'
  if (SSD_FAMILIES.has(type)) return 'tflite'
  return null
}

function matrixDecode(type: string, format: 'onnx' | 'tflite'): PlusArtifactDecode | null {
  if (YOLO_FAMILIES.has(type)) {
    if (format === 'onnx') {
      return { format: 'onnx', extension: '.onnx', postprocessor: 'yolo' }
    }
    return { format: 'tflite', extension: '.tflite', postprocessor: 'yolo-split-dfl' }
  }
  if (YOLONAS_FAMILIES.has(type)) {
    if (format === 'onnx') {
      return { format: 'onnx', extension: '.onnx', postprocessor: 'yolonas' }
    }
    return null
  }
  if (SSD_FAMILIES.has(type)) {
    if (format === 'tflite') {
      return { format: 'tflite', extension: '.tflite', postprocessor: 'ssd' }
    }
    return null
  }
  return null
}

function assertOverrideBacked(
  type: string,
  formatOverride: 'onnx' | 'tflite',
  detectors: readonly string[],
): void {
  if (formatOverride === 'onnx') {
    if (!detectors.includes('onnx') && !detectors.includes('openvino')) {
      throw new UnsupportedPlusDecodeError(type, formatOverride, detectors)
    }
    return
  }
  if (!detectors.includes('edgetpu')) {
    throw new UnsupportedPlusDecodeError(type, formatOverride, detectors)
  }
}

function plusArtifactFormat(format: ModelFormat): 'onnx' | 'tflite' | null {
  if (format === 'onnx' || format === 'tflite') return format
  return null
}

export function resolvePlusDecode(
  info: { readonly type: string; readonly supportedDetectors?: readonly string[] },
  formatOverride?: ModelFormat,
): PlusArtifactDecode {
  const type = info.type
  const detectors = info.supportedDetectors ?? []

  let format: 'onnx' | 'tflite'
  if (formatOverride !== undefined) {
    const artifact = plusArtifactFormat(formatOverride)
    if (artifact === null) {
      throw new UnsupportedPlusDecodeError(type, formatOverride, detectors)
    }
    if (detectors.length > 0) {
      assertOverrideBacked(type, artifact, detectors)
    }
    format = artifact
  } else if (detectors.includes('onnx') || detectors.includes('openvino')) {
    format = 'onnx'
  } else if (detectors.includes('edgetpu')) {
    format = 'tflite'
  } else if (detectors.length === 0) {
    const fallback = familyDefaultArtifact(type)
    if (fallback === null) {
      throw new UnsupportedPlusDecodeError(type, '(default)', detectors)
    }
    format = fallback
  } else {
    throw new UnsupportedPlusDecodeError(type, '(detectors)', detectors)
  }

  const decode = matrixDecode(type, format)
  if (decode === null) {
    throw new UnsupportedPlusDecodeError(type, format, detectors)
  }
  return decode
}
