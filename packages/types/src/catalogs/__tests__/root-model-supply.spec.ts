/**
 * D730 — which steps a root model can supply, and when a camera uses it.
 */
import { describe, expect, it } from 'vitest'
import type { RootStepSupply } from '../../types/models.js'
import {
  allowedSuppliedEffect,
  containingParentIndex,
  deriveRootSupplies,
  describeRootSupplies,
  LABEL_SUPPLY_VOCABULARIES,
  linkedLabelStepId,
  linkedStepOf,
  readUseRootModel,
  resolveRootSupply,
  rootSuppliesOf,
  rootSupplyServes,
  supplyFor,
} from '../root-model-supply.js'
import { COCO_80_LABELS, COCO_TO_MACRO } from '../coco-classmap.js'
import { buildPlusCatalogClassMap, plusCatalogLabelFields } from '../plus-catalog-classmap.js'

/**
 * The REAL labelmap of the plus catalog base EdgeTPU (mobiledet, 2026.1) model
 * imported on the operator's hub as `frigate-plus-e39924321228f76edd6b727c0cf2a4be`
 * — 41 labels, read from the registry row on 2026-10-06. It carries `face` and
 * `license_plate`; it has no `truck` and no `sheep`.
 */
const PLUS_CATALOG_CORAL_2026_1 = [
  'person',
  'dhl',
  'deer',
  'dog',
  'horse',
  'package',
  'waste_bin',
  'an_post',
  'bird',
  'robot_lawnmower',
  'raccoon',
  'boat',
  'fox',
  'umbrella',
  'bear',
  'cat',
  'license_plate',
  'purolator',
  'bbq_grill',
  'cow',
  'face',
  'usps',
  'ups',
  'amazon',
  'postnl',
  'fedex',
  'bicycle',
  'squirrel',
  'nzpost',
  'car',
  'motorcycle',
  'postnord',
  'gls',
  'dpd',
  'goat',
  'rabbit',
  'kangaroo',
  'skunk',
  'canada_post',
  'royal_mail',
  'school_bus',
]

const COCO = COCO_80_LABELS.map((l) => l.id)
const COCO_SUPPLIES = deriveRootSupplies(COCO, COCO_TO_MACRO)
const PLUS_CATALOG_SUPPLIES = deriveRootSupplies(
  PLUS_CATALOG_CORAL_2026_1,
  buildPlusCatalogClassMap(PLUS_CATALOG_CORAL_2026_1),
)
/** A plugin catalog-style identity root: its labels ARE the macros. */
const PLUGIN_CATALOG_LABELS = ['person', 'vehicle', 'animal']
const PLUGIN_CATALOG_SUPPLIES = deriveRootSupplies(PLUGIN_CATALOG_LABELS, {
  mapping: { person: 'person', vehicle: 'vehicle', animal: 'animal' },
})

