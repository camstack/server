/**
 * Write one override onto the device's customization composition.
 * Other fields on the same cap stay. A convert that owned the companion
 * `unit` constant drops that constant when the convert goes away.
 */
import {
  type Composition,
  type CompositionFieldSource,
  type CompositionFieldsFeature,
  type CompositionSourceRef,
  unitCompanionField,
} from '@camstack/types'
import { featureOf, withFeature, withoutFeature } from '../customization-save'

export const SELF_VALUE_BINDING = 'v'

export function convertExpression(
  from: string,
  to: string,
  self: CompositionSourceRef,
  cap: string,
  fieldPath: string,
): CompositionFieldSource {
  return {
    kind: 'expression',
    expr: `convert(${SELF_VALUE_BINDING}, ${JSON.stringify(from)}, ${JSON.stringify(to)})`,
    bindings: {
      [SELF_VALUE_BINDING]: { kind: 'from', source: self, cap, fieldPath },
    },
  }
}

export function unitConstant(to: string): CompositionFieldSource {
  return { kind: 'expression', expr: JSON.stringify(to), bindings: {} }
}

export function compositionWithField(
  current: Composition | null,
  target: CompositionSourceRef,
  cap: string,
  fieldPath: string,
  source: CompositionFieldSource,
  dropPaths: readonly string[],
): Composition {
  const feature = featureOf(current, cap)
  const base: CompositionFieldsFeature = feature ?? { kind: 'fields', cap, fields: {} }
  const fields = { ...base.fields, [fieldPath]: source }
  const nextFields = Object.fromEntries(
    Object.entries(fields).filter(([path]) => !dropPaths.includes(path)),
  )
  return withFeature(current, target, { ...base, fields: nextFields })
}

/** Paths to drop when a convert-unit entry is replaced or removed. */
export function convertCompanionDrop(
  feature: CompositionFieldsFeature | null,
  cap: string,
  fieldPath: string,
  to: string,
): readonly string[] {
  const companion = unitCompanionField(cap, fieldPath)
  if (companion === null || feature === null) return []
  const stored = feature.fields[companion]
  if (
    stored?.kind === 'expression' &&
    stored.expr === JSON.stringify(to) &&
    companion !== fieldPath
  ) {
    return [companion]
  }
  return []
}

export function compositionWithoutFields(
  current: Composition,
  target: CompositionSourceRef,
  cap: string,
  paths: readonly string[],
): Composition | null {
  const feature = featureOf(current, cap)
  if (feature === null) return current
  const drop = new Set(paths)
  const fields = Object.fromEntries(
    Object.entries(feature.fields).filter(([path]) => !drop.has(path)),
  )
  if (Object.keys(fields).length === 0) return withoutFeature(current, cap)
  return withFeature(current, target, { ...feature, fields })
}
