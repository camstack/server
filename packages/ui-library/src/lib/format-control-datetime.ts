/**
 * Format an HA-native datetime control value in the user's locale.
 *
 * The `control` cap keeps the value verbatim in one of three HA-native shapes:
 *   - date     → 'YYYY-MM-DD'
 *   - time     → 'HH:MM' or 'HH:MM:SS'
 *   - datetime → full ISO timestamp ('YYYY-MM-DDTHH:MM[:SS]' or space-separated)
 *
 * This helper renders that value for the READ-ONLY (at-a-glance) context:
 *   - 'date'     → locale date    (e.g. en-US '6/7/2026')
 *   - 'time'     → locale time    (e.g. en-US '07:30 AM')
 *   - 'datetime' → locale date+time (medium date + short time)
 *
 * It NEVER throws: any value it cannot parse is returned unchanged (graceful
 * fallback). `locale` is optional and defaults to the runtime/browser locale.
 */

export type ControlDateTimeFormat = 'date' | 'time' | 'datetime'

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/

/** Format a date-only ('YYYY-MM-DD', or the date prefix of a timestamp) value.
 *  Constructed as a LOCAL date (via Y/M/D parts) to avoid the UTC-midnight day
 *  shift `new Date('YYYY-MM-DD')` produces in negative-offset timezones. */
function formatDate(value: string, locale: string | undefined): string {
  const match = DATE_RE.exec(value)
  if (match === null) return value
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  if (Number.isNaN(date.getTime())) return value
  try {
    // `toLocaleDateString` throws RangeError on a syntactically invalid BCP-47
    // tag — fall back to the raw value so the helper's "never throws" contract holds.
    return date.toLocaleDateString(locale)
  } catch {
    return value
  }
}

/** Format a time-only ('HH:MM' or 'HH:MM:SS') value on a fixed reference day. */
function formatTime(value: string, locale: string | undefined): string {
  const match = TIME_RE.exec(value)
  if (match === null) return value
  const date = new Date(
    1970,
    0,
    1,
    Number(match[1]),
    Number(match[2]),
    match[3] !== undefined ? Number(match[3]) : 0,
  )
  if (Number.isNaN(date.getTime())) return value
  try {
    // `toLocaleTimeString` throws RangeError on a syntactically invalid BCP-47
    // tag — fall back to the raw value so the helper's "never throws" contract holds.
    return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  } catch {
    return value
  }
}

/** Format a full datetime value. Accepts both 'T'- and space-separated forms. */
function formatDateTime(value: string, locale: string | undefined): string {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T')
  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) return value
  try {
    // TZ trade-off: a TZ-suffixed input (e.g. '2026-06-07T01:00:00+00:00', as HA
    // may emit) is rendered as the equivalent instant in the VIEWER's local
    // timezone via `toLocaleString` — this can differ from the wall-clock HA's
    // own UI shows (HA-server timezone). This is intentional and accepted.
    // `toLocaleString` also throws RangeError on a syntactically invalid BCP-47
    // tag — fall back to the raw value so the helper's "never throws" contract holds.
    return date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return value
  }
}

export function formatControlDateTime(
  value: string,
  format: ControlDateTimeFormat,
  locale?: string,
): string {
  if (value === '') return value
  if (format === 'date') return formatDate(value, locale)
  if (format === 'time') return formatTime(value, locale)
  return formatDateTime(value, locale)
}
