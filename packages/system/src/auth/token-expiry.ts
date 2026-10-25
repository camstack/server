/**
 * Validation for the operator-configured session-JWT lifetime
 * (`auth.tokenExpiry`, System → Settings → Authentication → Token Expiry).
 *
 * WHY THIS EXISTS. The field is a free-text box that reaches `jwt.sign`'s
 * `expiresIn`. Two things go wrong without a gate in front of it:
 *
 *   1. `jsonwebtoken` THROWS on a value it cannot parse. The only caller is
 *      the login/refresh path, so one typo in a settings form turns every
 *      login into a 500 — a self-inflicted outage from a text field.
 *   2. `jsonwebtoken` hands a bare numeric STRING to `ms()`, which reads it
 *      as MILLISECONDS. An operator who types `3600` meaning "an hour" gets
 *      a token that dies in 3.6 seconds. A bare number is therefore rejected
 *      rather than interpreted — the field's own description, placeholder and
 *      default are all duration strings (`24h`, `7d`, `30d`).
 *
 * A rejection never becomes an unbounded lifetime — it resolves to
 * {@link DEFAULT_TOKEN_EXPIRY}, the single documented default — and it is
 * never silent: `parseTokenExpiry` reports the refusal in its result and
 * `logTokenExpiryRejection` renders it. The two are separate so the caller
 * owns how often it speaks; the signer re-reads on every mint.
 */
import { DEFAULT_TOKEN_EXPIRY } from '@camstack/types'
import type { IScopedLogger } from '@camstack/types'

/**
 * The `ms`-compatible duration grammar `jsonwebtoken` accepts, MINUS the bare
 * number (see the docblock above). A unit is mandatory.
 */
const DURATION_PATTERN =
  /^(\d+(?:\.\d+)?)\s*(ms|milliseconds?|msecs?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|y|yrs?|years?)$/i

/** Multiplier from each accepted unit to milliseconds. */
const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  msec: 1,
  msecs: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
  y: 31_557_600_000,
  yr: 31_557_600_000,
  yrs: 31_557_600_000,
  year: 31_557_600_000,
  years: 31_557_600_000,
}

/**
 * Shortest accepted lifetime. Below a minute the token expires inside the
 * round trip that issued it and the operator sees "logged out immediately",
 * which reads as a broken server rather than as a bad setting.
 */
const MIN_EXPIRY_MS = 60_000

/**
 * Longest accepted lifetime. A year is already far past "a device left
 * unopened for weeks"; anything longer is an infinite-lifetime token wearing
 * a duration string.
 */
const MAX_EXPIRY_MS = 365 * 86_400_000

/** Why a candidate value was refused. Feeds the log line, not the UI. */
export type TokenExpiryRejection = 'not-a-string' | 'malformed' | 'too-short' | 'too-long'

interface TokenExpiryOutcome {
  /**
   * Lifetime to hand `jwt.sign`, in SECONDS.
   *
   * Deliberately a number rather than the duration string: `expiresIn` accepts
   * both, but the string branch re-parses through `ms` — which is the branch
   * that reads a bare number as milliseconds. Resolving to seconds here means
   * exactly one parser decides what the operator's text meant, and it is this
   * one.
   */
  readonly seconds: number
  /** The duration string actually applied — for the log line and the UI story. */
  readonly value: string
}

export interface TokenExpiryRejected extends TokenExpiryOutcome {
  readonly ok: false
  readonly reason: TokenExpiryRejection
}

export interface TokenExpiryAccepted extends TokenExpiryOutcome {
  readonly ok: true
  readonly reason?: undefined
}

export type TokenExpiryResult = TokenExpiryAccepted | TokenExpiryRejected

/** Milliseconds for a duration string, or `null` when it is not one. */
function durationMs(candidate: string): number | null {
  const match = DURATION_PATTERN.exec(candidate)
  if (match === null) return null
  const amount = Number(match[1])
  const unitMs = UNIT_MS[match[2]!.toLowerCase()]
  if (!Number.isFinite(amount) || unitMs === undefined) return null
  return amount * unitMs
}

/**
 * The default, pre-parsed. Computed from {@link DEFAULT_TOKEN_EXPIRY} rather
 * than written out again — a second spelling of the same default is the defect
 * this module exists to close.
 */
const DEFAULT_SECONDS = (() => {
  const ms = durationMs(DEFAULT_TOKEN_EXPIRY)
  /* c8 ignore next -- unreachable unless DEFAULT_TOKEN_EXPIRY stops being a duration */
  if (ms === null)
    throw new Error(`DEFAULT_TOKEN_EXPIRY is not a duration: ${DEFAULT_TOKEN_EXPIRY}`)
  return ms / 1000
})()

function refuse(reason: TokenExpiryRejection): TokenExpiryRejected {
  // A rejection never widens a lifetime and never becomes `undefined`: it is
  // always exactly the documented default.
  return { ok: false, reason, seconds: DEFAULT_SECONDS, value: DEFAULT_TOKEN_EXPIRY }
}

/**
 * Parse a configured `auth.tokenExpiry`. An absent/blank value is not a
 * rejection — it is "operator never set it" and resolves to the default
 * without a log line.
 */
export function parseTokenExpiry(configured: unknown): TokenExpiryResult {
  if (configured === undefined || configured === null) {
    return { ok: true, seconds: DEFAULT_SECONDS, value: DEFAULT_TOKEN_EXPIRY }
  }
  if (typeof configured !== 'string') return refuse('not-a-string')

  const trimmed = configured.trim()
  if (trimmed === '') return { ok: true, seconds: DEFAULT_SECONDS, value: DEFAULT_TOKEN_EXPIRY }

  const totalMs = durationMs(trimmed)
  if (totalMs === null) return refuse('malformed')
  if (totalMs < MIN_EXPIRY_MS) return refuse('too-short')
  if (totalMs > MAX_EXPIRY_MS) return refuse('too-long')
  return { ok: true, seconds: totalMs / 1000, value: trimmed }
}

/** Human-readable tail for the rejection log line. */
const REJECTION_DETAIL: Readonly<Record<TokenExpiryRejection, string>> = {
  'not-a-string': 'value is not a string',
  malformed: 'not a duration string (expected e.g. 24h, 7d, 30d — a bare number is NOT seconds)',
  'too-short': `shorter than the ${MIN_EXPIRY_MS / 1000}s minimum`,
  'too-long': `longer than the ${MAX_EXPIRY_MS / 86_400_000}d maximum`,
}

/**
 * Report a refused `auth.tokenExpiry`. Separate from {@link parseTokenExpiry}
 * so the caller owns HOW OFTEN it speaks — the signer re-reads the setting on
 * every mint and must not turn one bad save into a line per login.
 */
export function logTokenExpiryRejection(
  configured: unknown,
  rejection: TokenExpiryRejected,
  logger: IScopedLogger,
): void {
  logger.warn(
    `auth.tokenExpiry REJECTED — ${REJECTION_DETAIL[rejection.reason]}; signing with the default ${DEFAULT_TOKEN_EXPIRY} instead`,
    { meta: { configured, reason: rejection.reason, applied: rejection.value } },
  )
}

export { DEFAULT_TOKEN_EXPIRY }
