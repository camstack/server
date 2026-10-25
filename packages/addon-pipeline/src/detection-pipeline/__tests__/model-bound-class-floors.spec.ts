/**
 * D738 — the per-class confidence floors belong to the MODEL that runs.
 *
 * Detectors score the same true objects very differently (median score of a
 * correct person on this hub: yolov9m-320-int8 0.78, yolo26s-320-int8 0.68,
 * yolo26n-320-int8 0.40, yolo26s (640) 0.89), so the floor DEFAULT is the
 * running model's `defaultClassFloors`, else the step's global default, and an
 * operator override is bound to the model it was made for: when another model
 * runs, that model's default applies again — with no write on the model-change
 * path.
 *
 * Real step definitions and the real catalog: the hydration is exercised from
 * the catalog row to the settings the executor's macro gate reads.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type {
  ConfigSliderField,
  IInferenceEngine,
  ModelCatalogEntry,
  PipelineDefaultStep,
} from '@camstack/types'
import { modelBindingKey } from '@camstack/types'
import {
  OBJECT_DETECTION_CLASS_FLOOR_MODEL_IDS,
  OBJECT_DETECTION_MODELS,
} from '../registry/model-catalogs.js'
import { getStep, getStepDefinition } from '../registry/step-definitions.js'
import {
  annotateConfigSchemaForModels,
  withRootSuppliedLabelDefaults,
} from '../registry/model-knob-applicability.js'
import { buildExecutableTree, type ResolvedStepEngine } from '../pipeline/tree-builder.js'

const MEASUREMENT_PATH = new URL(
  '../../../../../docs/benchmarks/model-floors.json',
  import.meta.url,
)
const V9 = 'yolov9m-320-int8'
const Y26_INT8 = 'yolo26s-320-int8'
const Y26_FP32 = 'yolo26s-320'
const Y26_640 = 'yolo26s'
const CUSTOM = 'plus-catalog-custom'
const PERSON = 'minConfidencePerson'
const VEHICLE = 'minConfidenceVehicle'
const ANIMAL = 'minConfidenceAnimal'

const stubEngine: IInferenceEngine = {
  runtime: 'onnx',
  device: 'cpu',
  infer: async () => ({ inferenceMs: 0 }),
  dispose: async () => {},
}

const getEngine = (_stepId: string, modelId: string): ResolvedStepEngine => ({
  engine: stubEngine,
  modelId,
})

function customEntry(id: string, floors?: Readonly<Record<string, number>>): ModelCatalogEntry {
  return {
    id,
    name: id,
    description: 'operator-imported detector',
    formats: { onnx: { url: `camstack-local://${id}/${id}.onnx`, sizeMB: 10 } },
    inputSize: { width: 320, height: 320 },
    labels: [],
    ...(floors !== undefined ? { defaultClassFloors: { ...floors } } : {}),
  }
}

function rootSettings(
  modelId: string,
  settings?: Record<string, unknown>,
  custom?: ModelCatalogEntry,
): Readonly<Record<string, unknown>> {
  const step: PipelineDefaultStep = {
    addonId: 'object-detection',
    addonName: 'Object Detection',
    slot: 'detector',
    inputClasses: [],
    outputClasses: [],
    enabled: true,
    modelId,
    children: [],
    ...(settings !== undefined ? { settings } : {}),
  }
  const tree = buildExecutableTree([step], getEngine, (_stepId, id) =>
    custom !== undefined && custom.id === id ? custom : undefined,
  )
  const out = tree.roots[0]?.settings
  if (out === undefined) throw new Error('root step carries no settings')
  return out
}

function catalogFloors(id: string): Readonly<Record<string, number>> | undefined {
  return OBJECT_DETECTION_MODELS.find((m) => m.id === id)?.defaultClassFloors
}

/** The measurement the table was filled from, as committed. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One class's floor, at the next-lower value when the measured one hinges on a single FP. */
function measuredClassFloor(entry: unknown): number | undefined {
  if (!isRecord(entry)) return undefined
  const floor = entry['floor']
  if (typeof floor !== 'number') return undefined
  const fragile = entry['fragile']
  const alt = typeof fragile === 'string' ? /allows (0\.\d+)/.exec(fragile)?.[1] : undefined
  return alt !== undefined ? Number(alt) : floor
}

function measuredFloors(): ReadonlyMap<string, Readonly<Record<string, number>>> {
  const raw: unknown = JSON.parse(readFileSync(MEASUREMENT_PATH, 'utf8'))
  if (!isRecord(raw)) throw new Error('measurement is not an object')
  const out = new Map<string, Readonly<Record<string, number>>>()
  for (const [id, row] of Object.entries(raw)) {
    if (id.startsWith('_') || !isRecord(row)) continue
    const floors: Record<string, number> = {}
    for (const cls of ['person', 'vehicle', 'animal']) {
      const floor = measuredClassFloor(row[cls])
      if (floor !== undefined) floors[cls] = floor
    }
    out.set(id, floors)
  }
  return out
}

