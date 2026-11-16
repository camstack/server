/**
 * The overview's growth numbers. Both are `null` whenever the inputs cannot
 * support them (D393): a measurement that failed is unknown, never 0, and a
 * history shorter than a day says nothing about a daily rate.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** Bytes per day the archive has been growing at, from its total and oldest footage. */
export function growthPerDay(input: {
  readonly footageBytes: number | null
  readonly oldestMs: number | null
  readonly nowMs: number
}): number | null {
  if (input.footageBytes === null || input.oldestMs === null) return null
  const spanMs = input.nowMs - input.oldestMs
  if (spanMs < DAY_MS) return null
  return input.footageBytes / (spanMs / DAY_MS)
}

/** How many days the free space lasts at `perDay` growth; `null` when either is unknown or growth is nil. */
export function daysUntilFull(freeBytes: number | null, perDay: number | null): number | null {
  if (freeBytes === null || perDay === null || perDay <= 0) return null
  return freeBytes / perDay
}

/** The oldest footage across cameras; `null` when no camera reports one. */
export function oldestFootage(
  rows: readonly { readonly oldestMs: number | null }[],
): number | null {
  let oldest: number | null = null
  for (const row of rows) {
    if (row.oldestMs !== null && (oldest === null || row.oldestMs < oldest)) oldest = row.oldestMs
  }
  return oldest
}
