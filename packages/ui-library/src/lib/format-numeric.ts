/**
 * Format a numeric sensor / control value with optional display precision.
 *
 * When `precision` is provided, delegates to `value.toFixed(precision)` which
 * matches the HA `suggested_display_precision` contract.
 * When absent, falls back to auto-formatting: integers render without a
 * decimal point; non-integers use one decimal place.
 */
export function formatNumeric(value: number, precision: number | undefined): string {
  if (precision !== undefined) return value.toFixed(precision)
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}
