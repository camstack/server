/**
 * D214 — step settings are model-scoped.
 *
 * A step's config schema is static, but whether a knob has any effect depends
 * on WHICH model the step runs. `annotateConfigSchemaForModels` computes, per
 * offered model (static catalog ∪ custom registry), which knobs are
 * inapplicable (and WHY) and which multiselects must offer the MODEL's own
 * labelmap instead of the catalog one. The editors consume the annotation and
 * disable-with-reason instead of rendering a control that silently does
 * nothing.
 */
import { describe, expect, it } from 'vitest'
import type { DetectionCatalogClassMap, ModelCatalogEntry } from '@camstack/types'
import { makeModelCatalogEntry } from '../../__tests__/support/model-catalog-entry.js'
import { getStep, getStepDefinition } from '../registry/step-definitions.js'
import {
  annotateConfigSchemaForModels,
  collectClassMapDropWarning,
} from '../registry/model-knob-applicability.js'

function customEntry(
  id: string,
  labels: readonly string[],
  postprocessor?: ModelCatalogEntry['postprocessor'],
): ModelCatalogEntry {
  return {
    id,
    name: id,
    description: 'test custom model',
    formats: { onnx: { url: `camstack-local://${id}/${id}.onnx`, sizeMB: 10 } },
    inputSize: { width: 320, height: 320 },
    labels: labels.map((l) => ({ id: l, name: l })),
    ...(postprocessor !== undefined ? { postprocessor } : {}),
  }
}

function fieldByKey(fields: readonly { key?: string }[], key: string) {
  const f = fields.find((f) => 'key' in f && f.key === key)
  if (!f) throw new Error(`field ${key} not in schema`)
  return f as {
    key: string
    modelApplicability?: import('@camstack/types').ConfigFieldModelApplicability
  }
}

describe('annotateConfigSchemaForModels — object-detection', () => {
  const step = getStep('object-detection')
  const def = step.definition
  const schema = step.getConfigSchema()

  it('marks the NMS IoU knob inapplicable for models whose decode has fused NMS (custom yolonas, catalog ssd)', () => {
    const plusCatalog = customEntry('frigate-yolonas', ['person', 'car', 'dog'], 'yolonas')
    const models = [...def.models, plusCatalog]
    const annotated = annotateConfigSchemaForModels({
      def,
      configSchema: schema,
      models,
      customModelIds: new Set(['frigate-yolonas']),
    })

    const nms = fieldByKey(annotated, 'nmsIouThreshold')
    expect(nms.modelApplicability?.inapplicable?.['frigate-yolonas']).toMatch(/fused|graph/i)
    // The catalog Coral SSD build has the same property — the annotation is
    // model-truth, not custom-vs-catalog.
    expect(nms.modelApplicability?.inapplicable?.['ssd-mobilenet-v2-coco-edgetpu']).toMatch(
      /fused|graph/i,
    )
    // A plain-yolo model consumes the threshold — never annotated.
    expect(nms.modelApplicability?.inapplicable?.['yolo26n']).toBeUndefined()
  })

  it('restricts macro-keyed knobs to the macros a custom labelmap can actually produce', () => {
    const vehiclesOnly = customEntry('frigate-vehicles', ['car', 'truck', 'deer'], 'yolonas')
    const annotated = annotateConfigSchemaForModels({
      def,
      configSchema: schema,
      models: [...def.models, vehiclesOnly],
      customModelIds: new Set(['frigate-vehicles']),
    })

    // car/truck → vehicle; deer is NOT in COCO_TO_MACRO → dropped upstream.
    const person = fieldByKey(annotated, 'minConfidencePerson')
    expect(person.modelApplicability?.inapplicable?.['frigate-vehicles']).toMatch(/person/i)
    const animal = fieldByKey(annotated, 'minConfidenceAnimal')
    expect(animal.modelApplicability?.inapplicable?.['frigate-vehicles']).toMatch(/animal/i)
    const vehicle = fieldByKey(annotated, 'minConfidenceVehicle')
    expect(vehicle.modelApplicability?.inapplicable?.['frigate-vehicles']).toBeUndefined()

    const enabled = fieldByKey(annotated, 'enabledMacroClasses')
    expect(enabled.modelApplicability?.optionsByModel?.['frigate-vehicles']).toEqual([
      { value: 'vehicle', label: 'Vehicle' },
    ])
  })

  it('leaves catalog models with full labelmaps unannotated on macro knobs', () => {
    const annotated = annotateConfigSchemaForModels({
      def,
      configSchema: schema,
      models: [...def.models],
      customModelIds: new Set(),
    })
    const person = fieldByKey(annotated, 'minConfidencePerson')
    expect(person.modelApplicability?.inapplicable?.['yolo26n']).toBeUndefined()
    const enabled = fieldByKey(annotated, 'enabledMacroClasses')
    expect(enabled.modelApplicability?.optionsByModel).toBeUndefined()
    // Geometry knobs are generic — never annotated for anyone.
    const guard = fieldByKey(annotated, 'fullFrameGuardHardAreaRatio')
    expect(guard.modelApplicability).toBeUndefined()
  })

  it('flags a model whose labelmap maps to NO macro as fully inapplicable on the class offer', () => {
    const logosOnly = customEntry('plus-catalog-logos', ['amazon', 'ups', 'fedex'], 'yolonas')
    const annotated = annotateConfigSchemaForModels({
      def,
      configSchema: schema,
      models: [...def.models, logosOnly],
      customModelIds: new Set(['plus-catalog-logos']),
    })
    const enabled = fieldByKey(annotated, 'enabledMacroClasses')
    expect(enabled.modelApplicability?.inapplicable?.['plus-catalog-logos']).toMatch(/label/i)
  })
})

