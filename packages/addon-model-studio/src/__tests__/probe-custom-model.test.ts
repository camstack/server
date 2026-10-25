/**
 * probeCustomModel — extension → format, name → id/size; never invents decode.
 */
import { describe, expect, it } from 'vitest'
import { probeCustomModel } from '../ui/probe-custom-model.js'

describe('probeCustomModel', () => {
  it('infers onnx + 320 default from a plain filename', () => {
    const r = probeCustomModel({ kind: 'file', filename: 'my-detector.onnx', bytes: 4_200_000 })
    expect(r.format).toBe('onnx')
    expect(r.modelId).toBe('my-detector')
    expect(r.inputSize).toBe(320)
    expect(r.sizeMB).toBe(4.2)
    expect(r.hints.some((h) => /postprocessor/i.test(h))).toBe(true)
  })

  it('guesses 640 when the stem says so', () => {
    const r = probeCustomModel({
      kind: 'url',
      url: 'https://example.com/models/yolov9c-640.onnx',
    })
    expect(r.format).toBe('onnx')
    expect(r.inputSize).toBe(640)
    expect(r.modelId).toBe('yolov9c-640')
  })

  it('maps tflite / pt extensions', () => {
    expect(probeCustomModel({ kind: 'file', filename: 'coral.tflite' }).format).toBe('tflite')
    expect(probeCustomModel({ kind: 'file', filename: 'weights.pt' }).format).toBe('pt')
  })

  it('leaves format null when the extension is unknown', () => {
    const r = probeCustomModel({ kind: 'url', url: 'https://example.com/blob.bin' })
    expect(r.format).toBeNull()
    expect(r.hints.some((h) => /infer format/i.test(h))).toBe(true)
  })
})
