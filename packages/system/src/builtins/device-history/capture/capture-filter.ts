/**
 * The per-point capture decision for a cap field (D850, plan §5.3). PURE.
 *
 * A point is written only when the value CHANGED from the last one recorded,
 * by more than the field's deadband, and no sooner than its capture floor:
 *
 *  - `unchanged`  — the same value again; a change-only series stores nothing;
 *  - `deadband`   — a change smaller than `deadband` (absolute) or
 *                   `deadbandPct` (relative to the last recorded value); a slow
 *                   drift is still caught, because the comparison is against
 *                   the last RECORDED value, not the last seen one;
 *  - `defer`      — changed, but inside `minIntervalMs` of the last recorded
 *                   point. NOT dropped: the caller keeps it pending and emits it
 *                   once the floor has passed, so a burst never loses its end.
 */
import { type CapabilityHistoryField, HISTORY_DEFAULT_MIN_INTERVAL_MS } from '@camstack/types'

export interface RecordedState {
  readonly value: number
  readonly ts: number
}

export type CaptureSkipReason = 'unchanged' | 'deadband' | 'non-finite'

export type CaptureDecision =
  | { readonly action: 'emit' }
  | { readonly action: 'skip'; readonly reason: CaptureSkipReason }
  | { readonly action: 'defer'; readonly notBefore: number }

/** Tolerance for floating-point steps such as 21.3 - 21.2 against a 0.1 deadband. */
const DEADBAND_EPSILON = 1e-9

/** The capture floor of a field: its own `minIntervalMs`, else the kind's default. */
export function minIntervalOf(spec: CapabilityHistoryField): number {
  if (spec.minIntervalMs !== undefined) return spec.minIntervalMs
  return spec.kind === 'boolean' || spec.kind === 'enum' ? 0 : HISTORY_DEFAULT_MIN_INTERVAL_MS
}

function clearsDeadband(spec: CapabilityHistoryField, last: number, value: number): boolean {
  if (spec.kind === 'boolean' || spec.kind === 'enum') return true
  const delta = Math.abs(value - last)
  if (spec.deadband !== undefined && delta < spec.deadband - DEADBAND_EPSILON) return false
  if (spec.deadbandPct !== undefined) {
    const threshold = (Math.abs(last) * spec.deadbandPct) / 100
    if (delta < threshold - DEADBAND_EPSILON) return false
  }
  return true
}

export interface DecideOptions {
  /** Reconcile restores a missed value, so the floor does not apply to it. */
  readonly ignoreFloor?: boolean
}

export function decideCapture(
  spec: CapabilityHistoryField,
  recorded: RecordedState | null,
  value: number,
  now: number,
  options: DecideOptions = {},
): CaptureDecision {
  if (!Number.isFinite(value)) return { action: 'skip', reason: 'non-finite' }
  if (recorded === null) return { action: 'emit' }
  if (value === recorded.value) return { action: 'skip', reason: 'unchanged' }
  if (!clearsDeadband(spec, recorded.value, value)) return { action: 'skip', reason: 'deadband' }
  if (options.ignoreFloor !== true) {
    const notBefore = recorded.ts + minIntervalOf(spec)
    if (now < notBefore) return { action: 'defer', notBefore }
  }
  return { action: 'emit' }
}
