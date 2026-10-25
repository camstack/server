/**
 * Leaf formatting for the device State panel — in particular, turning epoch
 * timestamps into readable local dates.
 *
 * ## Why this needs a rule rather than a `typeof`
 *
 * `lastFetchedAt: 1785060000000` is unreadable, and every `runtimeState` slice is
 * required to carry one. But "large number" is not "timestamp": `bitrate`,
 * `memoryRss`, `diskFree` and `retentionDays` are all numbers, and rendering a
 * bitrate as a date in 1970 is worse than leaving it raw.
 *
 * So a value is treated as a time point only when BOTH hold:
 *
 *   1. the KEY names a time point — `…At`, `…AtMs`, `timestamp`, `…Since`,
 *      `lastSeen`, `expires…`; and
 *   2. the NUMBER falls in a plausible epoch range.
 *
 * Requiring both is what keeps `uptimeSeconds` (a duration whose name contains
 * "time"), `timeoutMs` and `batchIntervalMs` (durations ending in "Ms") out of it.
 * Durations are deliberately NOT converted — this formats instants, not spans.
 *
 * ## The raw value is never lost
 *
 * This is a debugging panel, so the exact number still matters. The formatted text
 * is what is shown; `raw` is returned alongside for a `title` tooltip, and search
 * matches against both. Replacing the value outright would trade one kind of
 * unreadability for another.
 */

/**
 * Keys that name an instant. Anchored to the END of the key so `updatedAt` and
 * `lastPushAtMs` match while `timeoutMs`, `batchIntervalMs`, `retentionDays` and
 * `uptimeSeconds` do not.
 */
const TIME_KEY_PATTERNS: readonly RegExp[] = [
  /at$/i, //          lastFetchedAt, updatedAt, createdAt
  /atms$/i, //        lastPushAtMs, lastCheckedAtMs
  /^timestamp$/i, //  timestamp
  /timestamp$/i, //   eventTimestamp
  /since$/i, //       sleepingSince, connectedSince
  /^lastseen$/i, //   lastSeen
  /lastseen$/i, //    deviceLastSeen
  /^expires?$/i, //   expire / expires
  /expiry$/i, //      tokenExpiry
]

/**
 * Plausible epoch windows, roughly 2001 → 2096. Deliberately narrow: it is what
 * separates a timestamp from a byte count that happens to be large, and from `0`
 * (which in this codebase means "never", and must stay `0` rather than becoming
 * 1 January 1970).
 */
const MS_EPOCH_MIN = 1_000_000_000_000
const MS_EPOCH_MAX = 4_000_000_000_000
const SEC_EPOCH_MIN = 1_000_000_000
const SEC_EPOCH_MAX = 4_000_000_000

export function isTimeKey(key: string): boolean {
  return TIME_KEY_PATTERNS.some((pattern) => pattern.test(key))
}

/** Epoch milliseconds for a numeric value under a time-shaped key, else null. */
export function epochMsOf(value: number): number | null {
  if (!Number.isFinite(value)) return null
  if (value >= MS_EPOCH_MIN && value <= MS_EPOCH_MAX) return value
  // Seconds-epoch: JWT `exp`, and some vendor APIs.
  if (value >= SEC_EPOCH_MIN && value <= SEC_EPOCH_MAX) return value * 1000
  return null
}

/**
 * Locale-formatted instant. `undefined` locale means the viewer's own locale,
 * which is the point — an operator in Rome should not read UTC.
 */
export function formatLocalDate(epochMs: number): string {
  const date = new Date(epochMs)
  if (Number.isNaN(date.getTime())) return String(epochMs)
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export interface FormattedLeaf {
  /** What is displayed. */
  readonly text: string
  /**
   * The untouched original, present ONLY when `text` differs from it — so a
   * caller can show a tooltip without one on every unremarkable value.
   */
  readonly raw: string | null
}

function plain(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/**
 * Format one leaf of the state tree, given the key it sits under.
 *
 * Handles two timestamp shapes:
 *   - a NUMBER under a time-shaped key → local date, raw kept
 *   - an ISO-8601 STRING → local date, raw kept. No key check needed: an ISO
 *     string is unambiguous, and a Moleculer round-trip turns every `Date` into
 *     one, so these appear whether or not the key looks temporal.
 */
export function formatLeafValue(key: string, value: unknown): FormattedLeaf {
  if (typeof value === 'number' && isTimeKey(key)) {
    const epochMs = epochMsOf(value)
    if (epochMs !== null) return { text: formatLocalDate(epochMs), raw: String(value) }
  }

  if (typeof value === 'string' && isIsoDateString(value)) {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return { text: formatLocalDate(parsed), raw: value }
  }

  return { text: plain(value), raw: null }
}

/**
 * Strict ISO-8601 with a time part. Requires the `T` and at least
 * `hh:mm` — a bare `2026-07-26` is far more often a version, an id fragment or a
 * label than a date, and `Date.parse` would silently read it as UTC midnight and
 * shift it a day in a negative-offset locale.
 */
export function isIsoDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/.test(value)
}
