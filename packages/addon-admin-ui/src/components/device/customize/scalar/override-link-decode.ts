/**
 * A boolean scalar row that stores ONE source link (a power source: "powered
 * by that switch") IS a link, whatever else an earlier writer stored beside it
 * (a companion, a stamp, another spelling of the text). The strict decoder only
 * recognises what compiling the draft again reproduces to the letter, so such a
 * row used to fall through to the FORMULA editor, a different dialog from the
 * one the row's Add opened. This reads the one bound source, so Edit opens the
 * same link dialog; saving there compiles the canonical text back.
 *
 * Two stored shapes are links: the field is a plain `from`, or (a replace-rule
 * target) an expression whose only source is bound to `x`.
 */
import type {
  CompositionFieldsFeature,
  CustomizeCatalogTarget,
  ScalarDecoded,
} from '@camstack/types'

export function decodeLooseSourceLink(
  feature: CompositionFieldsFeature,
  cap: string,
  target: CustomizeCatalogTarget,
): ScalarDecoded | null {
  if (target.path === undefined || target.valueKind !== 'boolean') return null
  if (feature.cap !== cap) return null
  const field = feature.fields[target.path]
  if (field === undefined) return null
  const bound =
    field.kind === 'from'
      ? field
      : field.kind === 'expression' && target.override !== undefined
        ? field.bindings['x']
        : undefined
  if (bound?.kind !== 'from') return null
  return {
    draft: {
      kind: 'scalar',
      cap,
      targetId: target.id,
      source: {
        addonId: bound.source.addonId,
        stableId: bound.source.stableId,
        cap: bound.cap,
        fieldPath: bound.fieldPath,
      },
      transform: { kind: 'identity' },
    },
    apply: target.override !== undefined ? 'replace' : target.apply,
    sourceValueKind: 'boolean',
    changedAtField: null,
    sourceUnit: null,
  }
}
