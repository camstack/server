/**
 * The live preview of one field (spec §3, D676 ruling 10): the composer's OWN
 * `evaluateCompositionField` over the sources' live slices, so the editor and
 * the runtime cannot disagree. A formula with memory (`rose`, `count`) is
 * evaluated only by the composer, which holds that memory; a source that has
 * not answered makes the preview wait rather than compute over a hole.
 */
import {
  type CompositionFieldSource,
  compositionReadKey,
  compositionSliceKey,
  evaluateCompositionField,
  expressionContainsBuiltinCall,
  type ExpressionValue,
  fieldReads,
  type SourceReading,
  toExpressionValue,
} from '@camstack/types'
import { readPath } from '../device/customize/source-picker-model'
import i18n from '../../i18n/index'

export type SliceReading =
  | { readonly kind: 'pending' }
  | { readonly kind: 'value'; readonly slice: unknown }

export type FieldPreview =
  | { readonly kind: 'value'; readonly value: ExpressionValue; readonly stale: string | null }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'waiting'; readonly missing: readonly string[] }
  | { readonly kind: 'runtime-only' }

export function previewField(
  source: CompositionFieldSource,
  slices: ReadonlyMap<string, SliceReading>,
  now: number,
): FieldPreview {
  if (source.kind === 'code')
    return { kind: 'unavailable', reason: i18n.t('helpers.fieldPreview.codeFields') }
  if (source.kind === 'series') return { kind: 'runtime-only' }
  if (
    source.kind === 'expression' &&
    (expressionContainsBuiltinCall(source.expr, 'rose') ||
      expressionContainsBuiltinCall(source.expr, 'count'))
  ) {
    return { kind: 'runtime-only' }
  }
  const reads = fieldReads(source)
  const missing = reads
    .filter((r) => slices.get(compositionSliceKey(r.source, r.cap))?.kind !== 'value')
    .map(compositionReadKey)
  if (missing.length > 0) return { kind: 'waiting', missing }
  const outcome = evaluateCompositionField({
    source,
    now,
    read: (r): SourceReading => {
      const reading = slices.get(compositionSliceKey(r.source, r.cap))
      const raw = reading?.kind === 'value' ? readPath(reading.slice, r.fieldPath) : undefined
      const value = raw === undefined ? undefined : toExpressionValue(raw)
      return value === undefined
        ? {
            state: 'unavailable',
            reason: i18n.t('helpers.fieldPreview.notReported', { path: `${r.cap}.${r.fieldPath}` }),
            fatal: false,
          }
        : { state: 'fresh', value }
    },
  })
  return outcome.state === 'unavailable'
    ? { kind: 'unavailable', reason: outcome.reason }
    : { kind: 'value', value: outcome.value, stale: outcome.reason }
}
