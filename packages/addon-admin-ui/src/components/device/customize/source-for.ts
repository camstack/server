/**
 * A field read the source picker can place on a composition: a same-kind
 * `from`, or `number(x)` when a string is the only bridge into a number.
 */
import type {
  CompositionFieldKind,
  CompositionFieldSource,
  CompositionSourceRef,
} from '@camstack/types'

export interface PresetSourceField {
  readonly source: CompositionSourceRef
  readonly cap: string
  readonly fieldPath: string
  /** The source field's kind as `getWireableFields` reports it. */
  readonly kind: CompositionFieldKind
}

/** `from` when the kinds match; `number(x)` for a string into a number (D663); null when incompatible. */
export function sourceFor(
  targetKind: CompositionFieldKind,
  field: PresetSourceField,
): CompositionFieldSource | null {
  const allowed = targetKind === 'enum' ? 'string' : targetKind
  const given = field.kind === 'enum' ? 'string' : field.kind
  const read = { source: field.source, cap: field.cap, fieldPath: field.fieldPath }
  if (given === allowed) return { kind: 'from', ...read }
  if (allowed === 'number' && given === 'string') {
    return { kind: 'expression', expr: 'number(x)', bindings: { x: { kind: 'from', ...read } } }
  }
  return null
}
