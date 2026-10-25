/**
 * D791 — the `pipeline` measurement's step tree is built ON the node from its
 * own catalog: the root detector pinned to the measured model, and exactly
 * the detail steps the operator chose (a cropper comes on with any of its
 * recognizers).
 */
import { describe, expect, it } from 'vitest'
import type { PipelineSchema } from '../../../types/pipeline-schema.js'
import { buildBenchStepTree, listBenchDetailSteps } from '../step-tree.js'

function addon(
  id: string,
  slot: 'detector' | 'cropper' | 'classifier' | 'refiner',
  inputClasses: string[],
  outputClasses: string[],
): PipelineSchema['slots'][number]['addons'][number] {
  return {
    id,
    name: id,
    slot,
    inputClasses,
    outputClasses,
    childSlots: [],
    models: [],
    defaultModelId: `${id}-default`,
    defaultConfidence: 0.5,
  }
}

const schema: PipelineSchema = {
  availableEngines: [],
  selectedEngine: { runtime: 'python', backend: 'onnx', format: 'onnx' },
  slots: [
    {
      id: 'detector',
      label: 'd',
      priority: 0,
      parentSlot: null,
      addons: [
        addon('object-detection', 'detector', [], ['person', 'vehicle', 'animal']),
        addon('package-detection', 'detector', [], ['package']),
      ],
    },
    {
      id: 'cropper',
      label: 'c',
      priority: 1,
      parentSlot: 'detector',
      addons: [
        addon('face-detection', 'cropper', ['person'], ['face']),
        addon('plate-detection', 'cropper', ['vehicle'], ['plate']),
      ],
    },
    {
      id: 'classifier',
      label: 'k',
      priority: 2,
      parentSlot: 'cropper',
      addons: [
        addon('face-recognition', 'classifier', ['face'], ['identity']),
        addon('plate-recognition', 'classifier', ['plate'], ['text']),
        addon('animal-classifier', 'classifier', ['animal'], ['species']),
      ],
    },
    { id: 'refiner', label: 'r', priority: 3, parentSlot: null, addons: [] },
  ],
}

describe('listBenchDetailSteps', () => {
  it('lists every detail step under the object-detection root', () => {
    expect(listBenchDetailSteps(schema).map((s) => s.id)).toEqual([
      'face-detection',
      'face-recognition',
      'plate-detection',
      'plate-recognition',
      'animal-classifier',
    ])
  })
})

describe('buildBenchStepTree', () => {
  it('root pinned to the measured model; nothing else when no step is chosen', () => {
    const tree = buildBenchStepTree(schema, 'yolov9s-640', [])
    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({
      addonId: 'object-detection',
      modelId: 'yolov9s-640',
      enabled: true,
    })
    expect(tree[0]?.children?.every((c) => !c.enabled)).toBe(true)
  })
  it('a chosen recognizer brings its cropper on', () => {
    const tree = buildBenchStepTree(schema, 'm', ['face-recognition', 'animal-classifier'])
    const children = tree[0]?.children ?? []
    const face = children.find((c) => c.addonId === 'face-detection')
    expect(face?.enabled).toBe(true)
    expect(face?.children?.find((c) => c.addonId === 'face-recognition')?.enabled).toBe(true)
    expect(children.find((c) => c.addonId === 'plate-detection')?.enabled).toBe(false)
    expect(children.find((c) => c.addonId === 'animal-classifier')?.enabled).toBe(true)
  })
  it('throws when the node has no object-detection root', () => {
    expect(() => buildBenchStepTree({ ...schema, slots: [] }, 'm', [])).toThrow(/object-detection/)
  })
})
