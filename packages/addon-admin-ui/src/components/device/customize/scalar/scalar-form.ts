/**
 * Named defaults for a scalar override form, read from the catalog
 * declaration (D944). The compiler output is the stored composition.
 */
import {
  type CompositionFieldsFeature,
  type CompositionSourceRef,
  type CustomizeCatalogTransform,
  DeviceType,
  type ScalarCompileInput,
  compileScalarOverride,
  tryConvertUnit,
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

export type ScalarControl = 'none' | 'invert' | 'threshold' | 'choice' | 'linear'

export function scalarControl(transforms: readonly ScalarTransformKind[]): ScalarControl {
  if (transforms.length === 1 && transforms[0] === 'linear') return 'linear'
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

/**
 * The linear draft for a source in another unit. The same dimension gets the computed factor
 * (and offset); another dimension has no known factor, so the scale starts UNSET (NaN, which
 * does not compile) and the operator must enter it.
 */
function conversionDraft(
  fit: ScalarFieldFit,
  conversion: { readonly from: string; readonly to: string },
): ScalarTransformDraft {
  const declared = declaredOf(fit.declared, 'linear')
  const base = declared === null ? null : draftFromDeclared(declared)
  const clamp =
    base !== null && base.kind === 'linear' && base.clampMin !== undefined
      ? { clampMin: base.clampMin, clampMax: base.clampMax }
      : {}
  const at0 = tryConvertUnit(0, conversion.from, conversion.to)
  const at1 = tryConvertUnit(1, conversion.from, conversion.to)
  if (at0 === undefined || at1 === undefined) {
    return { kind: 'linear', scale: Number.NaN, offset: 0, ...clamp }
  }
  return { kind: 'linear', scale: at1 - at0, offset: at0, ...clamp }
}

/** A picker row carries its type as a plain string; this narrows it to the enum without a cast. */
export function deviceTypeOf(type: string | undefined): DeviceType | undefined {
  return Object.values(DeviceType).find((known) => known === type)
}

export function defaultScalarTransform(
  fit: ScalarFieldFit,
  deviceType?: DeviceType,
): ScalarTransformDraft {
  if (fit.conversion !== undefined && fit.transforms.includes('linear')) {
    return conversionDraft(fit, fit.conversion)
  }
  if (fit.transforms.includes('identity')) return { kind: 'identity' }
  if (fit.transforms.includes('threshold')) {
    const declared = declaredOf(fit.declared, 'threshold')
    if (declared !== null) return draftFromDeclared(declared, deviceType)
  }
  if (fit.transforms.includes('linear')) {
    const declared = declaredOf(fit.declared, 'linear')
    if (declared !== null) return draftFromDeclared(declared)
  }
  return { kind: 'invert' }
}

export function draftFromDeclared(
  transform: CustomizeCatalogTransform,
  deviceType?: DeviceType,
): ScalarTransformDraft {
  switch (transform.kind) {
    case 'identity':
      return { kind: 'identity' }
    case 'invert':
      return { kind: 'invert' }
    case 'threshold': {
      const own = deviceType === undefined ? undefined : transform.deviceTypeDefaults?.[deviceType]
      return {
        kind: 'threshold',
        comparison: transform.comparison,
        threshold: transform.defaultThreshold,
        startDwellMs: own?.startDwellMs ?? transform.defaultStartDwellMs,
        stopDwellMs: own?.stopDwellMs ?? transform.defaultStopDwellMs,
        ...(own === undefined ? {} : { minSamples: own.minSamples }),
      }
    }
    case 'linear':
      return linearDraft(transform)
    case 'enum-map':
      return { kind: 'identity' }
  }
}

export function declaredOf(
  declared: readonly CustomizeCatalogTransform[],
  kind: CustomizeCatalogTransform['kind'],
): CustomizeCatalogTransform | null {
  return declared.find((row) => row.kind === kind) ?? null
}

function linearDraft(
  transform: Extract<CustomizeCatalogTransform, { kind: 'linear' }>,
): ScalarTransformDraft {
  return {
    kind: 'linear',
    scale: transform.defaultScale,
    offset: transform.defaultOffset,
    ...(transform.clampMin !== undefined && transform.clampMax !== undefined
      ? { clampMin: transform.clampMin, clampMax: transform.clampMax }
      : {}),
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
