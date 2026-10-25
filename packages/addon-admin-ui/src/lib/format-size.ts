/**
 * Pick the right unit for a byte count and render it with a sensible
 * number of significant digits.
 *
 *   42        →  "42 B"
 *   2_456     →  "2.4 KB"
 *   154_000   →  "150 KB"   (≥ 100 KB → no decimal)
 *   3_900_000 →  "3.7 MB"
 *   2_100_000_000 → "2.0 GB"
 *
 * We use binary-prefixed (1 KB = 1024 B) units, matching the rest of
 * the codebase (recording sizes, RSS, archive sizes — all binary).
 *
 * Rendering rule (KB and up): one decimal place under 100, zero above.
 * Bytes never get a decimal.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`

  const units = ['KB', 'MB', 'GB', 'TB', 'PB'] as const
  let value = bytes / 1024
  let unit: (typeof units)[number] = 'KB'
  for (const u of units) {
    unit = u
    if (value < 1024) break
    value /= 1024
  }
  const rendered = value >= 100 ? Math.round(value).toString() : value.toFixed(1)
  return `${rendered} ${unit}`
}

/** MB-input convenience wrapper. */
export function formatSizeMB(mb: number): string {
  return formatBytes(mb * 1024 * 1024)
}