describe('catalog — the floor defaults live on the model entry', () => {
  it('every measured model carries exactly its measured floors (fragile ones at the lower value)', () => {
    const measured = measuredFloors()
    expect(measured.size).toBe(30)
    for (const [id, floors] of measured) expect(catalogFloors(id)).toEqual(floors)
  })

  it('the models in use: the live root and the Apple default', () => {
    expect(catalogFloors(V9)).toEqual({ person: 0.65, vehicle: 0.4, animal: 0.35 })
    // vehicle 0.75 measured, 0.50 used: it hinged on a single false positive.
    expect(catalogFloors('yolov9m-320')).toEqual({ person: 0.7, vehicle: 0.5, animal: 0.55 })
    expect(catalogFloors('yolo26n')).toEqual({ person: 0.65, vehicle: 0.4, animal: 0.5 })
  })

  it('package is never given a per-model floor (not calibrated)', () => {
    for (const entry of OBJECT_DETECTION_MODELS) {
      expect(entry.defaultClassFloors?.['package']).toBeUndefined()
    }
  })

  it('an unmeasured model declares nothing and runs at the global defaults', () => {
    expect(catalogFloors('yolo26l')).toBeUndefined()
  })

  it('every row of the floor table names a catalog entry (no orphan rows)', () => {
    const ids = new Set(OBJECT_DETECTION_MODELS.map((m) => m.id))
    for (const id of OBJECT_DETECTION_CLASS_FLOOR_MODEL_IDS) expect(ids.has(id)).toBe(true)
  })
})

describe('effective floor — default, override, model change, custom model', () => {
  it('no operator value: the running model’s default', () => {
    expect(rootSettings(V9)[PERSON]).toBe(0.65)
    expect(rootSettings(V9)[VEHICLE]).toBe(0.4)
    expect(rootSettings(V9)[ANIMAL]).toBe(0.35)
    expect(rootSettings(Y26_INT8)[PERSON]).toBe(0.5)
    expect(rootSettings(Y26_640)[PERSON]).toBe(0.4)
    // A model with no row stays global.
    expect(rootSettings('yolo26l')[VEHICLE]).toBe(0.5)
  })

  it('an override made for the running model applies', () => {
    const settings = { [PERSON]: 0.4, [modelBindingKey(PERSON)]: V9 }
    expect(rootSettings(V9, settings)[PERSON]).toBe(0.4)
  })

  it('the same override after the model changed: the new model’s default applies', () => {
    const settings = { [PERSON]: 0.4, [modelBindingKey(PERSON)]: V9 }
    expect(rootSettings(Y26_INT8, settings)[PERSON]).toBe(0.5)
  })

  it('an override is per class: only the bound classes follow their binding', () => {
    const settings = {
      [PERSON]: 0.4,
      [modelBindingKey(PERSON)]: V9,
      [VEHICLE]: 0.7,
      [modelBindingKey(VEHICLE)]: Y26_INT8,
    }
    const s = rootSettings(Y26_INT8, settings)
    expect(s[PERSON]).toBe(0.5)
    expect(s[VEHICLE]).toBe(0.7)
  })

  it('a custom model without defaults: the global default, whatever was bound elsewhere', () => {
    const settings = { [PERSON]: 0.4, [modelBindingKey(PERSON)]: V9 }
    expect(rootSettings(CUSTOM, settings, customEntry(CUSTOM))[PERSON]).toBe(0.65)
  })

  it('a custom model that carries its own floors gets them', () => {
    expect(rootSettings(CUSTOM, undefined, customEntry(CUSTOM, { person: 0.3 }))[PERSON]).toBe(0.3)
  })

  it('an unbound value (stored before D738, or passed by a benchmark) applies to any model', () => {
    expect(rootSettings(Y26_INT8, { [PERSON]: 0.55 })[PERSON]).toBe(0.55)
  })

  it('binding keys never reach the runtime settings', () => {
    const s = rootSettings(V9, { [PERSON]: 0.4, [modelBindingKey(PERSON)]: V9 })
    expect(Object.keys(s).some((k) => k.endsWith('ModelId'))).toBe(false)
  })
})

describe('the editor learns each model’s default from the schema', () => {
  it('defaultByModel lists the models whose floor differs from the global default', () => {
    const step = getStep('object-detection')
    const def = getStepDefinition('object-detection')
    const annotated = annotateConfigSchemaForModels({
      def,
      configSchema: step.getConfigSchema(),
      models: def.models,
      customModelIds: new Set(),
      schemaForModel: (entry) => step.getConfigSchema(entry),
    })
    const person = annotated.find(
      (f): f is ConfigSliderField => f.type === 'slider' && f.key === PERSON,
    )
    const byModel = person?.modelApplicability?.defaultByModel
    expect(byModel?.[Y26_INT8]).toBe(0.5)
    expect(byModel?.[Y26_FP32]).toBe(0.6)
    expect(byModel?.[V9]).toBeUndefined()
    expect(person?.bindsToModel).toBe(true)
  })
})

