/**
 * Regression test for CLIP object-embedding wiring: `clip-embedding` must
 * attach as a CHILD of `object-detection` (embed each object crop), NOT as a
 * root running on the full frame. That is driven by the step's `inputClasses`
 * overlapping object-detection's `outputClasses` in `buildTreeFromAddons`.
 * (The wholesale per-camera snapshot it was once back-filled into is gone,
 * D927.)
 */
import { describe, it, expect } from 'vitest'
import { buildTreeFromAddons, resolvePipeline } from '../pipeline-resolver.js'
import type { PipelineEngineChoice, PipelineSchema } from '@camstack/types'

const ENGINE_CPU: PipelineEngineChoice = { runtime: 'python', backend: 'cpu', format: 'onnx' }

function model(id: string, formats: readonly string[] = ['onnx', 'coreml']) {
  return {
    id,
    name: id,
    formats: Object.fromEntries(formats.map((f) => [f, { downloaded: false, sizeMB: 1 }])),
  }
}

function addon(opts: {
  id: string
  slot: 'detector' | 'cropper' | 'classifier' | 'refiner' | 'audio-classifier'
  inputClasses?: readonly string[]
  outputClasses: readonly string[]
  defaultModelId: string
  enabledByDefault?: boolean
}) {
  return {
    id: opts.id,
    name: opts.id,
    slot: opts.slot,
    inputClasses: opts.inputClasses ?? [],
    outputClasses: opts.outputClasses,
    childSlots: [] as const,
    models: [model(opts.defaultModelId)],
    defaultModelId: opts.defaultModelId,
    defaultConfidence: 0.5,
    ...(opts.enabledByDefault !== undefined ? { enabledByDefault: opts.enabledByDefault } : {}),
  }
}

/**
 * Catalog reflecting the FIXED step definitions: clip-embedding scopes to the
 * object macro classes (person/vehicle/animal) and is enabledByDefault.
 */
function makeCatalog(): PipelineSchema {
  return {
    availableEngines: [],
    selectedEngine: ENGINE_CPU,
    slots: [
      {
        id: 'detector',
        label: 'Detector',
        priority: 0,
        parentSlot: null,
        addons: [
          addon({
            id: 'object-detection',
            slot: 'detector',
            outputClasses: ['person', 'vehicle', 'animal'],
            defaultModelId: 'yolo26n',
          }),
        ],
      },
      {
        id: 'cropper',
        label: 'Cropper',
        priority: 1,
        parentSlot: 'detector',
        addons: [
          addon({
            id: 'face-detection',
            slot: 'cropper',
            inputClasses: ['person'],
            outputClasses: ['face'],
            defaultModelId: 'scrfd',
          }),
        ],
      },
      {
        id: 'classifier',
        label: 'Classifier',
        priority: 2,
        parentSlot: 'cropper',
        addons: [
          addon({
            id: 'face-embedding',
            slot: 'classifier',
            inputClasses: ['face'],
            outputClasses: ['identity'],
            defaultModelId: 'arcface',
          }),
          addon({
            id: 'clip-embedding',
            slot: 'classifier',
            inputClasses: ['person', 'vehicle', 'animal'],
            outputClasses: ['embedding'],
            defaultModelId: 'mobileclip-s1',
            enabledByDefault: true,
            // Genuinely-new default step → opts into back-fill so it reaches
            // wholesale snapshots captured before it existed.
          }),
        ],
      },
    ],
  }
}

const catalog = makeCatalog()

describe('A. clip-embedding attaches under object-detection (not root)', () => {
  it('buildTreeFromAddons routes clip as an object-detection child, never a root', () => {
    const tree = buildTreeFromAddons(
      [{ addonId: 'object-detection' }, { addonId: 'clip-embedding' }],
      catalog,
    )
    // Single root: object-detection. clip must NOT be a second root.
    expect(tree).toHaveLength(1)
    expect(tree[0]!.addonId).toBe('object-detection')
    expect(tree.some((r) => r.addonId === 'clip-embedding')).toBe(false)
    expect((tree[0]!.children ?? []).some((c) => c.addonId === 'clip-embedding')).toBe(true)
  })

  it('resolvePipeline default tree carries clip as an object-detection child', () => {
    const res = resolvePipeline(null, 'onnx', catalog)
    const root = res.steps.find((s) => s.addonId === 'object-detection')!
    expect(root).toBeDefined()
    expect((root.children ?? []).some((c) => c.addonId === 'clip-embedding')).toBe(true)
    // Never leaks to root.
    expect(res.steps.some((s) => s.addonId === 'clip-embedding')).toBe(false)
  })
})