describe('annotateConfigSchemaForModels — classifier class allow-list', () => {
  it('offers the CUSTOM model its own labelmap on enabledClasses', () => {
    const step = getStep('animal-classifier')
    const def = step.definition
    const schema = step.getConfigSchema()
    const custom = customEntry('my-wildlife', ['wolf', 'boar'])
    const annotated = annotateConfigSchemaForModels({
      def,
      configSchema: schema,
      models: [...def.models, custom],
      customModelIds: new Set(['my-wildlife']),
    })
    const enabled = fieldByKey(annotated, 'enabledClasses')
    expect(enabled.modelApplicability?.optionsByModel?.['my-wildlife']).toEqual([
      { value: 'wolf', label: 'wolf' },
      { value: 'boar', label: 'boar' },
    ])
    // Catalog classifiers keep the curated offer.
    expect(enabled.modelApplicability?.optionsByModel?.['animal-classifier']).toBeUndefined()
    // The generic threshold stays generic.
    const minConf = fieldByKey(annotated, 'minConfidence')
    expect(minConf.modelApplicability).toBeUndefined()
  })
})

describe('annotateConfigSchemaForModels — plate-ocr rectify', () => {
  it('marks rectify inapplicable for the fixed-slot reader (its crop policy never deskews)', () => {
    const step = getStep('plate-ocr')
    const def = step.definition
    const schema = step.getConfigSchema()
    const annotated = annotateConfigSchemaForModels({
      def,
      configSchema: schema,
      models: [...def.models],
      customModelIds: new Set(),
    })
    const rectify = fieldByKey(annotated, 'rectify')
    expect(rectify.modelApplicability?.inapplicable?.['cct-s-v2-global']).toMatch(/deskew|raw/i)
    expect(rectify.modelApplicability?.inapplicable?.['vgg-english-g2']).toBeUndefined()
  })
})

describe('collectClassMapDropWarning', () => {
  it('lists the custom labels the step classMap will silently drop', () => {
    const def = getStepDefinition('object-detection')
    const plusCatalog = customEntry(
      'frigate-plus',
      ['person', 'car', 'dog', 'deer', 'package', 'amazon'],
      'yolonas',
    )
    const warning = collectClassMapDropWarning(def, plusCatalog)
    expect(warning).not.toBeNull()
    expect(warning?.unmappedLabels).toEqual(['deer', 'package', 'amazon'])
    expect(warning?.mappedCount).toBe(3)
  })

  it('returns null for catalog entries with no own labels and for steps without a dropping classMap', () => {
    const def = getStepDefinition('object-detection')
    const catalog = def.models.find((m) => m.id === 'yolo26n')
    expect(catalog).toBeDefined()
    if (catalog) expect(collectClassMapDropWarning(def, catalog)).toBeNull()

    const plateDef = getStepDefinition('plate-detection')
    const custom = customEntry('my-plate', ['plate'])
    expect(collectClassMapDropWarning(plateDef, custom)).toBeNull()
  })

  it('uses the model identity classMap so vehicle/animal are not treated as dropped', () => {
    const def = getStepDefinition('object-detection')
    const classMap: DetectionCatalogClassMap = {
      mapping: { person: 'person', vehicle: 'vehicle', animal: 'animal' },
      preserveOriginal: false,
    }
    const pluginCatalog = makeModelCatalogEntry({
      ...customEntry('plugin-catalog-yolo', ['person', 'vehicle', 'animal']),
      classMap,
    })
    expect(collectClassMapDropWarning(def, pluginCatalog)).toBeNull()

    const annotated = annotateConfigSchemaForModels({
      def,
      configSchema: getStep('object-detection').getConfigSchema(),
      models: [...def.models, pluginCatalog],
      customModelIds: new Set(['plugin-catalog-yolo']),
    })
    const vehicle = fieldByKey(annotated, 'minConfidenceVehicle')
    const animal = fieldByKey(annotated, 'minConfidenceAnimal')
    expect(vehicle.modelApplicability?.inapplicable?.['plugin-catalog-yolo']).toBeUndefined()
    expect(animal.modelApplicability?.inapplicable?.['plugin-catalog-yolo']).toBeUndefined()
  })
})
