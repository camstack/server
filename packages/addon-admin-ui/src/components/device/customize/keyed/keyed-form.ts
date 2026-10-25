/**
 * The feature one keyed-array item form stores. The compiler output is the
 * composition; this module only names the form's defaults.
 */
import {
  type CompositionFieldsFeature,
  type CompositionSourceRef,
  type KeyedArrayItemCompile,
  type KeyedArrayLiteral,
  type KeyedSourceValueKind,
  compileKeyedArrayOverride,
} from '@camstack/types'
import type { ScalarTransformDraft } from '../scalar/scalar-form'
import { defaultScalarTransform } from '../scalar/scalar-form'
import { keyedEnumOutputs, keyedTargetFields, type KeyedFit } from './keyed-fit'

export interface KeyedFormSource {
  readonly addonId: string
  readonly stableId: string
  readonly cap: string
  readonly fieldPath: string
  readonly valueKind: KeyedSourceValueKind
}

export function defaultKeyedTransform(fit: KeyedFit): ScalarTransformDraft {
  if (!fit.ok || fit.mode === 'enum') return { kind: 'identity' }
  return defaultScalarTransform(fit.fit)
}

export function defaultEnumMapping(
  sourceValues: readonly string[],
  outputs: readonly string[],
): Readonly<Record<string, string | null>> {
  return Object.fromEntries(
    sourceValues.map((value) => [value, outputs.includes(value) ? value : null]),
  )
}

export function keyedItemFromForm(input: {
  readonly cap: string
  readonly targetId: string
  readonly device: CompositionSourceRef
  readonly apply: 'add' | 'replace'
  readonly key: string
  readonly label: string
  readonly fieldPath: string
  readonly source: KeyedFormSource
  readonly transform: ScalarTransformDraft
  readonly literals: readonly KeyedArrayLiteral[]
}): CompositionFieldsFeature | null {
  const item: KeyedArrayItemCompile = {
    draft: {
      kind: 'keyedArray',
      cap: input.cap,
      targetId: input.targetId,
      key: input.key,
      label: input.label.trim(),
      fieldPath: input.fieldPath,
      source: {
        addonId: input.source.addonId,
        stableId: input.source.stableId,
        cap: input.source.cap,
        fieldPath: input.source.fieldPath,
      },
      transform: input.transform,
    },
    sourceValueKind: input.source.valueKind,
    sourceUnit: null,
    literals: input.literals,
  }
  const compiled = compileKeyedArrayOverride({
    cap: input.cap,
    targetId: input.targetId,
    device: input.device,
    apply: input.apply,
    items: [item],
  })
  return compiled.ok ? compiled.value : null
}

export function requiredLiteralPaths(
  cap: string,
  targetId: string,
  fieldPath: string,
): readonly string[] {
  const field = keyedTargetFields(cap, targetId).find((entry) => entry.path === fieldPath)
  return (field?.literals ?? []).map((literal) => literal.path)
}

export function literalChoices(
  cap: string,
  targetId: string,
  fieldPath: string,
  literalPath: string,
): readonly string[] {
  const field = keyedTargetFields(cap, targetId).find((entry) => entry.path === fieldPath)
  return field?.literals?.find((literal) => literal.path === literalPath)?.values ?? []
}

export function statusOutputs(cap: string, targetId: string, fieldPath: string): readonly string[] {
  return keyedEnumOutputs(cap, targetId, fieldPath)
}
