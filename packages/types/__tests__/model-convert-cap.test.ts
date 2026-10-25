import { describe, it, expect } from 'vitest'
import { modelConvertCapability } from '../src/capabilities/model-convert.cap.js'

describe('model-convert cap', () => {
  it('is a singleton system cap with a convert mutation', () => {
    expect(modelConvertCapability.name).toBe('model-convert')
    expect(modelConvertCapability.scope).toBe('system')
    expect(modelConvertCapability.mode).toBe('singleton')
    expect(modelConvertCapability.methods.convert.kind).toBe('mutation')
  })

  it('validates convert input', () => {
    const input = modelConvertCapability.methods.convert.input.parse({
      sourceUrl: 'https://example.com/m.onnx',
      metadata: {
        id: 'm',
        name: 'M',
        labels: [{ id: '0', name: 'a' }],
        inputSize: { width: 640, height: 640 },
        outputFormat: 'yolo',
      },
      targets: [{ format: 'openvino', precisions: ['fp16'] }],
    })
    expect(input.sourceUrl).toContain('.onnx')
  })

  // A cold import of the whole capabilities barrel; under a loaded full run it
  // has taken longer than the 5 s default.
  it('is exported from the capabilities barrel', { timeout: 60_000 }, async () => {
    const barrel = await import('../src/capabilities/index.js')
    expect(barrel.modelConvertCapability).toBe(modelConvertCapability)
  })
})