describe('the other model-dependent thresholds bind the same way', () => {
  const BOUND_FIELDS: readonly (readonly [string, string])[] = [
    ['animal-classifier', 'minConfidence'],
    ['vehicle-classifier', 'minConfidence'],
    ['bird-classifier', 'minConfidence'],
    ['package-detection', 'minConfidencePackage'],
  ]

  it.each(BOUND_FIELDS)('%s.%s is model-bound', (stepId, key) => {
    const field = getStep(stepId)
      .getConfigSchema()
      .find((f): f is ConfigSliderField => f.type === 'slider' && f.key === key)
    expect(field?.bindsToModel).toBe(true)
  })

  it('a classifier threshold set for one model does not survive a model change', () => {
    const own = getStepDefinition('vehicle-classifier').defaultModelId
    const other = customEntry('my-vehicle-types')
    const child = (modelId: string): PipelineDefaultStep => ({
      addonId: 'vehicle-classifier',
      addonName: 'Vehicle',
      slot: 'classifier',
      inputClasses: ['vehicle'],
      outputClasses: [],
      enabled: true,
      modelId,
      children: [],
      settings: { minConfidence: 0.9, [modelBindingKey('minConfidence')]: own },
    })
    const settingsOn = (modelId: string): Readonly<Record<string, unknown>> | undefined =>
      buildExecutableTree([child(modelId)], getEngine, (_s, id) =>
        id === other.id ? other : undefined,
      ).roots[0]?.settings
    expect(settingsOn(own)?.['minConfidence']).toBe(0.9)
    expect(settingsOn(other.id)?.['minConfidence']).toBe(
      getStepDefinition('vehicle-classifier').defaultConfidence,
    )
  })
})

describe('enrichment model defaults (D741, measured 2026-10-07)', () => {
  const entry = (stepId: string, id: string): ModelCatalogEntry | undefined =>
    getStepDefinition(stepId).models.find((m) => m.id === id)

  it('the vehicle type classifier: 0.60 (precision crosses 0.90 there)', () => {
    expect(entry('vehicle-classifier', 'vehicle-type-v1')?.defaultConfidence).toBe(0.6)
  })

  it('the animal classifier: 0.80, and the catalog says it is unreliable', () => {
    const animal = entry('animal-classifier', 'animal-classifier')
    expect(animal?.defaultConfidence).toBe(0.8)
    expect(animal?.description).toMatch(/unreliable/i)
  })

  it('YuNet DETECTS at 0.70, and the face EMBEDDING keeps its 0.85 gate', () => {
    expect(entry('face-detection', 'yunet-2023mar')?.defaultConfidence).toBe(0.7)
    expect(getStepDefinition('face-embedding').defaultMinParentScore).toBe(0.85)
  })

  it('the plate detector is unmeasured and stays at 0.50', () => {
    const plate = entry('plate-detection', 'yolox-tiny-plate')
    expect(plate?.defaultConfidence ?? getStepDefinition('plate-detection').defaultConfidence).toBe(
      0.5,
    )
  })

  it('root-supplied species floors, per root model', () => {
    const floors = (id: string) => catalogEntry(id)?.suppliedLabelFloors
    expect(floors('yolov9m-320-int8')).toEqual({ 'animal-classifier': 0.75 })
    expect(floors('yolov9m-640-int8')).toEqual({ 'animal-classifier': 0.7 })
    expect(floors('yolov9c-640-int8')).toEqual({ 'animal-classifier': 0.75 })
    expect(floors('yolo26s')).toEqual({ 'animal-classifier': 0.45 })
    expect(floors('yolo26m')).toEqual({ 'animal-classifier': 0.7 })
    expect(floors('yolo26s-int8')).toEqual({ 'animal-classifier': 0.55 })
    expect(floors('ssd-mobilenet-v2-coco-edgetpu')).toEqual({ 'animal-classifier': 1 })
    expect(floors('yolo26n')).toBeUndefined()
  })
})

function catalogEntry(id: string): ModelCatalogEntry | undefined {
  return OBJECT_DETECTION_MODELS.find((m) => m.id === id)
}

describe('the classifier slider shows the ROOT model’s label floor when the root supplies it', () => {
  it('defaultByModel on animal-classifier minConfidence lists every supplying root', () => {
    const step = getStep('animal-classifier')
    const annotated = withRootSuppliedLabelDefaults(
      'animal-classifier',
      step.getConfigSchema(),
      OBJECT_DETECTION_MODELS,
    )
    const field = annotated.find(
      (f): f is ConfigSliderField => f.type === 'slider' && f.key === 'minConfidence',
    )
    const byModel = field?.modelApplicability?.defaultByModel
    expect(byModel?.[V9]).toBe(0.75)
    expect(byModel?.['ssd-mobilenet-v2-coco-edgetpu']).toBe(1)
    // A root with no measured floor: the macro floor alone, shown as 0.
    expect(byModel?.['yolo26n']).toBe(0)
  })

  it('a step no root supplies a fine label for is left untouched', () => {
    const schema = getStep('bird-classifier').getConfigSchema()
    expect(
      withRootSuppliedLabelDefaults('bird-classifier', schema, OBJECT_DETECTION_MODELS),
    ).toEqual(schema)
  })
})
