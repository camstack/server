import { describe, expect, it } from 'vitest'
import { type FormatRunnableModel, stepModelRunsOnFormat } from '../step-format-runnable.js'

/** The face-detection shape that caused D657: real models without tflite, and a legacy tflite stub. */
const FACE: readonly FormatRunnableModel[] = [
  { id: 'yunet', formats: { onnx: {}, openvino: {} } },
  { id: 'scrfd', formats: { onnx: {}, openvino: {} } },
  { id: 'coral-face-stub', legacy: true, formats: { tflite: {} } },
]

describe('stepModelRunsOnFormat (D657)', () => {
  it('a legacy build does not make an unpinned step runnable', () => {
    expect(stepModelRunsOnFormat(FACE, null, 'tflite')).toBe(false)
    expect(stepModelRunsOnFormat(FACE, undefined, 'tflite')).toBe(false)
  })

  it('a legacy build counts when it is the model named', () => {
    expect(stepModelRunsOnFormat(FACE, 'coral-face-stub', 'tflite')).toBe(true)
  })

  it('a named model without the build still runs when a non-legacy model has it (the format default)', () => {
    expect(stepModelRunsOnFormat(FACE, 'coral-face-stub', 'openvino')).toBe(true)
    expect(stepModelRunsOnFormat(FACE, 'yunet', 'tflite')).toBe(false)
  })

  it('an unknown named model falls back to the catalog', () => {
    expect(stepModelRunsOnFormat(FACE, 'custom', 'onnx')).toBe(true)
    expect(stepModelRunsOnFormat(FACE, 'custom', 'coreml')).toBe(false)
  })

  it('an absent build entry is not a build', () => {
    expect(stepModelRunsOnFormat([{ id: 'x', formats: { onnx: undefined } }], null, 'onnx')).toBe(
      false,
    )
  })
})
