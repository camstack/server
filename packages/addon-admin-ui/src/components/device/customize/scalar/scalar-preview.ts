/**
 * Live preview of one scalar draft. A dwell shows the delay a fresh
 * observation would wait — it does not invent runtime memory.
 */
import { type CompositionSourceRef, evaluateExpressionSource } from '@camstack/types'
import { scalarOutputPath } from './scalar-fit'
import {
  scalarFeatureFromForm,
  type ScalarFormSource,
  type ScalarTransformDraft,
} from './scalar-form'
import {
  SCALAR_PREVIEW_FAILURE_COMPILE,
  SCALAR_PREVIEW_FAILURE_DWELL,
  SCALAR_PREVIEW_FAILURE_EMPTY,
  SCALAR_PREVIEW_FAILURE_NO_VALUE,
  type ScalarPreviewFailureReason,
} from './scalar-reason'

export type ScalarPreview =
  | { readonly kind: 'value'; readonly text: string }
  | {
      readonly kind: 'dwell'
      readonly sourceText: string
      readonly active: boolean
      readonly countdownMs: number
    }
  | { readonly kind: 'failed'; readonly reason: ScalarPreviewFailureReason | string }

export function previewScalarOverride(input: {
  readonly cap: string
  readonly targetId: string
  readonly device: CompositionSourceRef
  readonly apply: 'add' | 'replace'
  readonly source: ScalarFormSource
  readonly transform: ScalarTransformDraft
  readonly sourceValue: unknown
  readonly nowMs: number
}): ScalarPreview {
  const feature = scalarFeatureFromForm(input)
  if (feature === null) return { kind: 'failed', reason: SCALAR_PREVIEW_FAILURE_COMPILE }
  if (input.transform.kind === 'threshold') return previewDwell(input.transform, input)
  const path = scalarOutputPath(input.cap, input.targetId)
  const field = path === null ? undefined : feature.fields[path]
  if (field === undefined) return { kind: 'failed', reason: SCALAR_PREVIEW_FAILURE_COMPILE }
  if (field.kind === 'from') return valueText(input.sourceValue)
  if (field.kind !== 'expression') {
    return { kind: 'failed', reason: SCALAR_PREVIEW_FAILURE_COMPILE }
  }
  if (field.expr.startsWith('dwell(')) {
    return { kind: 'failed', reason: SCALAR_PREVIEW_FAILURE_DWELL }
  }
  const bound = bindingValue(input.sourceValue)
  if (bound === undefined) return { kind: 'failed', reason: SCALAR_PREVIEW_FAILURE_NO_VALUE }
  const evaluated = evaluateExpressionSource(field.expr, { x: bound }, input.nowMs)
  if (!evaluated.ok) return { kind: 'failed', reason: evaluated.error }
  return valueText(evaluated.value)
}

function previewDwell(
  transform: Extract<ScalarTransformDraft, { kind: 'threshold' }>,
  input: { readonly source: ScalarFormSource; readonly sourceValue: unknown },
): ScalarPreview {
  if (typeof input.sourceValue !== 'number' || !Number.isFinite(input.sourceValue)) {
    return { kind: 'failed', reason: SCALAR_PREVIEW_FAILURE_NO_VALUE }
  }
  const active =
    transform.comparison === 'gte'
      ? input.sourceValue >= transform.threshold
      : input.sourceValue <= transform.threshold
  const unit = input.source.sourceUnit
  const sourceText = unit === null ? String(input.sourceValue) : `${input.sourceValue} ${unit}`
  return {
    kind: 'dwell',
    sourceText,
    active,
    countdownMs: active ? transform.startDwellMs : transform.stopDwellMs,
  }
}

function bindingValue(value: unknown): number | string | boolean | null | undefined {
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean')
    return value
  if (value === null) return null
  return undefined
}

function valueText(value: unknown): ScalarPreview {
  if (value === null || value === undefined) {
    return { kind: 'failed', reason: SCALAR_PREVIEW_FAILURE_EMPTY }
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return { kind: 'failed', reason: SCALAR_PREVIEW_FAILURE_EMPTY }
  }
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return { kind: 'value', text: String(value) }
  }
  return { kind: 'failed', reason: SCALAR_PREVIEW_FAILURE_EMPTY }
}
