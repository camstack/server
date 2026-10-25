/**
 * Internal reason codes for scalar fit and preview. UI maps them through
 * `scalarFitReasonI18nKey` / `scalarPreviewFailureI18nKey`.
 */
import type { ScalarFitReason } from './scalar-fit'

export const SCALAR_FIT_REASON_KIND: ScalarFitReason = 'kind'
export const SCALAR_FIT_REASON_UNIT: ScalarFitReason = 'unit'
export const SCALAR_FIT_REASON_UNIT_UNKNOWN: ScalarFitReason = 'unit-unknown'

export function scalarFitReasonI18nKey(reason: ScalarFitReason): string {
  return `customize.scalar.fit.${reason}`
}

export type ScalarPreviewFailureReason = 'compile' | 'dwell' | 'no-value' | 'empty'

export const SCALAR_PREVIEW_FAILURE_COMPILE: ScalarPreviewFailureReason = 'compile'
export const SCALAR_PREVIEW_FAILURE_DWELL: ScalarPreviewFailureReason = 'dwell'
export const SCALAR_PREVIEW_FAILURE_NO_VALUE: ScalarPreviewFailureReason = 'no-value'
export const SCALAR_PREVIEW_FAILURE_EMPTY: ScalarPreviewFailureReason = 'empty'

export function scalarPreviewFailureI18nKey(reason: ScalarPreviewFailureReason): string {
  return `customize.scalar.previewFailure.${reason}`
}

export function isScalarPreviewFailureReason(value: string): value is ScalarPreviewFailureReason {
  return (
    value === SCALAR_PREVIEW_FAILURE_COMPILE ||
    value === SCALAR_PREVIEW_FAILURE_DWELL ||
    value === SCALAR_PREVIEW_FAILURE_NO_VALUE ||
    value === SCALAR_PREVIEW_FAILURE_EMPTY
  )
}
