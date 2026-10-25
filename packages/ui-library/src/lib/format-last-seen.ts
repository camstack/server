/**
 * Relative "last seen" formatter for the offline affordance.
 *
 * Renders a short relative-time label from a millisecond epoch:
 * "just now", "5m ago", "3h ago", "2d ago". Returns `null` for missing
 * inputs, or inputs below {@link MIN_PLAUSIBLE_TIMESTAMP_MS} (a
 * placeholder or a seeded "known value, unknown change time" stamp), so
 * callers can render nothing rather than a misleading "—", "NaN ago", or
 * (for a seeded `1`) "20000 days ago".
 *
 * Future timestamps (clock skew between the device and the browser)
 * collapse to "just now" instead of a negative duration.
 */
import { defaultUiText, type UiTextFn } from '../contexts/ui-text'

const SECOND_MS = 1_000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const JUST_NOW_MS = 30 * SECOND_MS

/**
 * The earliest timestamp a real "last seen" could plausibly carry. Below
 * this, a value is a placeholder or a seeded "known value, unknown change
 * time" stamp (e.g. Homematic's `HM_SEEDED_CHANGED_AT = 1`) — never a real
 * instant. Year 2000 predates every device this renders.
 */
export const MIN_PLAUSIBLE_TIMESTAMP_MS: number = Date.UTC(2000, 0, 1)

export function formatLastSeen(
  timestampMs: number | null | undefined,
  t: UiTextFn = defaultUiText,
): string | null {
  if (
    timestampMs === null ||
    timestampMs === undefined ||
    timestampMs < MIN_PLAUSIBLE_TIMESTAMP_MS
  ) {
    return null
  }
  const delta = Date.now() - timestampMs
  if (delta < JUST_NOW_MS) return t('uiLibrary.lastSeen.justNow', 'just now')
  if (delta < HOUR_MS)
    return t('uiLibrary.lastSeen.minutes', '{{count}}m ago', {
      count: Math.floor(delta / MINUTE_MS),
    })
  if (delta < DAY_MS)
    return t('uiLibrary.lastSeen.hours', '{{count}}h ago', { count: Math.floor(delta / HOUR_MS) })
  return t('uiLibrary.lastSeen.days', '{{count}}d ago', { count: Math.floor(delta / DAY_MS) })
}