describe('deriveRootSupplies — every root is judged the same way', () => {
  it('a CamStack COCO model supplies animals 6/8 and vehicles 5/8 — no COCO exception', () => {
    const animal = supplyFor(COCO_SUPPLIES, 'animal-classifier')
    expect(animal).toEqual({
      kind: 'label',
      stepId: 'animal-classifier',
      labelToEffect: {
        bird: 'bird',
        cat: 'cat',
        dog: 'dog',
        horse: 'horse',
        sheep: 'sheep',
        cow: 'cow',
      },
      uncovered: ['deer', 'squirrel'],
    })
    const vehicle = supplyFor(COCO_SUPPLIES, 'vehicle-classifier')
    expect(vehicle?.kind === 'label' ? vehicle.labelToEffect : null).toEqual({
      bicycle: 'Bicycle',
      car: 'Car',
      motorcycle: 'Motorcycle',
      bus: 'Bus',
      truck: 'Truck',
    })
    expect(describeRootSupplies(COCO_SUPPLIES)).toBe('animals 6/8 · vehicles 5/8')
  })

  it('COCO declares no package (suitcase is not `package`), no plate, no face', () => {
    expect(supplyFor(COCO_SUPPLIES, 'package-detection')).toBeUndefined()
    expect(supplyFor(COCO_SUPPLIES, 'plate-detection')).toBeUndefined()
    expect(supplyFor(COCO_SUPPLIES, 'face-detection')).toBeUndefined()
  })

  it('the real plus catalog Coral row declares animals 7/8, vehicles, package, plates and faces', () => {
    expect(supplyFor(PLUS_CATALOG_SUPPLIES, 'animal-classifier')).toMatchObject({
      uncovered: ['sheep'],
    })
    expect(supplyFor(PLUS_CATALOG_SUPPLIES, 'vehicle-classifier')).toMatchObject({
      labelToEffect: {
        bicycle: 'Bicycle',
        car: 'Car',
        motorcycle: 'Motorcycle',
        school_bus: 'Bus',
      },
      uncovered: ['Ambulance', 'Taxi', 'Truck', 'Van'],
    })
    expect(supplyFor(PLUS_CATALOG_SUPPLIES, 'package-detection')).toEqual({
      kind: 'label',
      stepId: 'package-detection',
      labelToEffect: { package: 'package' },
      uncovered: [],
    })
    expect(supplyFor(PLUS_CATALOG_SUPPLIES, 'plate-detection')).toEqual({
      kind: 'crop',
      stepId: 'plate-detection',
      rootLabels: ['license_plate'],
      parentMacro: 'vehicle',
      childClass: 'plate',
    })
    expect(supplyFor(PLUS_CATALOG_SUPPLIES, 'face-detection')).toEqual({
      kind: 'crop',
      stepId: 'face-detection',
      rootLabels: ['face'],
      parentMacro: 'person',
      childClass: 'face',
    })
    expect(describeRootSupplies(PLUS_CATALOG_SUPPLIES)).toBe(
      'animals 7/8 · vehicles 4/8 · packages · plates · faces',
    )
  })

  it('a crop supply is declared only from labels the model really lists', () => {
    const noCrops = PLUS_CATALOG_CORAL_2026_1.filter((l) => l !== 'face' && l !== 'license_plate')
    const supplies = deriveRootSupplies(noCrops, buildPlusCatalogClassMap(noCrops))
    expect(supplyFor(supplies, 'plate-detection')).toBeUndefined()
    expect(supplyFor(supplies, 'face-detection')).toBeUndefined()
  })

  it('plusCatalogLabelFields computes the declaration at import, crop kinds included', () => {
    const fields = plusCatalogLabelFields(PLUS_CATALOG_CORAL_2026_1)
    expect(fields.suppliesSteps?.map((s) => s.stepId)).toEqual([
      'animal-classifier',
      'vehicle-classifier',
      'package-detection',
      'plate-detection',
      'face-detection',
    ])
  })

  it('a plugin catalog identity root (labels are macros) supplies nothing', () => {
    expect(PLUGIN_CATALOG_SUPPLIES).toEqual([])
  })

  it('a label supplies only the step of the macro its classMap sends it to', () => {
    expect(deriveRootSupplies(['dog'], { mapping: { dog: 'vehicle' } })).toEqual([])
    expect(deriveRootSupplies(['dog'], undefined)).toEqual([])
  })

  it('every derived effect is in the step vocabulary', () => {
    for (const s of [...COCO_SUPPLIES, ...PLUS_CATALOG_SUPPLIES]) {
      if (s.kind !== 'label') continue
      for (const effect of Object.values(s.labelToEffect)) {
        expect(LABEL_SUPPLY_VOCABULARIES[s.stepId]).toContain(effect)
      }
    }
  })
})

const IN_640 = { width: 640, height: 640 }
const IN_320 = { width: 320, height: 320 }

