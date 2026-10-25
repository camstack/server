/**
 * Format-default guard — a step's `defaultModelIdByFormat[format]` names a model
 * that SHIPS a build for that format (D657).
 *
 * Reads only this package's catalog, so it runs as this package's test (D548).
 *
 * ## The failure this catches
 *
 * `getDefaultModelForFormat` hands a pool of `format` the declared per-format
 * id whenever nothing loadable exists, so a declaration naming a model with no
 * such build is not documentation: every node resolves it and tries to load
 * it. `face-detection` declared `tflite: 'scrfd-2.5g'`; the catalog has no
 * tflite SCRFD. On 2026-09-27 a Coral-elected session loaded it next to its
 * root detector, the whole load failed, and the root was backed off with it —
 * `runInference failed` on every frame of four cameras.
 *
 * A format with no loadable model for a step has NO entry for it.
 *
 * ## What it checks
 *
 * Every registered step, active and dormant: each `defaultModelIdByFormat`
 * entry names a model in that step's catalog, and that model ships a build for
 * the entry's format.
 */
import type { StepDefinition } from '@camstack/types'
import {
  ALL_PIPELINE_STEPS,
  DORMANT_PIPELINE_STEPS,
} from '../../detection-pipeline/registry/step-definitions.js'

/** A `defaultModelIdByFormat` entry that names a model with no build for its format. */
export interface UnbuildableFormatDefault {
  readonly stepId: string
  readonly format: string
  readonly modelId: string
  /** The model is absent from the step's catalog, or ships no build for the format. */
  readonly problem: 'not-in-catalog' | 'no-build-for-format'
}

/** Every `defaultModelIdByFormat[format]` in `defs` that names a model with no build for `format`. */
export function findUnbuildableFormatDefaults(
  defs: readonly StepDefinition[],
): UnbuildableFormatDefault[] {
  const problems: UnbuildableFormatDefault[] = []
  for (const def of defs) {
    for (const [format, modelId] of Object.entries(def.defaultModelIdByFormat ?? {})) {
      const model = def.models.find((m) => m.id === modelId)
      if (model === undefined) {
        problems.push({ stepId: def.id, format, modelId, problem: 'not-in-catalog' })
      } else if (!Object.entries(model.formats).some(([f, build]) => f === format && build)) {
        problems.push({ stepId: def.id, format, modelId, problem: 'no-build-for-format' })
      }
    }
  }
  return problems
}

/** The guard over the checked-out catalog: every registered step, active and dormant. */
export function evaluateFormatDefaultsGuard(): UnbuildableFormatDefault[] {
  return findUnbuildableFormatDefaults(
    [...ALL_PIPELINE_STEPS, ...DORMANT_PIPELINE_STEPS].map((s) => s.definition),
  )
}
