/**
 * The admin-ui side of an OAuth completion (`/sso-complete#return=oauth&…`,
 * built by `oauthLandingUrl` in `@camstack/types`): where the page returns to,
 * and how a popup hands its outcome back to the window that opened it.
 *
 * The hand-back reuses the broker popup's message (`camstack:broker-oauth`),
 * so the opener's existing `watchBrokerOauthPopup` refreshes broker status
 * without knowing which page the popup ended on. Same-origin only: the message
 * goes to this page's own origin, and a cross-origin or closed opener is not
 * written to. It carries a reason CODE, never a token or a message.
 */
import type { OauthLandingOutcome } from '@camstack/types'
import { BROKER_OAUTH_MESSAGE } from './broker-oauth-popup'
import { integrationHubHref } from './integration-hub-url'
import { readableOrigin } from './sso-popup'

/** How long a full-page success stays before returning on its own. */
export const OAUTH_RETURN_DELAY_MS = 4000

const PLAIN_ID = /^[A-Za-z0-9._-]{1,64}$/

/** The admin page the outcome belongs to (relative to the admin-ui mount). */
export function oauthReturnPath(outcome: OauthLandingOutcome): string {
  const addon =
    outcome.addonId !== undefined && PLAIN_ID.test(outcome.addonId) ? outcome.addonId : null
  const integration =
    outcome.integration !== undefined && PLAIN_ID.test(outcome.integration)
      ? outcome.integration
      : null
  if (addon !== null && outcome.brokerId !== undefined) {
    return integrationHubHref('connectivity', { integration: addon, kindSection: 'brokers' })
  }
  const target = integration ?? addon
  return integrationHubHref('connectivity', target === null ? {} : { integration: target })
}

export interface OauthDeliveryEnv {
  readonly opener: Window | null
  /** This page's own origin — the only target the message is sent to. */
  readonly origin: string
}

/** Hand the outcome to a live same-origin opener; `true` when it was posted. */
export function deliverOauthOutcome(outcome: OauthLandingOutcome, env: OauthDeliveryEnv): boolean {
  const opener = env.opener
  if (opener === null || opener.closed) return false
  if (readableOrigin(opener) !== env.origin) return false
  try {
    opener.postMessage(
      {
        type: BROKER_OAUTH_MESSAGE,
        ok: outcome.status === 'success',
        ...(outcome.brokerId !== undefined ? { brokerId: outcome.brokerId } : {}),
        // i18n-ignore: a reason code on the wire, not display text
        ...(outcome.status === 'error' ? { error: outcome.reason ?? 'unknown' } : {}),
      },
      env.origin,
    )
    return true
  } catch {
    return false
  }
}