describe('rootSuppliesOf — declared at import, derived on read', () => {
  const stepDefaults = { labels: COCO, classMap: COCO_TO_MACRO }

  it('a built-in entry with no labels of its own derives from the step (COCO)', () => {
    expect(rootSuppliesOf({ labels: [], inputSize: IN_640 }, stepDefaults)).toEqual(COCO_SUPPLIES)
    expect(rootSuppliesOf(undefined, stepDefaults)).toEqual(COCO_SUPPLIES)
  })

  it('a row registered before the field existed is re-derived from its own labelmap', () => {
    const row = {
      inputSize: IN_320,
      labels: PLUS_CATALOG_CORAL_2026_1.map((id) => ({ id, name: id })),
      classMap: buildPlusCatalogClassMap(PLUS_CATALOG_CORAL_2026_1),
    }
    const supplies = rootSuppliesOf(row, stepDefaults)
    expect(supplyFor(supplies, 'plate-detection')?.kind).toBe('crop')
    expect(supplyFor(supplies, 'face-detection')?.kind).toBe('crop')
  })

  it('a stored declaration is read as stored', () => {
    const stored: readonly RootStepSupply[] = [
      {
        kind: 'label',
        stepId: 'package-detection',
        labelToEffect: { package: 'package' },
        uncovered: [],
      },
    ]
    expect(
      rootSuppliesOf({ labels: [], inputSize: IN_640, suppliesSteps: stored }, stepDefaults),
    ).toEqual(stored)
  })

  it('stamps the root input side on every crop supply, from the entry', () => {
    const row = {
      inputSize: { width: 320, height: 320 },
      labels: ['person', 'face'].map((id) => ({ id, name: id })),
      classMap: buildPlusCatalogClassMap(['person', 'face']),
    }
    expect(supplyFor(rootSuppliesOf(row, stepDefaults), 'face-detection')).toMatchObject({
      rootInputPx: 320,
    })
  })
})

describe('resolveRootSupply — intent kept beside the model, effective only when declared', () => {
  it('defaults: label kinds on, crop kinds off', () => {
    expect(readUseRootModel('animal-classifier', undefined)).toBe(true)
    expect(readUseRootModel('vehicle-classifier', {})).toBe(true)
    expect(readUseRootModel('package-detection', {})).toBe(true)
    expect(readUseRootModel('plate-detection', {})).toBe(false)
    expect(readUseRootModel('face-detection', {})).toBe(false)
  })

  it('an explicit flag wins; a retired labelLink value is read as the flag', () => {
    expect(readUseRootModel('animal-classifier', { useRootModel: false })).toBe(false)
    expect(readUseRootModel('plate-detection', { useRootModel: true })).toBe(true)
    expect(readUseRootModel('animal-classifier', { labelLink: 'run' })).toBe(false)
    expect(readUseRootModel('plate-detection', { labelLink: 'skip-when-filled' })).toBe(true)
    expect(readUseRootModel('animal-classifier', { useRootModel: true, labelLink: 'run' })).toBe(
      true,
    )
  })

  it('the root switch CamStack → plus catalog → plugin catalog → back', () => {
    const settings = { modelId: 'animal-classifier-v2' }
    const states = [
      COCO_SUPPLIES,
      PLUS_CATALOG_SUPPLIES,
      PLUGIN_CATALOG_SUPPLIES,
      COCO_SUPPLIES,
    ].map((root) => resolveRootSupply('animal-classifier', settings, root))
    expect(states.map((s) => s.effective)).toEqual([true, true, false, true])
    expect(states.map((s) => s.inactive)).toEqual([false, false, true, false])
    // The intent never moves, and nothing here touches the step's model.
    expect(states.every((s) => s.intent)).toBe(true)
    expect(settings).toEqual({ modelId: 'animal-classifier-v2' })
  })

  it('package across the same switch: COCO has no package → inactive, plus catalog → active', () => {
    const run = (root: readonly RootStepSupply[]) =>
      resolveRootSupply('package-detection', {}, root)
    expect(run(COCO_SUPPLIES)).toMatchObject({
      effective: false,
      inactive: true,
      inactiveReason: 'root-does-not-declare',
    })
    expect(run(PLUS_CATALOG_SUPPLIES)).toMatchObject({ effective: true, inactive: false })
    expect(run(PLUGIN_CATALOG_SUPPLIES)).toMatchObject({ effective: false, inactive: true })
  })

  it('plates are effective only when opted in AND the root draws them', () => {
    expect(resolveRootSupply('plate-detection', {}, PLUS_CATALOG_SUPPLIES).effective).toBe(false)
    expect(
      resolveRootSupply('plate-detection', { useRootModel: true }, PLUS_CATALOG_SUPPLIES).effective,
    ).toBe(true)
    expect(
      resolveRootSupply('plate-detection', { useRootModel: true }, COCO_SUPPLIES),
    ).toMatchObject({ effective: false, inactive: true })
  })

  it('an uncovered class never blocks the supply', () => {
    // plus catalog cannot say `sheep`; the classes list still asks for every class.
    expect(
      resolveRootSupply('animal-classifier', { enabledClasses: [] }, PLUS_CATALOG_SUPPLIES)
        .effective,
    ).toBe(true)
  })
})

