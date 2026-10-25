/**
 * Pure fuzzy matcher for adoption location import. Normalized
 * case-insensitive Levenshtein similarity, used to reuse an existing
 * CamStack location when an imported source location (e.g. an HA area) is
 * close enough — otherwise the caller creates a new location.
 */

function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  // Two-row DP. Rows are plain number[] initialised fully so every index
  // is always a number (not undefined), satisfying noUncheckedIndexedAccess.
  const prevRow: number[] = Array.from({ length: n + 1 }, (_, k) => k)
  const currRow: number[] = Array.from({ length: n + 1 }, () => 0)
  for (let i = 1; i <= m; i++) {
    currRow[0] = i
    // diagVal tracks prevRow[j-1] from the previous iteration so we never
    // do a cold index read inside the inner loop.
    let diagVal = prevRow[0] ?? 0
    for (let j = 1; j <= n; j++) {
      const above = prevRow[j] ?? 0
      const left = currRow[j - 1] ?? 0
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      currRow[j] = Math.min(above + 1, left + 1, diagVal + cost)
      diagVal = above
    }
    // Swap rows without allocation: copy currRow into prevRow.
    for (let j = 0; j <= n; j++) prevRow[j] = currRow[j] ?? 0
  }
  return prevRow[n] ?? 0
}

/** Similarity in [0,1]; 1 = identical (after trim + lowercase). */
export function locationSimilarity(a: string, b: string): number {
  const x = a.trim().toLowerCase()
  const y = b.trim().toLowerCase()
  if (x === y) return 1
  if (x.length === 0 || y.length === 0) return 0
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length)
}

/**
 * Returns the existing name with the highest similarity to `externalName`,
 * provided it is at least `threshold`; otherwise `null` (caller should create
 * a new location named `externalName`).
 */
export function bestLocationMatch(
  externalName: string,
  existing: readonly string[],
  threshold = 0.8,
): string | null {
  let best: string | null = null
  let bestScore = 0
  for (const name of existing) {
    const score = locationSimilarity(externalName, name)
    if (score >= threshold && score > bestScore) {
      best = name
      bestScore = score
    }
  }
  return best
}
