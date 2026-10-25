/**
 * Account-link state for the Alexa export — the two questions the settings
 * form could not answer, kept pure so both are testable without an addon.
 *
 * The link has TWO halves, stored in two different places, and they fail in
 * opposite directions:
 *
 *   1. **The hub-side session Amazon refreshes against.** Created by
 *      `oauthExchangeCode` as a row in `oauth_sessions`, keyed by the CAMSTACK
 *      user who consented — there is no Amazon identifier anywhere in this
 *      system. `buildAlexaOauthIntegration` sets `refreshTokenTtlSec: 'never'`,
 *      so this half never expires: revoking the session is the ONLY way to
 *      sever it. `selectAlexaSessionIdsToRevoke` is what an unlink must revoke,
 *      and it deliberately returns EVERY active `export-alexa` session — a
 *      re-link mints a second row and leaves the first one alive forever.
 *
 *   2. **The LWA grant WE hold OF Amazon**, delivered by the skill Lambda
 *      (`/oauth/broker-link`; legacy `/oauth/lwa-tokens`) and used by
 *      `LwaEventGateway` to push motion / doorbell / discovery reports. Since
 *      D753 the refresh token and client secret stay in the Lambda; this hub
 *      holds a broker credential and a 1h access token, renewed through the
 *      broker on a 60s scan. When renewal fails nothing user-visible breaks: cameras just
 *      stop updating in the Alexa app. `buildLinkStatusContent` turns the two
 *      stamps the token entry already carries (`receivedAt`, `expiresAt`) into
 *      an honest readout, so the operator can see the stall instead of
 *      inferring it. No new state is stored to produce it.
 *
 * Neither function reads or writes a store: the caller passes the authority's
 * current values in, which is what keeps this from becoming a second registry
 * of who is linked.
 */
import { z } from 'zod'

import { isBrokerGrant, type LinkedAccount, type LwaTokenEntry } from './types.js'

/**
 * The id the hub's OAuth server knows this addon by — the `integrationId`
 * column on every `oauth_sessions` row this addon's links create, and the
 * `integration=` query parameter on `/api/oauth2/authorize`.
 */
export const ALEXA_OAUTH_INTEGRATION_ID = 'export-alexa'

/**
 * The subset of `listOauthSessions`' rows this addon reads.
 *
 * Declared locally rather than imported: `OauthSessionSummarySchema` is
 * exported from `user-management.cap.ts` but NOT re-exported from
 * `@camstack/types`' barrel, and widening that barrel would put this change on
 * the publish train instead of a `camstack deploy`. Same reason
 * `lwa-tokens-callback.ts` declares its own `OauthVerifiedResultSchema`.
 */
export const OauthSessionRowSchema = z.object({
  id: z.string(),
  userId: z.string(),
  username: z.string(),
  integrationId: z.string(),
  revokedAt: z.number().nullable(),
})
export type OauthSessionRow = z.infer<typeof OauthSessionRowSchema>

/** `listOauthSessions` returns every session for every integration. */
export const OauthSessionListSchema = z.array(OauthSessionRowSchema)

/**
 * Every ACTIVE `export-alexa` session id — what an unlink must revoke to sever
 * the hub-side half of the link.
 *
 * All of them, not just the newest: `oauthExchangeCode` creates a fresh row per
 * completed link and never retires the previous one, and with
 * `refreshTokenTtlSec: 'never'` a leftover row refreshes indefinitely. Already
 * revoked rows are skipped — `markRevoked` is idempotent, but re-revoking would
 * make the reported count lie.
 */
export function selectAlexaSessionIdsToRevoke(
  sessions: readonly OauthSessionRow[],
): readonly string[] {
  return sessions
    .filter((s) => s.integrationId === ALEXA_OAUTH_INTEGRATION_ID && s.revokedAt === null)
    .map((s) => s.id)
}

export interface LinkStatusInput {
  readonly linkedAccounts: readonly LinkedAccount[]
  readonly tokens: readonly LwaTokenEntry[]
  readonly now: number
}

/**
 * How early the gateway's 60s scan renews a token (`REFRESH_PROACTIVE_WINDOW_MS`
 * in `lwa-event-gateway.ts`). A token found PAST its expiry therefore means the
 * renewal has been failing for at least this long — it is evidence, not a race.
 */
const RENEWAL_LEAD_MS = 5 * 60 * 1000

function minutes(ms: number): number {
  return Math.round(ms / 60_000)
}

function stamp(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

/**
 * The operator-facing `info` block for the settings form. Deterministic, and
 * carries no token material — the values are timestamps only.
 */
export function buildLinkStatusContent(input: LinkStatusInput): string {
  const lines: string[] = []

  if (input.linkedAccounts.length === 0) {
    lines.push(
      'No Amazon account is linked to this hub. Link one from the Alexa app (the skill\'s "Settings → Link Account"); the link is recorded here the moment Amazon completes it.',
    )
    return lines.join('\n')
  }

  lines.push(
    `${input.linkedAccounts.length} Amazon account link(s). Each one is identified by the CAMSTACK user who consented — Amazon never tells us which Amazon account it was.`,
  )

  for (const acc of input.linkedAccounts) {
    lines.push(`• ${acc.username} — linked ${stamp(acc.linkedAt)}`)
    lines.push(`   ${describeGrant(acc, input)}`)
  }
  return lines.join('\n')
}

function describeGrant(acc: LinkedAccount, input: LinkStatusInput): string {
  const token = input.tokens.find((t) => t.userId === acc.userId)
  if (!token) {
    return 'Amazon push grant: MISSING — proactive events (motion, doorbell, discovery) cannot be delivered for this account. Re-link the skill in the Alexa app to re-issue it.'
  }
  const renewedAgo = minutes(input.now - token.receivedAt)
  if (!isBrokerGrant(token)) {
    const life =
      token.expiresAt <= input.now
        ? `its token EXPIRED ${minutes(input.now - token.expiresAt)} min ago, so proactive events are NOT reaching Alexa`
        : `its token is valid for another ${minutes(token.expiresAt - input.now)} min`
    return `Amazon push grant: LEGACY — delivered by a skill Lambda without the token broker, and this hub holds no LWA secret to renew it (D753); ${life}. It moves to the skill's broker automatically on the next Alexa request; if it does not, update the skill Lambda or re-link.`
  }
  if (token.expiresAt <= input.now) {
    return `Amazon push grant: EXPIRED ${minutes(input.now - token.expiresAt)} min ago (last renewed ${renewedAgo} min ago). The gateway renews ${minutes(RENEWAL_LEAD_MS)} min before expiry through the skill's token broker, so renewal is failing and proactive events are NOT reaching Alexa — check the addon log for "broker renewal failed".`
  }
  return `Amazon push grant: held via the skill's token broker, valid for another ${minutes(token.expiresAt - input.now)} min (last renewed ${renewedAgo} min ago).`
}