describe('root faces — in force only from a root that sees the frame at 640 or more', () => {
  const stepDefaults = { labels: COCO, classMap: COCO_TO_MACRO }
  const row = (inputSize: { width: number; height: number }) => ({
    inputSize,
    labels: PLUS_CATALOG_CORAL_2026_1.map((id) => ({ id, name: id })),
    classMap: buildPlusCatalogClassMap(PLUS_CATALOG_CORAL_2026_1),
  })
  const opted = { useRootModel: true }

  it('the 320 px plus catalog Coral root: declared, intended, inactive — root-input-too-small', () => {
    expect(
      resolveRootSupply('face-detection', opted, rootSuppliesOf(row(IN_320), stepDefaults)),
    ).toMatchObject({ effective: false, inactive: true, inactiveReason: 'root-input-too-small' })
  })

  it('the same labelmap at 640: effective', () => {
    expect(
      resolveRootSupply('face-detection', opted, rootSuppliesOf(row(IN_640), stepDefaults)),
    ).toMatchObject({ effective: true, inactive: false })
  })

  it('an unknown input size never passes the gate', () => {
    expect(resolveRootSupply('face-detection', opted, PLUS_CATALOG_SUPPLIES)).toMatchObject({
      effective: false,
      inactiveReason: 'root-input-too-small',
    })
  })

  it('plates have no input gate', () => {
    expect(
      resolveRootSupply('plate-detection', opted, rootSuppliesOf(row(IN_320), stepDefaults))
        .effective,
    ).toBe(true)
  })
})

describe('allowedSuppliedEffect — the step class list filters the root labels', () => {
  it('empty / absent = every class; a switched-off class is refused', () => {
    expect(allowedSuppliedEffect('dog', undefined)).toBe(true)
    expect(allowedSuppliedEffect('dog', { enabledClasses: [] })).toBe(true)
    expect(allowedSuppliedEffect('dog', { enabledClasses: ['cat'] })).toBe(false)
    expect(allowedSuppliedEffect('cat', { enabledClasses: ['cat'] })).toBe(true)
  })
})

describe('crop supply', () => {
  it('a plate is served to the reader; a refined face to the embedder', () => {
    expect(rootSupplyServes('plate-detection')).toEqual(['plate-ocr'])
    expect(rootSupplyServes('face-detection')).toEqual(['face-embedding'])
  })

  it('containment picks the smallest parent holding the box, or none', () => {
    const plate = { x: 110, y: 160, w: 30, h: 10 }
    const car = { x: 100, y: 100, w: 100, h: 80 }
    const bus = { x: 0, y: 0, w: 400, h: 300 }
    expect(containingParentIndex(plate, [bus, car])).toBe(1)
    expect(containingParentIndex(plate, [{ x: 500, y: 500, w: 50, h: 50 }])).toBe(-1)
    // Half outside its only candidate: not contained.
    expect(containingParentIndex({ x: 190, y: 160, w: 30, h: 10 }, [car])).toBe(-1)
  })
})

describe('linked label attribution', () => {
  it('round-trips the step id and refuses any other prefix', () => {
    expect(linkedStepOf(linkedLabelStepId('vehicle-classifier'))).toBe('vehicle-classifier')
    expect(linkedStepOf('detector:raw-class')).toBeUndefined()
    expect(linkedStepOf('detector-link:plate-detection')).toBeUndefined()
  })
})
