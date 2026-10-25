/**
 * D214 — ONE registration flow. The plus catalog presets become templates inside
 * the single Register flow (upload OR remote URL), and a fully-custom model
 * declares its own format + decode + labelmap through the same builder.
 */
import { describe, expect, it } from 'vitest'
import { buildPlusCatalogDescriptor } from '../plus-catalog/plus-catalog-import.js'
import { buildRegistrationDescriptor } from '../plus-catalog/registration.js'

const BASE = {
  modelId: 'my-model',
  name: 'My Model',
  stepId: 'object-detection',
  inputWidth: 320,
  inputHeight: 320,
  labels: ['person', 'car'] as readonly string[],
}

describe('buildRegistrationDescriptor — plus catalog presets', () => {
  it('is byte-identical to the historical plus catalog builder for an uploaded yolonas model', () => {
    const viaUnified = buildRegistrationDescriptor({
      ...BASE,
      type: 'yolonas',
      format: 'onnx',
      source: { kind: 'upload', filename: 'my-model.onnx', sizeMB: 49 },
    })
    const viaLegacy = buildPlusCatalogDescriptor({
      type: 'yolonas',
      modelId: BASE.modelId,
      name: BASE.name,
      stepId: BASE.stepId,
      filename: 'my-model.onnx',
      sizeMB: 49,
      inputWidth: 320,
      inputHeight: 320,
      labels: BASE.labels,
    })
    expect(viaUnified).toEqual(viaLegacy)
    expect(viaUnified.entry.provider).toBe('frigate')
    expect(viaUnified.entry.group).toEqual({
      family: 'yolonas',
      tier: 'default',
      resolution: 320,
    })
  })

  it('rejects an upload whose extension does not match the preset', () => {
    expect(() =>
      buildRegistrationDescriptor({
        ...BASE,
        type: 'mobiledet',
        format: 'tflite',
        source: { kind: 'upload', filename: 'model.onnx', sizeMB: 5 },
      }),
    ).toThrow(/extension/i)
  })

  it('supports a remote URL source for a preset', () => {
    const d = buildRegistrationDescriptor({
      ...BASE,
      type: 'yolov9',
      format: 'onnx',
      source: {
        kind: 'url',
        url: 'https://example.com/models/yolov9s.onnx',
        sizeMB: 25,
      },
    })
    expect(d.entry.formats.onnx?.url).toBe('https://example.com/models/yolov9s.onnx')
    // yolov9 uses the step-default decode — no per-model override.
    expect(d.entry.postprocessor).toBeUndefined()
    expect(d.entry.preprocessMode).toBe('letterbox')
  })
})

describe('buildRegistrationDescriptor — custom type', () => {
  it('honors the declared format and decode for an uploaded custom model', () => {
    const d = buildRegistrationDescriptor({
      ...BASE,
      type: 'custom',
      format: 'onnx',
      postprocessor: 'yolonas',
      source: { kind: 'upload', filename: 'weird-model.onnx', sizeMB: 12 },
    })
    expect(d.stepId).toBe('object-detection')
    expect(d.entry.formats.onnx?.url).toBe('camstack-local://my-model/weird-model.onnx')
    expect(d.entry.formats.onnx?.runtimes).toEqual(['python'])
    expect(d.entry.postprocessor).toBe('yolonas')
    expect(d.entry.provider).toBe('custom')
    expect(d.entry.group).toBeUndefined()
    expect(d.entry.labels).toEqual([
      { id: 'person', name: 'person' },
      { id: 'car', name: 'car' },
    ])
  })

  it('omits the decode override when the step default applies, and allows an empty labelmap', () => {
    const d = buildRegistrationDescriptor({
      ...BASE,
      labels: [],
      type: 'custom',
      format: 'onnx',
      source: { kind: 'url', url: 'hf://org/repo/model.onnx', sizeMB: 30 },
    })
    expect(d.entry.postprocessor).toBeUndefined()
    expect(d.entry.labels).toEqual([])
  })

  it('still validates id / name / step / size', () => {
    expect(() =>
      buildRegistrationDescriptor({
        ...BASE,
        modelId: 'bad id!',
        type: 'custom',
        format: 'onnx',
        source: { kind: 'url', url: 'https://x/m.onnx', sizeMB: 1 },
      }),
    ).toThrow(/invalid/i)
    expect(() =>
      buildRegistrationDescriptor({
        ...BASE,
        inputWidth: 0,
        type: 'custom',
        format: 'onnx',
        source: { kind: 'url', url: 'https://x/m.onnx', sizeMB: 1 },
      }),
    ).toThrow(/input size/i)
  })

  it('requires a labelmap for plus catalog presets (the logit order is load-bearing)', () => {
    expect(() =>
      buildRegistrationDescriptor({
        ...BASE,
        labels: [],
        type: 'yolonas',
        format: 'onnx',
        source: { kind: 'upload', filename: 'm.onnx', sizeMB: 5 },
      }),
    ).toThrow(/label/i)
  })
})
