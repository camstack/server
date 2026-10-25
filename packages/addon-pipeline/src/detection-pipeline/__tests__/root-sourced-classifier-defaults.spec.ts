/**
 * D736 — the animal and vehicle classifiers are ON by default, and by default
 * their answer comes from the ROOT model.
 *
 * Under D730 the two were `enabledByDefault: false` while their `useRootModel`
 * flag defaulted ON, so out of the box nothing happened: the flag waited on a
 * step nobody had switched on. Now the step runs by default; when the current
 * root declares it, the root's label IS the answer and the classifier is not
 * dispatched; when it does not, the enabled step runs its own model.
 */
import type { ModelCatalogEntry, PipelineStepInputOutput } from '@camstack/types'
import { USE_ROOT_MODEL_DEFAULTS } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { deriveDetailSteps } from '../../pipeline-runner/index.js'
import { planRootSupplies } from '../../pipeline-runner/root-supply.js'
import { buildDefaultStepTree } from '../provider.js'
import { getStepDefinition } from '../registry/step-definitions.js'

describe('D736 — root-sourced classifiers are on by default', () => {
  it('the catalog switches the animal and vehicle classifiers ON, and nothing else changes', () => {
    expect(getStepDefinition('animal-classifier').enabledByDefault).toBe(true)
    expect(getStepDefinition('vehicle-classifier').enabledByDefault).toBe(true)
    // Their source defaults to the root model — the pair the rule is made of.
    expect(USE_ROOT_MODEL_DEFAULTS['animal-classifier']).toBe(true)
    expect(USE_ROOT_MODEL_DEFAULTS['vehicle-classifier']).toBe(true)
    // Still opt-in: no root supplies them.
    expect(getStepDefinition('bird-classifier').enabledByDefault).toBe(false)
    expect(getStepDefinition('segmentation').enabledByDefault).toBe(false)
    // Zone-driven, never a default toggle.
    expect(getStepDefinition('package-detection').enabledByDefault).toBe(false)
  })

  it("the node-default tree follows the catalog's enablement", () => {
    const root = buildDefaultStepTree('onnx').find((s) => s.addonId === 'object-detection')
    const enabledOf = (id: string): boolean | undefined =>
      root?.children.find((c) => c.addonId === id)?.enabled
    expect(enabledOf('animal-classifier')).toBe(true)
    expect(enabledOf('vehicle-classifier')).toBe(true)
    expect(enabledOf('bird-classifier')).toBe(false)
  })

  // The tree a camera gets with no stepToggles: the classifiers are in it.
  const defaultTree = (rootModelId: string | undefined): readonly PipelineStepInputOutput[] => [
    {
      addonId: 'object-detection',
      ...(rootModelId !== undefined ? { modelId: rootModelId } : {}),
      enabled: true,
      children: [
        { addonId: 'animal-classifier', enabled: true },
        { addonId: 'vehicle-classifier', enabled: true },
      ],
    },
  ]
  /** A root whose labels are the macros only — it declares nothing. */
  const MACRO_ONLY: ModelCatalogEntry = {
    id: 'macro-only',
    name: 'Macro only',
    description: '',
    formats: {},
    inputSize: { width: 320, height: 320 },
    labels: ['person', 'vehicle', 'animal'].map((l) => ({ id: l, name: l })),
    classMap: {
      mapping: { person: 'person', vehicle: 'vehicle', animal: 'animal' },
      preserveOriginal: false,
    },
  }
  const resolve = (stepId: string, modelId: string): ModelCatalogEntry | undefined =>
    modelId === MACRO_ONLY.id
      ? MACRO_ONLY
      : getStepDefinition(stepId).models.find((m) => m.id === modelId)

  it('a root that declares the step supplies it: the classifier is announced as filled, never run', () => {
    const steps = defaultTree(undefined)
    const announces = deriveDetailSteps(steps, planRootSupplies(steps, resolve, 'openvino:gpu'))
    for (const stepId of ['animal-classifier', 'vehicle-classifier']) {
      expect(announces.find((a) => a.stepId === stepId)).toMatchObject({
        filledBy: 'yolov9m-320-int8',
        filledAs: 'label',
      })
    }
  })

  it('a root that does not declare it leaves the enabled classifier running its own model', () => {
    const steps = defaultTree(MACRO_ONLY.id)
    const plan = planRootSupplies(steps, resolve, 'openvino:gpu')
    expect(plan.states.get('animal-classifier')).toMatchObject({
      intent: true,
      effective: false,
      inactive: true,
    })
    const announces = deriveDetailSteps(steps, plan)
    const animal = announces.find((a) => a.stepId === 'animal-classifier')
    expect(animal).toBeDefined()
    expect(animal?.filledBy).toBeUndefined()
  })
})
