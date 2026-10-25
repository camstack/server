/**
 * The layers of a detection step's settings, and the field-level edits on them
 * (D754, D927).
 *
 * A step's settings reach a session through two stored layers, merged key by
 * key — a key in the higher layer wins:
 *
 *   node         the node's base for the accelerator that runs the step
 *   camera       `cameraSettings[cam].stepSettings[step]` — camera-semantic
 *                keys only, on every accelerator (never a model-bound field)
 *
 * Below them sits the default: the running model's (D738) or the field's own.
 *
 * Every layer is SPARSE and FIELD-LEVEL. A key present in a layer is an
 * override; an absent key inherits. Two consequences that every editor must
 * respect, and why this module exists:
 *
 *   - A model-bound field (D738) occupies TWO keys, its value and
 *     `<key>ModelId`. They are written, compared and removed as one unit — a
 *     value without its binding over a lower layer's binding would be judged
 *     against the wrong model.
 *   - An editor writes a DIFF against the merged layers below, never a copy of
 *     them. A copy pins every field at the value it had that day, so later
 *     edits below never reach it (the full-copy "Override" this replaced).
 */

import { modelBindingKey } from './model-bound-settings.js'

/** One stored settings layer. */
export type StepSettingsBag = Readonly<Record<string, unknown>>

/** The stored layers, from the top. `undefined` = the layer stores nothing for this step. */
export interface StepSettingsLayers {
  readonly camera?: StepSettingsBag
  readonly node?: StepSettingsBag
}

/** Which stored layer supplies a field, or `default` when none does. */
export type StepSettingSource = 'camera' | 'node' | 'default'

/** Top-down order of the stored layers. */
const LAYER_ORDER = ['camera', 'node'] as const

/**
 * The keys one field occupies in a bag: its own, plus its binding key when it
 * binds to a model. `boundKeys` = `collectModelBoundKeys(schema)`.
 */
export function fieldUnitKeys(key: string, boundKeys: readonly string[]): readonly string[] {
  return boundKeys.includes(key) ? [key, modelBindingKey(key)] : [key]
}

/** The field a stored key belongs to (`minConfidencePersonModelId` → `minConfidencePerson`). */
function unitOf(storedKey: string, boundKeys: readonly string[]): string {
  const owner = boundKeys.find((k) => modelBindingKey(k) === storedKey)
  return owner ?? storedKey
}

/** Structural equality for stored values (numbers, strings, booleans, arrays, plain objects). */
export function settingValuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => settingValuesEqual(v, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every((k) => settingValuesEqual(a[k], b[k]))
  }
  return false
}

function isPlainObject(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Merge bags bottom-up (later wins, per key). Fresh object. */
export function mergeSettingsBags(
  ...bags: readonly (StepSettingsBag | undefined)[]
): Record<string, unknown> {
  return bags.reduce<Record<string, unknown>>((acc, bag) => ({ ...acc, ...bag }), {})
}

/** The merged value of the layers BELOW `layer` (what removing a key from `layer` falls back to). */
export function settingsBelow(
  layers: StepSettingsLayers,
  layer: Exclude<StepSettingSource, 'default'>,
): Record<string, unknown> {
  const below = LAYER_ORDER.slice(LAYER_ORDER.indexOf(layer) + 1)
  return mergeSettingsBags(...below.toReversed().map((id) => layers[id]))
}

/** The effective bag: every stored layer merged. */
export function effectiveStepSettings(layers: StepSettingsLayers): Record<string, unknown> {
  return mergeSettingsBags(layers.node, layers.camera)
}

/** The highest stored layer that holds any key of `key`'s unit, or `default`. */
export function stepSettingSource(
  layers: StepSettingsLayers,
  key: string,
  boundKeys: readonly string[],
): StepSettingSource {
  const unit = fieldUnitKeys(key, boundKeys)
  for (const id of LAYER_ORDER) {
    const bag = layers[id]
    if (bag !== undefined && unit.some((k) => bag[k] !== undefined)) return id
  }
  return 'default'
}

/**
 * `layer` with `key`'s unit set from `values` (a bag carrying the unit's new
 * value — e.g. the editor's whole next settings bag). A unit key that `values`
 * does not carry is removed from the layer. Fresh object.
 */
export function withFieldFrom(
  layer: StepSettingsBag | undefined,
  key: string,
  values: StepSettingsBag,
  boundKeys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...layer }
  for (const k of fieldUnitKeys(key, boundKeys)) {
    if (values[k] === undefined) delete out[k]
    else out[k] = values[k]
  }
  return out
}

/** `layer` without `key`'s unit — "reset to the next level". Fresh object. */
export function withoutField(
  layer: StepSettingsBag | undefined,
  key: string,
  boundKeys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...layer }
  for (const k of fieldUnitKeys(key, boundKeys)) delete out[k]
  return out
}

/** Every field unit stored in `layer`, by its field key. */
function unitsIn(layer: StepSettingsBag, boundKeys: readonly string[]): readonly string[] {
  return [...new Set(Object.keys(layer).map((k) => unitOf(k, boundKeys)))]
}

/** True when every key of `key`'s unit has the same value in `layer` as in `below`. */
function unitEqualsBelow(
  layer: StepSettingsBag,
  below: StepSettingsBag,
  key: string,
  boundKeys: readonly string[],
): boolean {
  return fieldUnitKeys(key, boundKeys).every((k) => settingValuesEqual(layer[k], below[k]))
}

/**
 * `layer` reduced to the fields that DIFFER from `below` — what an editor
 * stores. A unit is kept or dropped whole. `undefined` when nothing is left.
 */
export function diffStepSettings(
  layer: StepSettingsBag | undefined,
  below: StepSettingsBag,
  boundKeys: readonly string[],
): Record<string, unknown> | undefined {
  if (layer === undefined) return undefined
  const out: Record<string, unknown> = {}
  for (const unit of unitsIn(layer, boundKeys)) {
    if (unitEqualsBelow(layer, below, unit, boundKeys)) continue
    for (const k of fieldUnitKeys(unit, boundKeys)) {
      if (layer[k] !== undefined) out[k] = layer[k]
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * The fields `layer` stores at exactly the value of the layers below — a
 * legacy full copy's leftovers. They change nothing today and stop every
 * later edit below from reaching this layer. Sorted.
 */
export function fieldsPinnedAtValueBelow(
  layer: StepSettingsBag | undefined,
  below: StepSettingsBag,
  boundKeys: readonly string[],
): readonly string[] {
  if (layer === undefined) return []
  return unitsIn(layer, boundKeys)
    .filter((unit) => unitEqualsBelow(layer, below, unit, boundKeys))
    .toSorted()
}
