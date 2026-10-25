/**
 * Normalise a topology `lastSeen` value into a millisecond epoch suitable for
 * `formatLastSeen` (from `@camstack/ui-library`).
 *
 * `TopologyNodeSchema.lastSeen` is an ISO string, but the shared `NodeData`
 * shape widens it to `string | number` (some legacy payloads send epoch ms).
 * This normaliser accepts either and returns `null` for missing/unparseable
 * inputs so callers can render nothing rather than "NaN ago".
 */
export function lastSeenToMs(lastSeen: string | number | undefined | null): number | null {
  if (lastSeen === undefined || lastSeen === null) return null
  if (typeof lastSeen === 'number') {
    return lastSeen > 0 ? lastSeen : null
  }
  const parsed = Date.parse(lastSeen)
  return Number.isNaN(parsed) ? null : parsed
}
