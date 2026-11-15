/** The smallest share of the row a column may be dragged to, in percent. */
export const MIN_COLUMN_PCT = 10

/** Scale `sizes` so they add up to 100. A list that cannot be scaled falls back to equal shares. */
export function normalizeSplit(sizes: readonly number[]): readonly number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (sizes.length === 0) return []
  if (!(total > 0)) return sizes.map(() => 100 / sizes.length)
  return sizes.map((size) => (size / total) * 100)
}

/**
 * Move the boundary after column `index` by `deltaPct`. Only the two columns
 * around it change, and neither goes under `minPct`.
 */
export function resizeSplit(
  sizes: readonly number[],
  index: number,
  deltaPct: number,
  minPct: number = MIN_COLUMN_PCT,
): readonly number[] {
  const left = sizes[index]
  const right = sizes[index + 1]
  if (left === undefined || right === undefined) return sizes
  const pair = left + right
  const nextLeft = Math.min(Math.max(left + deltaPct, minPct), pair - minPct)
  return sizes.map((size, i) => {
    if (i === index) return nextLeft
    if (i === index + 1) return pair - nextLeft
    return size
  })
}

function storageName(key: string, count: number): string {
  return `camstack.columns.${key}.${String(count)}`
}

function isValidSplit(value: unknown, count: number, minPct: number): value is readonly number[] {
  if (!Array.isArray(value) || value.length !== count) return false
  const sizes: readonly unknown[] = value
  if (!sizes.every((s) => typeof s === 'number' && Number.isFinite(s) && s >= minPct - 0.01)) {
    return false
  }
  const total = sizes.reduce<number>((sum, s) => sum + (typeof s === 'number' ? s : 0), 0)
  return Math.abs(total - 100) < 0.5
}

/** The split this viewer left last time for `key`, or the defaults when there is none or it is unusable. */
export function readStoredSplit(
  key: string,
  defaults: readonly number[],
  minPct: number = MIN_COLUMN_PCT,
): readonly number[] {
  const fallback = normalizeSplit(defaults)
  try {
    const raw = window.localStorage.getItem(storageName(key, defaults.length))
    if (raw === null) return fallback
    const parsed: unknown = JSON.parse(raw)
    return isValidSplit(parsed, defaults.length, minPct) ? parsed : fallback
  } catch {
    return fallback
  }
}

/** Remember the split for this viewer. Storage that is unavailable is skipped: the split just resets. */
export function writeStoredSplit(key: string, sizes: readonly number[]): void {
  try {
    window.localStorage.setItem(storageName(key, sizes.length), JSON.stringify(sizes))
  } catch {
    // Private window or blocked storage: the layout still works, it is not remembered.
  }
}
