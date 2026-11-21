/**
 * THE number formatter of the UI. One rule for every reading and measurement:
 * the precision the operator configured wins; with none, at most two decimals
 * with trailing zeros trimmed (21.5 stays 21.5, 21.47 stays 21.47, 1.2 stays 1.2).
 *
 * When `precision` is provided it is `value.toFixed(precision)` (the HA
 * `suggested_display_precision` contract), zeros kept: the operator asked for them.
 */
const DEFAULT_MAX_DECIMALS = 2

export function formatNumeric(value: number, precision: number | undefined): string {
  if (!Number.isFinite(value)) return '—'
  if (precision !== undefined) return value.toFixed(precision)
  if (Number.isInteger(value)) return String(value)
  const rounded = value.toFixed(DEFAULT_MAX_DECIMALS).replace(/\.?0+$/, '')
  // A tiny non-zero value that rounds to nothing reads as below the last decimal.
  if (rounded === '0' || rounded === '-0') return value < 0 ? '-<0.01' : '<0.01'
  return rounded
}
