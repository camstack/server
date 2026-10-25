/**
 * D662 — a detector's confidence floor belongs to the MODEL, not to the step.
 *
 * YuNet became the face-detection default (D645) and inherited the step's 0.5,
 * a number calibrated for SCRFD. YuNet's `sqrt(cls·obj)` score sits on another
 * scale (OpenCV's own default is 0.9): on 2026-09-27 ~25–35% of the faces the
 * hub buffered were wheels, hands, sandals and clock digits, and the junk rate
 * by score band was ~85% at 0.50–0.67 and ~15% at 0.84–0.87.
 *
 * Default = model.defaultConfidence ?? step.defaultConfidence — every reader of
 * the step's default goes through it. A slider step's saved operator value
 * still wins in tree-builder; the face floor has no operator input (D662).
 */
import { describe, it, expect } from 'vitest'
import type { IInferenceEngine, ModelCatalogEntry, PipelineDefaultStep } from '@camstack/types'
import { FACE_DETECTION_MODELS } from '../registry/model-catalogs.js'
import { getStepDefinition } from '../registry/step-definitions.js'
import { resolveModelDefaultConfidence } from '../registry/effective-confidence.js'
import { buildPoolModelConfigForStep } from '../engine/engine-factory.js'
import { buildExecutableTree, type ResolvedStepEngine } from '../pipeline/tree-builder.js'
import { buildSchemaSlots } from '../provider.js'

const YUNET_ID = 'yunet-2023mar'
const UNKNOWN_ID = 'a-custom-face-model'

function faceModel(id: string): ModelCatalogEntry {
  const entry = FACE_DETECTION_MODELS.find((m) => m.id === id)
  if (entry === undefined) throw new Error(`catalog lost ${id}`)
  return entry
}

describe('catalog — the face detectors carry their own floor', () => {
  it('YuNet declares its own floor — 0.70 since D741 (was 0.85 under D662)', () => {
    expect(faceModel(YUNET_ID).defaultConfidence).toBe(0.7)
  })

  it('the step keeps its 0.5 fallback for a model that declares none', () => {
    expect(getStepDefinition('face-detection').defaultConfidence).toBe(0.5)
  })
})

describe('resolveModelDefaultConfidence', () => {
  const def = getStepDefinition('face-detection')

  it('model default wins over the step default', () => {
    expect(resolveModelDefaultConfidence(def, faceModel(YUNET_ID))).toBe(0.7)
  })

  it('falls back to the step default when the model states none, or is unknown', () => {
    expect(resolveModelDefaultConfidence(def, {})).toBe(0.5)
    expect(resolveModelDefaultConfidence(def, undefined)).toBe(0.5)
  })
})

describe('pool floor — the Python pool gets the floor of the model it loads', () => {
  const build = (stepId: string, modelId: string): number =>
    buildPoolModelConfigForStep({
      stepId,
      modelId,
      poolRuntime: 'onnxruntime',
      modelsDir: '/nonexistent-models-dir',
    }).confidence

  it('YuNet loads at its own 0.70', () => {
    expect(build('face-detection', YUNET_ID)).toBe(0.7)
  })

  it('a custom model that states no floor loads at the step 0.5', () => {
    const { defaultConfidence: _floor, ...withoutFloor } = faceModel(YUNET_ID)
    const custom: ModelCatalogEntry = { ...withoutFloor, id: UNKNOWN_ID }
    expect(
      buildPoolModelConfigForStep({
        stepId: 'face-detection',
        modelId: UNKNOWN_ID,
        poolRuntime: 'onnxruntime',
        modelsDir: '/nonexistent-models-dir',
        resolveCustomModel: (_stepId, modelId) => (modelId === UNKNOWN_ID ? custom : undefined),
      }).confidence,
    ).toBe(0.5)
  })
})

// ── tree-builder: a slider's hydrated default follows the model ─────────────

// tree-builder only stores the engine reference; nothing here runs it.
const stubEngine: IInferenceEngine = {
  runtime: 'onnx',
  device: 'cpu',
  infer: async () => {
    throw new Error('not called')
  },
  dispose: async () => {},
}

const getEngine = (_stepId: string, modelId: string): ResolvedStepEngine => ({
  engine: stubEngine,
  modelId,
})

function animalStep(modelId: string, settings?: Record<string, unknown>): PipelineDefaultStep {
  return {
    addonId: 'animal-classifier',
    addonName: 'animal-classifier',
    slot: 'classifier',
    inputClasses: ['animal'],
    outputClasses: ['animal-type'],
    enabled: true,
    modelId,
    children: [],
    ...(settings !== undefined ? { settings } : {}),
  }
}

describe('tree-builder — a confidence slider hydrates the MODEL default', () => {
  const animalDef = getStepDefinition('animal-classifier')
  const customId = 'custom-strict-animals'
  const custom: ModelCatalogEntry = {
    ...animalDef.models[0]!,
    id: customId,
    defaultConfidence: 0.7,
  }
  const resolveModel = (stepId: string, modelId: string): ModelCatalogEntry | undefined =>
    stepId === 'animal-classifier' && modelId === customId ? custom : undefined

  it('a model with its own floor hydrates it as the slider default', () => {
    const tree = buildExecutableTree([animalStep(customId)], getEngine, resolveModel)
    expect(tree.roots[0]?.settings?.['minConfidence']).toBe(0.7)
  })

  it('a model without one keeps the step default', () => {
    const { defaultConfidence: _own, ...withoutFloor } = animalDef.models[0]!
    const bare: ModelCatalogEntry = { ...withoutFloor, id: 'custom-no-floor' }
    const tree = buildExecutableTree([animalStep(bare.id)], getEngine, (_s, id) =>
      id === bare.id ? bare : undefined,
    )
    expect(tree.roots[0]?.settings?.['minConfidence']).toBe(animalDef.defaultConfidence)
  })

  it("the operator's saved value still wins", () => {
    const tree = buildExecutableTree(
      [animalStep(customId, { minConfidence: 0.3 })],
      getEngine,
      resolveModel,
    )
    expect(tree.roots[0]?.settings?.['minConfidence']).toBe(0.3)
  })
})

// ── getSchema: the admin UI is told the floor of each MODEL ─────────────────

describe('buildSchemaSlots — each model option carries the floor in force', () => {
  const faceAddon = buildSchemaSlots(new Set(['onnx']), '/nonexistent-models-dir')
    .flatMap((slot) => slot.addons)
    .find((addon) => addon.id === 'face-detection')

  it('YuNet is offered at its own 0.70', () => {
    const byId = new Map(faceAddon?.models.map((m) => [m.id, m.defaultConfidence]))
    expect(byId.get(YUNET_ID)).toBe(0.7)
  })

  it('the step-level default stays the step fallback', () => {
    expect(faceAddon?.defaultConfidence).toBe(0.5)
  })
})
