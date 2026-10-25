/**
 * Model-bound step settings (D738): an operator value that is only meaningful
 * for ONE model, stored together with that model's id.
 *
 * The per-class confidence floors are the case it exists for. A score is a
 * property of one detector's output scale — on this hub the median score of a
 * correct person was 0.78 on `yolov9m-320-int8`, 0.68 on `yolo26s-320-int8`,
 * 0.40 on `yolo26n-320-int8` and 0.89 on `yolo26s` (640) — so a floor tuned on
 * one model is wrong on the next. The DEFAULT of such a field belongs to the
 * model (the catalog entry); an operator OVERRIDE belongs to the model it was
 * made for.
 *
 * The binding is checked at READ time against the model that RUNS, never
 * enforced by a write on the model-change path: a model can change without any
 * operator write at all (an unpinned root follows the elected device's
 * hardware-aware default, D736), and an event-driven reset could be dropped
 * (events are telemetry, D8/D11). So:
 *
 *   effective = override   when the stored binding names the running model
 *             | override   when no binding is stored (a legacy / programmatic
 *                          value — it applies to whatever runs, as before D738)
 *             | the running model's default, when it declares one
 *             | the field's global default.
 *
 * Storage shape: the value stays a plain number under its own key (every
 * reader of the raw settings bag keeps working), and the binding is a SIBLING
 * key, {@link modelBindingKey}. Both are flat so the shallow per-key merges of
 * the settings layers (node fold, camera override) carry a value and its
 * binding together whenever one layer writes both — which every writer here
 * does.
 *
 * Lives in the bare `@camstack/types` entry, which every addon bundles, so the
 * runner (`addon-pipeline`) and the editors (`ui-library`, `addon-admin-ui`)
 * apply the same rule.
 */

import type { ConfigField } from '../interfaces/config-ui.js'

/** Suffix of the sibling key that names the model a stored value was made for. */
const MODEL_BINDING_SUFFIX = 'ModelId'

/** `minConfidencePerson` → `minConfidencePersonModelId`. */
export function modelBindingKey(key: string): string {
  return `${key}${MODEL_BINDING_SUFFIX}`
}

/** A loose step-settings bag, as it is stored and travels. */
export type ModelBoundSettingsBag = Readonly<Record<string, unknown>>

/** Where an effective model-bound value came from. */
export type ModelBoundSettingSource = 'override' | 'model-default' | 'global-default'

/** An override that is stored but not applied, because another model runs. */
export interface InapplicableModelBoundOverride {
  readonly value: unknown
  readonly modelId: string
}

/** The effective value of one model-bound field, and why. */
export interface ModelBoundSettingState {
  readonly value: unknown
  readonly source: ModelBoundSettingSource
  /** The model the applied override was made for; absent for a legacy unbound value. */
  readonly boundModelId?: string
  /** A stored override that does NOT apply to the running model. */
  readonly inapplicableOverride?: InapplicableModelBoundOverride
}

/** The model a stored value was made for, or `undefined` when unbound. */
function storedBinding(
  settings: ModelBoundSettingsBag | undefined,
  key: string,
): string | undefined {
  const binding = settings?.[modelBindingKey(key)]
  return typeof binding === 'string' && binding.length > 0 ? binding : undefined
}

/**
 * The effective value of `key` for the model that runs (`runningModelId`,
 * `undefined` when unknown — it then matches no binding).
 */
export function resolveModelBoundSetting(
  settings: ModelBoundSettingsBag | undefined,
  key: string,
  runningModelId: string | undefined,
  modelDefault: unknown,
  globalDefault: unknown,
): ModelBoundSettingState {
  const stored = settings?.[key]
  const binding = storedBinding(settings, key)
  if (stored !== undefined && binding === undefined) {
    return { value: stored, source: 'override' }
  }
  if (stored !== undefined && binding !== undefined && binding === runningModelId) {
    return { value: stored, source: 'override', boundModelId: binding }
  }
  const inapplicable =
    stored !== undefined && binding !== undefined
      ? { inapplicableOverride: { value: stored, modelId: binding } }
      : {}
  if (modelDefault !== undefined) {
    return { value: modelDefault, source: 'model-default', ...inapplicable }
  }
  return { value: globalDefault, source: 'global-default', ...inapplicable }
}

/**
 * The OPERATOR layer of a step's settings as the running model sees it: every
 * model-bound value made for another model is removed (so the default
 * underneath — the running model's — wins the merge), and every binding key is
 * stripped. Unbound values are kept. Returns a fresh object; `undefined` stays
 * `undefined`.
 */
export function applyModelBoundSettings(
  settings: ModelBoundSettingsBag | undefined,
  boundKeys: readonly string[],
  runningModelId: string | undefined,
): Record<string, unknown> | undefined {
  if (settings === undefined) return undefined
  const out: Record<string, unknown> = { ...settings }
  for (const key of boundKeys) {
    const binding = storedBinding(settings, key)
    if (binding !== undefined && binding !== runningModelId) delete out[key]
    delete out[modelBindingKey(key)]
  }
  return out
}

/** Store `value` for `key`, made for `modelId`. Returns a fresh object. */
export function writeModelBoundSetting(
  settings: ModelBoundSettingsBag | undefined,
  key: string,
  value: unknown,
  modelId: string,
): Record<string, unknown> {
  return { ...settings, [key]: value, [modelBindingKey(key)]: modelId }
}

/** Remove an override and its binding — "reset to the model default". */
export function clearModelBoundSetting(
  settings: ModelBoundSettingsBag | undefined,
  key: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...settings }
  delete out[key]
  delete out[modelBindingKey(key)]
  return out
}

/** True when any of `boundKeys` has an override IN FORCE for `modelId`. */
export function hasModelBoundOverrides(
  settings: ModelBoundSettingsBag | undefined,
  boundKeys: readonly string[],
  modelId: string | undefined,
): boolean {
  return boundKeys.some(
    (key) =>
      resolveModelBoundSetting(settings, key, modelId, undefined, undefined).source === 'override',
  )
}

/**
 * "Reset thresholds to model defaults": remove every override of `boundKeys`
 * that is in force for `modelId` (bound to it, or unbound), with its binding —
 * one result, so the editor writes it in one save. An override stored for
 * ANOTHER model is kept: it is not in force here, and it applies again when
 * that model runs.
 */
export function clearModelBoundOverrides(
  settings: ModelBoundSettingsBag | undefined,
  boundKeys: readonly string[],
  modelId: string | undefined,
): Record<string, unknown> {
  return boundKeys.reduce<Record<string, unknown>>(
    (acc, key) =>
      resolveModelBoundSetting(acc, key, modelId, undefined, undefined).source === 'override'
        ? clearModelBoundSetting(acc, key)
        : acc,
    { ...settings },
  )
}

/**
 * The keys of every `bindsToModel` field of a step's config schema, groups
 * flattened (D738). One definition for the runner (which applies the binding)
 * and the orchestrator's Auto tune (which clears those overrides, D745).
 */
export function collectModelBoundKeys(fields: readonly ConfigField[]): string[] {
  return fields.flatMap((field): string[] => {
    if (field.type === 'group') return collectModelBoundKeys(field.fields)
    return 'key' in field && 'bindsToModel' in field && field.bindsToModel === true
      ? [field.key]
      : []
  })
}
