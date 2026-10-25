/**
 * Decode-scoped pool settings — the operator values a LOADED pool slot can
 * absorb without re-instantiating its inference session.
 *
 * D219. D214 found `nmsIouThreshold` dead for every model: the slider wrote
 * `step.settings`, `PoolModelConfig` carried the field, the Python decoders
 * read it — and no construction site ever supplied a value, so the pool ran
 * the 0.45 literal forever (the D62 class: a control that writes a store
 * nobody reads). This module is the ONE place the effective value for a
 * `(step, model)` pair is derived, used by BOTH:
 *
 *   - `buildPoolModelConfigForStep` — the value shipped in the `load` command;
 *   - `PipelineModelManager` — the diff that decides whether an already-loaded
 *     slot needs a `reconfigure`.
 *
 * Two derivations would drift, and a drifted diff means the pool silently
 * keeps the old value while the manager believes it applied the new one.
 *
 * It is PURE and fs-free by contract: the manager consults it on the
 * per-dispatch path (once per camera frame), where `buildPoolModelConfigForStep`
 * — which reads the model's label file off disk — must never run.
 *
 * Applicability (D214): the value is only forwarded to decodes that actually
 * run NMS. A fused-NMS export (`yolonas`, `ssd`) pins the default no matter
 * where the operator drags the slider — the UI already declares the knob
 * inapplicable there, and the runtime must not pretend otherwise by shipping a
 * value the decode cannot consult (it would also churn the pool for nothing).
 */
import type { ModelCatalogEntry, PoolModelConfig, StepDefinition } from '@camstack/types'
import { resolveEffectivePostprocessorForEntry } from '../registry/effective-postprocessor.js'
import { postprocessorConsumesNms } from '../registry/model-knob-applicability.js'

/** Default detector NMS IoU threshold forwarded to the Python inference pool.
 *  Matches the historical hardcoded literal in the Python postprocessors, so an
 *  un-set value is byte-identical to the pre-threading behaviour. */
export const NMS_IOU_DEFAULT = 0.45

/** Step-settings key of the object-detection NMS slider (`step-definitions.ts`). */
export const NMS_IOU_SETTING_KEY = 'nmsIouThreshold'

/** Everything an operator can retune on a live pool slot. One field today;
 *  the type exists so a second one cannot be added without teaching the diff,
 *  the pool command and the Python allow-list about it at the same time. */
export interface PoolDecodeSettings {
  readonly nmsIouThreshold: number
}

export interface ResolvePoolDecodeSettingsInputs {
  readonly def: StepDefinition
  readonly modelEntry: ModelCatalogEntry
  /** The dispatched step's settings — `PipelineDefaultStep.settings`. */
  readonly settings?: Readonly<Record<string, unknown>>
  /**
   * Node-level fallback (`EngineFactoryOptions.nmsIouThreshold`) used when the
   * step carries no usable value, or when the model's decode cannot consult
   * one. Absent ⇒ {@link NMS_IOU_DEFAULT}.
   */
  readonly fallbackNmsIouThreshold?: number
}

/**
 * A persisted settings blob is external data — it survives schema changes,
 * hand edits and migrations. Accept only a finite IoU in the open (0,1)
 * interval; anything else falls back rather than reaching the decode, where a
 * 0 would suppress every overlapping box and a 1 would suppress none.
 */
function readIouThreshold(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  if (value <= 0 || value >= 1) return undefined
  return value
}

/** The effective decode-scoped values for a `(step, model)` pair. */
export function resolvePoolDecodeSettings(
  inputs: ResolvePoolDecodeSettingsInputs,
): PoolDecodeSettings {
  const fallback = readIouThreshold(inputs.fallbackNmsIouThreshold) ?? NMS_IOU_DEFAULT
  const postprocessor = resolveEffectivePostprocessorForEntry(inputs.def, inputs.modelEntry)
  if (!postprocessorConsumesNms(postprocessor)) return { nmsIouThreshold: fallback }
  return {
    nmsIouThreshold: readIouThreshold(inputs.settings?.[NMS_IOU_SETTING_KEY]) ?? fallback,
  }
}

/** What a built pool config actually carries — the state the slot is IN after
 *  a `load`, so the manager's diff is anchored to the command it sent, never
 *  to a second derivation of the same inputs. */
export function poolDecodeSettingsOf(config: PoolModelConfig): PoolDecodeSettings {
  return { nmsIouThreshold: config.nmsIouThreshold ?? NMS_IOU_DEFAULT }
}

export function poolDecodeSettingsEqual(a: PoolDecodeSettings, b: PoolDecodeSettings): boolean {
  return a.nmsIouThreshold === b.nmsIouThreshold
}
