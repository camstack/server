/**
 * Named defaults for a scalar override form, and the feature the existing
 * save path stores. The compiler output is the stored composition.
 */
import {
  type CompositionFieldsFeature,
  type CompositionSourceRef,
  type ScalarCompileInput,
  compileScalarOverride,
  RUNNING_POWER_START_DELAY_MS,
  RUNNING_POWER_STOP_DELAY_MS,
  RUNNING_POWER_THRESHOLD_WATTS,
} from '@camstack/types'
import type { ScalarFieldFit, ScalarTransformKind } from './scalar-fit'
export type ScalarTransformDraft = ScalarCompileInput['draft']['transform']

export interface ScalarFormSource {
  readonly addonId: string
  readonly stableId: string
  readonly cap: string
  readonly fieldPath: string
  readonly valueKind: 'boolean' | 'number' | 'string'
  readonly sourceUnit: string | null
  readonly changedAtField: string | null
}

export type ScalarControl = 'none' | 'invert' | 'threshold' | 'choice'

export function scalarControl(transforms: readonly ScalarTransformKind[]): ScalarControl {
  if (transforms.length === 1 && transforms[0] === 'threshold') return 'threshold'
  if (transforms.length === 1 && transforms[0] === 'invert') return 'invert'
  if (
    transforms.includes('invert') &&
    transforms.every((kind) => kind === 'identity' || kind === 'invert')
  ) {
    return 'invert'
  }
  if (transforms.length > 1) return 'choice'
  return 'none'
}

export function defaultScalarTransform(fit: ScalarFieldFit): ScalarTransformDraft {
  if (fit.transforms.includes('identity')) return { kind: 'identity' }
  if (fit.transforms.includes('threshold')) return defaultThreshold(fit.sourceUnit)
  if (fit.transforms.includes('linear')) return { kind: 'linear', scale: 1, offset: 0 }
  return { kind: 'invert' }
}

export function defaultThreshold(unit: string | null): ScalarTransformDraft {
  const watts = unit === 'W'
  return {
    kind: 'threshold',
    comparison: 'gte',
    threshold: watts ? RUNNING_POWER_THRESHOLD_WATTS : 0,
    startDwellMs: watts ? RUNNING_POWER_START_DELAY_MS : 0,
    stopDwellMs: watts ? RUNNING_POWER_STOP_DELAY_MS : 0,
  }
}

export function scalarFeatureFromForm(input: {
  readonly cap: string
  readonly targetId: string
  readonly device: CompositionSourceRef
  readonly apply: 'add' | 'replace'
  readonly source: ScalarFormSource
  readonly transform: ScalarTransformDraft
}): CompositionFieldsFeature | null {
  const compiled = compileScalarOverride({
    draft: {
      kind: 'scalar',
      cap: input.cap,
      targetId: input.targetId,
      source: {
        addonId: input.source.addonId,
        stableId: input.source.stableId,
        cap: input.source.cap,
        fieldPath: input.source.fieldPath,
      },
      transform: input.transform,
    },
    device: input.device,
    apply: input.apply,
    sourceValueKind: input.source.valueKind,
    changedAtField: input.source.changedAtField,
    sourceUnit: input.source.sourceUnit,
  })
  return compiled.ok ? compiled.value : null
}
