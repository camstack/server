/**
 * Where an OAuth round-trip ends: the admin-ui completion route
 * (`/sso-complete`, the page every popup sign-in already lands on), with the
 * OUTCOME in the URL fragment.
 *
 * The outcome is a status plus a reason CODE from a closed list. It never
 * carries a token, a code, a client secret or a free-form error message: the
 * page words each code itself, and an unknown code reads as `unknown` rather
 * than being echoed. Fragment only, so nothing here reaches a server log.
 *
 * Pure and browser-safe.
 */

/** The admin-ui route the hub's OAuth completions land on (relative to its mount). */
export const OAUTH_LANDING_PATH = '/sso-complete'

export const OAUTH_LANDING_REASONS = [
  'access_denied',
  'invalid_state',
  'invalid_request',
  'unknown_broker',
  'not_configured',
  'exchange_failed',
  'no_refresh_token',
  'unavailable',
  'unknown',
] as const

export type OauthLandingReason = (typeof OAUTH_LANDING_REASONS)[number]

export function isOauthLandingReason(value: unknown): value is OauthLandingReason {
  return OAUTH_LANDING_REASONS.some((reason) => reason === value)
}

export interface OauthLandingOutcome {
  readonly status: 'success' | 'error'
  /** The addon that ran the flow — names the integration page to return to, when known. */
  readonly addonId?: string
  /** The broker the flow signed in, when it was one. */
  readonly brokerId?: string
  /** An OAuth integration id (`export-alexa`), when the flow was an account link. */
  readonly integration?: string
  /** Why it failed; an error without one reads as `unknown`. */
  readonly reason?: OauthLandingReason
  /** What the flow did; absent means a sign-in (connect). */
  readonly action?: 'connect' | 'disconnect'
}

/**
 * The landing URL for `outcome`. `origin` is the hub address the flow already
 * runs on (from the `local-network` palette role, never a literal); `null`
 * gives a hub-relative URL.
 */
export function oauthLandingUrl(origin: string | null, outcome: OauthLandingOutcome): string {
  const params = new URLSearchParams({ return: 'oauth', status: outcome.status })
  if (outcome.addonId !== undefined) params.set('addon', outcome.addonId)
  if (outcome.brokerId !== undefined) params.set('broker', outcome.brokerId)
  if (outcome.integration !== undefined) params.set('integration', outcome.integration)
  if (outcome.status === 'error') params.set('reason', outcome.reason ?? 'unknown')
  if (outcome.action === 'disconnect') params.set('action', 'disconnect')
  const base = origin === null ? '' : origin.replace(/\/+$/, '')
  return `${base}${OAUTH_LANDING_PATH}#${params.toString()}`
}

/** Parse the fragment of a landing URL; `null` for anything that is not one. */
export function parseOauthLandingFragment(hash: string): OauthLandingOutcome | null {
  if (!hash.startsWith('#')) return null
  const params = new URLSearchParams(hash.slice(1))
  if (params.get('return') !== 'oauth') return null
  const status = params.get('status')
  if (status !== 'success' && status !== 'error') return null
  const addonId = params.get('addon')
  const brokerId = params.get('broker')
  const integration = params.get('integration')
  const reasonRaw = params.get('reason')
  return {
    status,
    ...(addonId !== null && addonId.length > 0 ? { addonId } : {}),
    ...(brokerId !== null && brokerId.length > 0 ? { brokerId } : {}),
    ...(integration !== null && integration.length > 0 ? { integration } : {}),
    ...(status === 'error'
      ? { reason: isOauthLandingReason(reasonRaw) ? reasonRaw : 'unknown' }
      : {}),
    ...(params.get('action') === 'disconnect' ? { action: 'disconnect' as const } : {}),
  }
}
