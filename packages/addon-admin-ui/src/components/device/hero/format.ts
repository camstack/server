/**
 * Hero shared formatters — kept tiny on purpose. Heroes use them to
 * print "5 minutes ago" / "12 today" without each file re-implementing
 * the same string math.
 */

import i18n from '../../../i18n/index'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * The earliest timestamp a real change/detection could plausibly carry.
 * Below this, a value is a placeholder or a seeded "known value, unknown
 * change time" stamp (e.g. Homematic's `HM_SEEDED_CHANGED_AT = 1`) — never
 * a real instant. Year 2000 predates every device this UI renders.
 */
export const MIN_PLAUSIBLE_TIMESTAMP_MS = Date.UTC(2000, 0, 1)

/**
 * Format a millisecond epoch as a short relative time ("just now",
 * "5m ago", "3h ago", "2d ago"). Returns "—" for null/undefined or a
 * timestamp below {@link MIN_PLAUSIBLE_TIMESTAMP_MS} (a placeholder or a
 * seeded "known value, unknown change time" stamp, never a real instant —
 * a bare `<= 0` check let a seeded `1` render as "20000 days ago").
 */
export function formatRelativeTime(timestampMs: number | null | undefined): string {
  if (timestampMs === null || timestampMs === undefined || timestampMs < MIN_PLAUSIBLE_TIMESTAMP_MS)
    return '—'
  const delta = Date.now() - timestampMs
  if (delta < 0) return i18n.t('helpers.relativeTime.justNow') // clock skew safety
  if (delta < 30_000) return i18n.t('helpers.relativeTime.justNow')
  if (delta < HOUR_MS)
    return i18n.t('helpers.relativeTime.minutesAgo', { count: Math.floor(delta / MINUTE_MS) })
  if (delta < DAY_MS)
    return i18n.t('helpers.relativeTime.hoursAgo', { count: Math.floor(delta / HOUR_MS) })
  return i18n.t('helpers.relativeTime.daysAgo', { count: Math.floor(delta / DAY_MS) })
}

/**
 * True when the given epoch timestamp is within the same calendar day
 * as `now`. Used by the doorbell hero to compute "presses today".
 */
export function isSameLocalDay(timestampMs: number, now: Date = new Date()): boolean {
  const d = new Date(timestampMs)
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  )
}
