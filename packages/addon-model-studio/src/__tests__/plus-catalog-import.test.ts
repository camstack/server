import { describe, expect, it } from 'vitest'
import {
  buildPlusCatalogDescriptor,
  buildPlusCatalogTemplate,
  PLUS_CATALOG_MODEL_PRESETS,
  PLUS_CATALOG_BASE_LABELS,
  parsePlusCatalogLabelmap,
  parsePlusCatalogTemplate,
} from '../plus-catalog/plus-catalog-import.js'

describe('PLUS_CATALOG_MODEL_PRESETS', () => {
  it('matches the real plus catalog/plus catalog model characteristics', () => {
    // yolov9: plain ONNX YOLO output — decoded by the step default 'yolo'.
    expect(PLUS_CATALOG_MODEL_PRESETS.yolov9.format).toBe('onnx')
    expect(PLUS_CATALOG_MODEL_PRESETS.yolov9.inputSize).toBe(320)
    expect(PLUS_CATALOG_MODEL_PRESETS.yolov9.postprocessor).toBeUndefined()
    // yolonas: flat batched-NMS export — needs the dedicated 'yolonas' decode.
    expect(PLUS_CATALOG_MODEL_PRESETS.yolonas.format).toBe('onnx')
    expect(PLUS_CATALOG_MODEL_PRESETS.yolonas.inputSize).toBe(320)
    expect(PLUS_CATALOG_MODEL_PRESETS.yolonas.postprocessor).toBe('yolonas')
    // mobiledet: EdgeTPU tflite with TFLite_Detection_PostProcess → 'ssd'.
    expect(PLUS_CATALOG_MODEL_PRESETS.mobiledet.format).toBe('tflite')
    expect(PLUS_CATALOG_MODEL_PRESETS.mobiledet.inputSize).toBe(320)
    expect(PLUS_CATALOG_MODEL_PRESETS.mobiledet.postprocessor).toBe('ssd')
  })

  it('base label set carries the documented plus catalog labels', () => {
    for (const expected of ['person', 'car', 'dog', 'package', 'license_plate', 'amazon']) {
      expect(PLUS_CATALOG_BASE_LABELS).toContain(expected)
    }
  })
})

describe('parsePlusCatalogLabelmap', () => {
  it('accepts one label per line', () => {
    expect(parsePlusCatalogLabelmap('person\ncar\ndog\n')).toEqual(['person', 'car', 'dog'])
  })
  it('accepts "index label" lines (tflite labelmap style)', () => {
    expect(parsePlusCatalogLabelmap('0 person\n1 car\n2 dog')).toEqual(['person', 'car', 'dog'])
  })
  it('accepts comma-separated input', () => {
    expect(parsePlusCatalogLabelmap('person, car, dog')).toEqual(['person', 'car', 'dog'])
  })
})

describe('buildPlusCatalogDescriptor', () => {
  const base = {
    type: 'yolonas' as const,
    modelId: 'frigate-yolonas-s',
    name: 'plus catalog YOLO-NAS S',
    stepId: 'object-detection',
    filename: 'frigate-yolonas-s.onnx',
    sizeMB: 49,
    inputWidth: 320,
    inputHeight: 320,
    labels: ['person', 'car', 'dog'],
  }

  it('builds a registrable descriptor with the local-artifact URL convention', () => {
    const descriptor = buildPlusCatalogDescriptor(base)
    expect(descriptor.stepId).toBe('object-detection')
    const entry = descriptor.entry
    expect(entry.id).toBe('frigate-yolonas-s')
    expect(entry.formats.onnx?.url).toBe(
      'camstack-local://frigate-yolonas-s/frigate-yolonas-s.onnx',
    )
    expect(entry.formats.onnx?.sizeMB).toBe(49)
    expect(entry.inputSize).toEqual({ width: 320, height: 320 })
    expect(entry.preprocessMode).toBe('letterbox')
    expect(entry.postprocessor).toBe('yolonas')
    expect(entry.labels.map((l) => l.id)).toEqual(['person', 'car', 'dog'])
  })

  it('yolov9 carries no per-model postprocessor (step default yolo applies)', () => {
    const descriptor = buildPlusCatalogDescriptor({
      ...base,
      type: 'yolov9',
      filename: 'y9.onnx',
    })
    expect(descriptor.entry.postprocessor).toBeUndefined()
  })

  it('mobiledet targets tflite with the ssd decode', () => {
    const descriptor = buildPlusCatalogDescriptor({
      ...base,
      type: 'mobiledet',
      filename: 'mobiledet.tflite',
    })
    expect(descriptor.entry.formats.tflite?.url).toBe(
      'camstack-local://frigate-yolonas-s/mobiledet.tflite',
    )
    expect(descriptor.entry.postprocessor).toBe('ssd')
  })

  it('rejects an invalid model id', () => {
    expect(() => buildPlusCatalogDescriptor({ ...base, modelId: 'bad id!' })).toThrow(/model id/i)
  })

  it('rejects an empty label set', () => {
    expect(() => buildPlusCatalogDescriptor({ ...base, labels: [] })).toThrow(/label/i)
  })

  it('rejects a filename whose extension does not match the preset format', () => {
    expect(() => buildPlusCatalogDescriptor({ ...base, filename: 'model.tflite' })).toThrow(
      /extension/i,
    )
  })
})

describe('template round-trip', () => {
  it('builds a template carrying the preset characteristics', () => {
    const template = buildPlusCatalogTemplate('yolonas')
    expect(template.kind).toBe('camstack-plus-catalog-model-template')
    expect(template.type).toBe('yolonas')
    expect(template.format).toBe('onnx')
    expect(template.inputSize).toEqual({ width: 320, height: 320 })
    expect(template.preprocessMode).toBe('letterbox')
    expect(template.postprocessor).toBe('yolonas')
    expect(template.labels.length).toBeGreaterThan(0)
  })

  it('parses its own output back', () => {
    const parsed = parsePlusCatalogTemplate(JSON.stringify(buildPlusCatalogTemplate('mobiledet')))
    expect(parsed.type).toBe('mobiledet')
    expect(parsed.inputWidth).toBe(320)
    expect(parsed.inputHeight).toBe(320)
    expect(parsed.labels.length).toBeGreaterThan(0)
  })

  it('rejects foreign JSON with a clear error', () => {
    expect(() => parsePlusCatalogTemplate('{"foo": 1}')).toThrow(/template/i)
  })
})
