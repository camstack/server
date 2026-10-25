import { CLASS_MAP_MACRO_TARGETS, type DetectionCatalogClassMap } from '../types/labels.js'
import type { RootStepSupply } from '../types/models.js'
import { deriveRootSupplies } from './root-model-supply.js'
import { COCO_TO_MACRO } from './coco-classmap.js'

/** A macro a detection catalog classMap may resolve to. */
export type ClassMapMacroTarget = (typeof CLASS_MAP_MACRO_TARGETS)[number]

function isClassMapMacroTarget(value: string): value is ClassMapMacroTarget {
  return CLASS_MAP_MACRO_TARGETS.some((target) => target === value)
}

/**
 * Raw plus catalog label → detection macro. Every label of the documented
 * plus catalog base set (docs.frigate.video/plus, verified 2026-08-21) is either
 * here or in {@link PLUS_CATALOG_UNMAPPED_LABELS}, with the reason it is not.
 *
 * Why this exists: a plus catalog import used to carry NO classMap, so it inherited
 * the step's `COCO_TO_MACRO` (`preserveOriginal: false`) and the executor
 * dropped every label COCO does not name — deer, raccoon, fox, squirrel, goat,
 * rabbit, skunk, kangaroo, possum, rodent, school_bus, garbage_truck and even
 * `package` vanished as `class-filter` discards. The executor keeps the raw
 * label as `originalClass` whenever the map resolves it, so the fine identity
 * survives under the macro.
 */
export const PLUS_CATALOG_TO_MACRO: Readonly<Record<string, ClassMapMacroTarget>> = {
  // People
  person: 'person',
  baby: 'person',
  // Vehicles
  car: 'vehicle',
  motorcycle: 'vehicle',
  bicycle: 'vehicle',
  boat: 'vehicle',
  school_bus: 'vehicle',
  garbage_truck: 'vehicle',
  // Animals
  dog: 'animal',
  cat: 'animal',
  deer: 'animal',
  horse: 'animal',
  bird: 'animal',
  raccoon: 'animal',
  fox: 'animal',
  bear: 'animal',
  cow: 'animal',
  squirrel: 'animal',
  goat: 'animal',
  rabbit: 'animal',
  skunk: 'animal',
  kangaroo: 'animal',
  possum: 'animal',
  rodent: 'animal',
  // Other
  package: 'package',
}

/**
 * plus catalog labels deliberately left OUT of {@link PLUS_CATALOG_TO_MACRO}.
 *
 * - `attribute`: plus catalog emits these INSIDE a parent box (a face inside a
 *   person, a plate or a carrier logo on a vehicle). Mapping one to its
 *   parent's macro would spawn a second, overlapping track for the same
 *   subject. `face` and `license_plate` are instead declared as CROP supplies
 *   (D730): the box becomes a detail child of the person / vehicle containing
 *   it, when the face / plate step uses the root model.
 * - `no-macro`: an object with no detection macro to live under.
 */
export const PLUS_CATALOG_UNMAPPED_LABELS: Readonly<Record<string, 'attribute' | 'no-macro'>> = {
  face: 'attribute',
  license_plate: 'attribute',
  amazon: 'attribute',
  usps: 'attribute',
  ups: 'attribute',
  fedex: 'attribute',
  dhl: 'attribute',
  an_post: 'attribute',
  purolator: 'attribute',
  postnl: 'attribute',
  nzpost: 'attribute',
  postnord: 'attribute',
  gls: 'attribute',
  dpd: 'attribute',
  canada_post: 'attribute',
  royal_mail: 'attribute',
  waste_bin: 'no-macro',
  bbq_grill: 'no-macro',
  robot_lawnmower: 'no-macro',
  umbrella: 'no-macro',
  baby_stroller: 'no-macro',
}

/**
 * The per-model classMap for a plus catalog / plus catalog detector, derived from ITS
 * labelmap: each label resolves through {@link PLUS_CATALOG_TO_MACRO} first,
 * then `COCO_TO_MACRO` (plus catalog's default model ships the COCO-91 labelmap, so
 * a preset import may carry either vocabulary). A label neither knows is left
 * out, and `preserveOriginal: false` drops it in the executor — the same
 * contract as the COCO map, now with the plus catalog vocabulary in it.
 */
export function buildPlusCatalogClassMap(labels: readonly string[]): DetectionCatalogClassMap {
  const mapping: Record<string, ClassMapMacroTarget> = {}
  for (const label of labels) {
    const target = PLUS_CATALOG_TO_MACRO[label] ?? COCO_TO_MACRO.mapping[label]
    if (target !== undefined && isClassMapMacroTarget(target)) mapping[label] = target
  }
  return { mapping, preserveOriginal: false }
}

/** The label-derived fields of a plus catalog catalog entry. */
export interface PlusCatalogLabelFields {
  readonly classMap: DetectionCatalogClassMap
  readonly suppliesSteps?: readonly RootStepSupply[]
}

/**
 * Everything a plus catalog / plus catalog entry derives from ITS OWN labelmap: the
 * classMap and the steps it can supply (D730) — label and crop kinds alike.
 * Every plus catalog builder spreads this at import, so the two cannot be derived
 * from different label lists, and no family is assumed to carry a label it
 * does not list.
 */
export function plusCatalogLabelFields(labels: readonly string[]): PlusCatalogLabelFields {
  const classMap = buildPlusCatalogClassMap(labels)
  const supplies = deriveRootSupplies(labels, classMap)
  return supplies.length > 0 ? { classMap, suppliesSteps: supplies } : { classMap }
}

/**
 * Per-class confidence-floor defaults of an imported stock plus catalog detector
 * (D738): its per-detection `min_score` default, 0.5, for every class. Its
 * track-level `threshold` (the median of a track's recent scores) has no
 * counterpart in CamStack's per-detection floors and is not carried.
 */
export const PLUS_CATALOG_STOCK_CLASS_FLOORS: Readonly<Record<string, number>> = Object.freeze({
  person: 0.5,
  vehicle: 0.5,
  animal: 0.5,
})

/**
 * Per-class floor defaults of an imported plus catalog detector (D738): the
 * documented starting `min_score` values for plus catalog models, which score
 * higher than the stock ones (person 0.65, car 0.65, cat 0.65, dog 0.70). The
 * macro `animal` takes the lower of its classes, so no class is cut above its
 * documented value.
 */
export const PLUS_CATALOG_CLASS_FLOORS: Readonly<Record<string, number>> = Object.freeze({
  person: 0.65,
  vehicle: 0.65,
  animal: 0.65,
})

/**
 * The `defaultClassFloors` an imported plus catalog entry carries: the import's
 * own, when it states them, else the defaults of its kind. A fresh object.
 */
export function plusCatalogDefaultClassFloors(
  kind: 'stock' | 'plus',
  carried?: Readonly<Record<string, number>>,
): Record<string, number> {
  if (carried !== undefined) return { ...carried }
  return { ...(kind === 'plus' ? PLUS_CATALOG_CLASS_FLOORS : PLUS_CATALOG_STOCK_CLASS_FLOORS) }
}
