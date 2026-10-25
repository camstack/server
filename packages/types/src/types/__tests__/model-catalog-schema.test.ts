import { describe, expect, it } from 'vitest'
import { type ModelCatalogEntry, ModelCatalogEntrySchema } from '../models.js'

const SAMPLE: ModelCatalogEntry = {
  id: 'yolo26n',
  name: 'YOLO26 Nano',
  description: 'Lightweight object detector',
  formats: {
    onnx: { url: 'https://example/yolo26n.onnx', sizeMB: 10 },
    openvino: {
      url: 'https://example/yolo26n.xml',
      sizeMB: 9,
      files: ['yolo26n.bin'],
      runtimes: ['python'],
    },
  },
  inputSize: { width: 640, height: 640 },
  labels: [{ id: '0', name: 'person' }],
  preprocessMode: 'letterbox',
}

describe('ModelCatalogEntrySchema', () => {
  it('round-trips a real catalog entry', () => {
    const parsed = ModelCatalogEntrySchema.parse(SAMPLE)
    expect(parsed.id).toBe('yolo26n')
    expect(parsed.formats.openvino?.files).toEqual(['yolo26n.bin'])
    expect(parsed.labels[0]?.name).toBe('person')
  })

  it('rejects an entry missing the id', () => {
    const { id: _omit, ...broken } = SAMPLE
    expect(() => ModelCatalogEntrySchema.parse(broken)).toThrow()
  })

  it('rejects a format entry missing its url', () => {
    expect(() =>
      ModelCatalogEntrySchema.parse({
        ...SAMPLE,
        formats: { onnx: { sizeMB: 1 } },
      }),
    ).toThrow()
  })

  it('accepts and round-trips a per-model identity classMap', () => {
    const classMap = {
      mapping: { person: 'person', vehicle: 'vehicle', animal: 'animal' },
      preserveOriginal: false,
    }
    const parsed = ModelCatalogEntrySchema.parse({ ...SAMPLE, classMap })
    expect(parsed.classMap).toEqual(classMap)
  })

  it('rejects a classMap whose target is not a detection macro', () => {
    expect(() =>
      ModelCatalogEntrySchema.parse({
        ...SAMPLE,
        classMap: {
          mapping: { person: 'spaceship' },
          preserveOriginal: false,
        },
      }),
    ).toThrow()
  })

  it('accepts a catalog provider id and rejects an unknown one', () => {
    expect(ModelCatalogEntrySchema.parse({ ...SAMPLE, provider: 'frigate' }).provider).toBe(
      'frigate',
    )
    expect(() => ModelCatalogEntrySchema.parse({ ...SAMPLE, provider: 'roboflow' })).toThrow()
  })
})

describe('ModelCatalogEntrySchema.license', () => {
  it('accepts a structured licence record', () => {
    const parsed = ModelCatalogEntrySchema.parse({
      ...SAMPLE,
      license: {
        weights: 'Apache-2.0',
        upstream: { name: 'fal.ai AuraFace v1', url: 'https://huggingface.co/fal/AuraFace-v1' },
        url: 'https://huggingface.co/fal/AuraFace-v1',
        hosting: 'camstack-hf',
        modifications: 'input scaling baked into the graph; converted to OpenVINO/CoreML FP16',
      },
    })
    expect(parsed.license?.weights).toBe('Apache-2.0')
    expect(parsed.license?.hosting).toBe('camstack-hf')
  })

  it('lifts a legacy string licence (persisted custom-model rows) into { weights }', () => {
    const parsed = ModelCatalogEntrySchema.parse({ ...SAMPLE, license: 'AGPL-3.0' })
    expect(parsed.license).toEqual({ weights: 'AGPL-3.0' })
  })

  it('refuses an empty weights licence', () => {
    expect(() => ModelCatalogEntrySchema.parse({ ...SAMPLE, license: { weights: '' } })).toThrow()
  })

  it('refuses an unknown hosting value', () => {
    expect(() =>
      ModelCatalogEntrySchema.parse({
        ...SAMPLE,
        license: { weights: 'MIT', hosting: 'somewhere' },
      }),
    ).toThrow()
  })
})
