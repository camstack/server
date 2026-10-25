import { describe, expect, it } from 'vitest'
import { labelsForDecoder } from '../labels-for-decoder.js'
import { buildPoolModelConfigForStep } from '../engine-factory.js'
import type { ModelCatalogEntry } from '@camstack/types'
import * as os from 'node:os'

const coco80 = Array.from({ length: 80 }, (_, i) => `coco80-${i}`)
const plusMap = ['a', 'b', 'c', 'dog', ...Array.from({ length: 25 }, (_, i) => `x${i}`), 'car']

describe('labelsForDecoder', () => {
  it('ssd + non-empty model labels → model map (plus index 3 dog, 29 car)', () => {
    const labels = labelsForDecoder('ssd', plusMap, coco80)
    expect(labels).toEqual(plusMap)
    expect(labels?.[3]).toBe('dog')
    expect(labels?.[29]).toBe('car')
  })

  it('ssd + empty/undefined model labels → undefined (python COCO-90)', () => {
    expect(labelsForDecoder('ssd', undefined, coco80)).toBeUndefined()
    expect(labelsForDecoder('ssd', [], coco80)).toBeUndefined()
  })

  it('yolo + undefined model labels → step COCO-80', () => {
    expect(labelsForDecoder('yolo', undefined, coco80)).toEqual(coco80)
  })
})

describe('buildPoolModelConfigForStep — ssd label threading', () => {
  it('static ssd-mobilenet-v2-coco-edgetpu does not ship COCO-80 on config.labels', () => {
    const config = buildPoolModelConfigForStep({
      stepId: 'object-detection',
      modelId: 'ssd-mobilenet-v2-coco-edgetpu',
      poolRuntime: 'edgetpu',
      modelsDir: os.tmpdir(),
    })
    expect(config.postprocessor).toBe('ssd')
    expect(config.labels).toBeUndefined()
  })

  it('custom ssd entry with labels reaches config.labels', () => {
    const custom: ModelCatalogEntry = {
      id: 'custom-ssd-labels',
      name: 'Custom SSD',
      description: 'test',
      formats: {
        tflite: {
          url: 'camstack-local://custom-ssd-labels/custom.tflite',
          sizeMB: 1,
        },
      },
      inputSize: { width: 300, height: 300 },
      labels: [
        { id: 'person', name: 'person' },
        { id: 'dog', name: 'dog' },
      ],
      postprocessor: 'ssd',
    }
    const config = buildPoolModelConfigForStep({
      stepId: 'object-detection',
      modelId: 'custom-ssd-labels',
      poolRuntime: 'edgetpu',
      modelsDir: os.tmpdir(),
      resolveCustomModel: () => custom,
    })
    expect(config.labels).toEqual(['person', 'dog'])
  })
})
