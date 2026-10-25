import type { CustomModelDescriptor, ModelCatalogEntry } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { groupCustomModelsByStep, mergeCustomModels } from '../custom-models.js'

function entry(id: string, name = id): ModelCatalogEntry {
  return {
    id,
    name,
    description: '',
    formats: { onnx: { url: `https://x/${id}.onnx`, sizeMB: 1 } },
    inputSize: { width: 640, height: 640 },
    labels: [],
  }
}

function descriptor(id: string, stepId: string): CustomModelDescriptor {
  return { stepId, entry: entry(id) }
}

describe('mergeCustomModels', () => {
  it('returns the static list unchanged when there are no custom models', () => {
    const statics = [entry('a'), entry('b')]
    expect(mergeCustomModels(statics, [])).toEqual(statics)
  })

  it('appends fresh custom models after the static ones', () => {
    const merged = mergeCustomModels([entry('a')], [entry('c')])
    expect(merged.map((m) => m.id)).toEqual(['a', 'c'])
  })

  it('drops a custom model whose id collides with a static one (static wins)', () => {
    const merged = mergeCustomModels([entry('a', 'static-a')], [entry('a', 'custom-a'), entry('c')])
    expect(merged.map((m) => m.id)).toEqual(['a', 'c'])
    expect(merged.find((m) => m.id === 'a')?.name).toBe('static-a')
  })

  it('stamps an inferred provider on unstamped custom entries', () => {
    const merged = mergeCustomModels(
      [entry('yolo26n')],
      [
        {
          ...entry('scrypted-yolov9s-relu-onnx'),
          description: 'imported from the local plugin catalog YOLO catalog.',
        },
        { ...entry('frigate-mobiledet-edgetpu'), description: 'Imported from plus catalog' },
        entry('my-wildlife'),
      ],
    )
    expect(merged.find((m) => m.id === 'scrypted-yolov9s-relu-onnx')?.provider).toBe('scrypted')
    expect(merged.find((m) => m.id === 'frigate-mobiledet-edgetpu')?.provider).toBe('frigate')
    expect(merged.find((m) => m.id === 'my-wildlife')?.provider).toBe('custom')
    expect(merged.find((m) => m.id === 'yolo26n')?.provider).toBeUndefined()
  })

  it('preserves a custom entry classMap through the catalog merge', () => {
    const classMap = {
      mapping: { person: 'person', vehicle: 'vehicle', animal: 'animal' },
      preserveOriginal: false,
    } as const
    const custom = { ...entry('plugin-catalog-yolo'), classMap }
    const merged = mergeCustomModels([entry('yolo26n')], [custom])
    expect(merged.find((m) => m.id === 'plugin-catalog-yolo')?.classMap).toEqual(classMap)
  })
})

describe('groupCustomModelsByStep', () => {
  it('returns an empty map for no descriptors', () => {
    expect(groupCustomModelsByStep([]).size).toBe(0)
  })

  it('buckets descriptors by stepId preserving order', () => {
    const byStep = groupCustomModelsByStep([
      descriptor('d1', 'object-detection'),
      descriptor('f1', 'face-detection'),
      descriptor('d2', 'object-detection'),
    ])
    expect(byStep.get('object-detection')?.map((m) => m.id)).toEqual(['d1', 'd2'])
    expect(byStep.get('face-detection')?.map((m) => m.id)).toEqual(['f1'])
  })
})
