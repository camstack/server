/**
 * Task 7A — per-model classMap resolution.
 *
 * A custom model may declare its own identity map (plugin catalog: person/vehicle/
 * animal). The tree builder must attach `effectiveClassMap` per root without
 * mutating the shared StepDefinition (plus catalog public stays COCO_TO_MACRO).
 */
import { describe, expect, it } from 'vitest'
import { COCO_TO_MACRO } from '@camstack/types'
import type {
  DetectionCatalogClassMap,
  IInferenceEngine,
  ModelCatalogEntry,
  PipelineDefaultStep,
  StepDefinition,
} from '@camstack/types'
import { makeModelCatalogEntry } from '../../../__tests__/support/model-catalog-entry.js'

import { getStepDefinition } from '../../registry/step-definitions.js'
import { buildExecutableTree, resolveEffectiveClassMap } from '../tree-builder.js'

const IDENTITY: DetectionCatalogClassMap = {
  mapping: { person: 'person', vehicle: 'vehicle', animal: 'animal' },
  preserveOriginal: false,
}

function catalogEntry(id: string, classMap?: DetectionCatalogClassMap): ModelCatalogEntry {
  return makeModelCatalogEntry({
    id,
    name: id,
    description: '',
    labels: [
      { id: 'person', name: 'person' },
      { id: 'vehicle', name: 'vehicle' },
      { id: 'animal', name: 'animal' },
    ],
    ...(classMap !== undefined ? { classMap } : {}),
  })
}

function definition(models: readonly ModelCatalogEntry[]): StepDefinition {
  return {
    id: 'object-detection',
    name: 'Object Detection',
    slot: 'detector',
    postprocessor: 'yolo',
    extractMode: 'full-frame',
    inputClasses: null,
    outputClasses: ['person', 'vehicle', 'animal', 'package'],
    models,
    defaultModelId: models[0]!.id,
    defaultConfidence: 0.5,
    classMap: COCO_TO_MACRO,
  }
}

const stubEngine = {
  run: async (): Promise<Record<string, unknown>> => ({}),
  dispose: async (): Promise<void> => {},
} as unknown as IInferenceEngine

function makeStep(modelId: string): PipelineDefaultStep {
  return {
    addonId: 'object-detection',
    addonName: 'object-detection',
    slot: 'detector',
    inputClasses: [],
    outputClasses: [],
    enabled: true,
    modelId,
    children: [],
  }
}

describe('resolveEffectiveClassMap', () => {
  it('lets a per-model identity map win over the step COCO_TO_MACRO', () => {
    const def = definition([
      catalogEntry('plugin-catalog-yolo', IDENTITY),
      catalogEntry('frigate-coco'),
    ])
    expect(resolveEffectiveClassMap(def, 'plugin-catalog-yolo')).toEqual(IDENTITY)
    expect(def.classMap).toBe(COCO_TO_MACRO)
  })

  it('keeps COCO_TO_MACRO when the model has no classMap override', () => {
    const def = definition([catalogEntry('yolo26n')])
    expect(resolveEffectiveClassMap(def, 'yolo26n')).toBe(COCO_TO_MACRO)
  })

  it('gives two models on the same shared definition different maps', () => {
    const def = definition([
      catalogEntry('plugin-catalog-yolo', IDENTITY),
      catalogEntry('frigate-coco'),
    ])
    expect(resolveEffectiveClassMap(def, 'plugin-catalog-yolo')).toEqual(IDENTITY)
    expect(resolveEffectiveClassMap(def, 'frigate-coco')).toBe(COCO_TO_MACRO)
    expect(def.classMap).toBe(COCO_TO_MACRO)
    expect(def.classMap?.mapping.car).toBe('vehicle')
  })
})

describe('buildExecutableTree — effectiveClassMap', () => {
  it('attaches the step COCO map for a catalog model and leaves the definition untouched', () => {
    const def = getStepDefinition('object-detection')
    const original = def.classMap
    const tree = buildExecutableTree([makeStep('yolo26n')], (_stepId, modelId) => ({
      engine: stubEngine,
      modelId,
    }))
    expect(tree.roots[0]?.effectiveClassMap).toBe(COCO_TO_MACRO)
    expect(def.classMap).toBe(original)
    expect(getStepDefinition('object-detection').classMap).toBe(COCO_TO_MACRO)
  })

  it('attaches different maps to two roots that share one StepDefinition', () => {
    const def = getStepDefinition('object-detection')
    const original = def.classMap
    const tree = buildExecutableTree(
      [makeStep('plugin-catalog-yolo'), makeStep('yolo26n')],
      (_stepId, modelId) => ({ engine: stubEngine, modelId }),
      (stepId, modelId) =>
        stepId === 'object-detection' && modelId === 'plugin-catalog-yolo'
          ? catalogEntry('plugin-catalog-yolo', IDENTITY)
          : undefined,
    )
    expect(tree.roots).toHaveLength(2)
    expect(tree.roots[0]?.effectiveClassMap).toEqual(IDENTITY)
    expect(tree.roots[1]?.effectiveClassMap).toBe(COCO_TO_MACRO)
    expect(def.classMap).toBe(original)
    expect(def.classMap).toBe(COCO_TO_MACRO)
  })
})
