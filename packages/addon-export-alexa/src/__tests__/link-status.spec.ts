/**
 * The two pure pieces behind the Alexa settings form's account-link surface:
 * which OAuth sessions an "unlink" must revoke, and what the operator is told
 * about the Amazon-side push grant.
 *
 * Both exist because the link has TWO halves that fail in opposite directions
 * and neither was visible anywhere:
 *   - the hub-side session Amazon refreshes against (`refreshTokenTtlSec:
 *     'never'`, so revocation is the ONLY severance), and
 *   - the LWA grant WE hold of Amazon, which expires hourly and is renewed on
 *     a 60s scan whose failure is a `warn` nobody reads.
 */
import { describe, expect, it } from 'vitest'

import {
  ALEXA_OAUTH_INTEGRATION_ID,
  buildLinkStatusContent,
  selectAlexaSessionIdsToRevoke,
} from '../link-status.js'
import type { LinkedAccount, LwaTokenEntry } from '../types.js'

const MIN = 60_000
const NOW = 1_786_300_000_000

function session(over: { id: string; integrationId?: string; revokedAt?: number | null }): {
  id: string
  userId: string
  username: string
  integrationId: string
  revokedAt: number | null
} {
  return {
    id: over.id,
    userId: 'u1',
    username: 'operator',
    integrationId: over.integrationId ?? ALEXA_OAUTH_INTEGRATION_ID,
    revokedAt: over.revokedAt ?? null,
  }
}

function account(over: Partial<LinkedAccount> = {}): LinkedAccount {
  return { userId: 'u1', username: 'operator', linkedAt: NOW - 7 * 24 * 60 * MIN, ...over }
}

function token(over: Partial<LwaTokenEntry> = {}): LwaTokenEntry {
  return {
    userId: 'u1',
    accessToken: 'a',
    brokerUrl: 'https://broker.example.test',
    brokerCredential: 'csb1.link.secret',
    expiresAt: NOW + 42 * MIN,
    receivedAt: NOW - 18 * MIN,
    ...over,
  }
}

describe('selectAlexaSessionIdsToRevoke', () => {
  it('picks only the ACTIVE export-alexa sessions', () => {
    const ids = selectAlexaSessionIdsToRevoke([
      session({ id: 'alexa-live' }),
      session({ id: 'alexa-dead', revokedAt: NOW - MIN }),
      session({ id: 'ha-live', integrationId: 'homeassistant' }),
    ])
    expect(ids).toEqual(['alexa-live'])
  })

  it('picks EVERY active alexa session — a re-link mints a second row and the first stays alive forever', () => {
    // `oauthExchangeCode` creates a new `oauth_sessions` row per link, and the
    // descriptor sets `refreshTokenTtlSec: 'never'`. Revoking only the newest
    // would leave the previous Amazon account refreshing indefinitely.
    const ids = selectAlexaSessionIdsToRevoke([session({ id: 'first' }), session({ id: 'second' })])
    expect(ids).toEqual(['first', 'second'])
  })

  it('is empty when nothing is linked', () => {
    expect(selectAlexaSessionIdsToRevoke([])).toEqual([])
    expect(
      selectAlexaSessionIdsToRevoke([session({ id: 'ha', integrationId: 'homeassistant' })]),
    ).toEqual([])
  })
})

describe('buildLinkStatusContent', () => {
  it('says plainly that nothing is linked', () => {
    const out = buildLinkStatusContent({
      linkedAccounts: [],
      tokens: [],
      now: NOW,
    })
    expect(out).toContain('No Amazon account is linked')
  })

  it('names each linked account and reports a healthy push grant with its remaining life', () => {
    const out = buildLinkStatusContent({
      linkedAccounts: [account()],
      tokens: [token()],
      now: NOW,
    })
    expect(out).toContain('operator')
    expect(out).toContain('held')
    // 42 min of access-token life left, last renewed 18 min ago.
    expect(out).toContain('42 min')
    expect(out).toContain('18 min ago')
    expect(out).not.toContain('EXPIRED')
  })

  it('calls an expired grant EXPIRED and says proactive events are not reaching Alexa', () => {
    // The 60s scan renews 5 min BEFORE expiry, so a token that is actually past
    // its expiry means renewal has been failing — the silent failure mode.
    const out = buildLinkStatusContent({
      linkedAccounts: [account()],
      tokens: [token({ expiresAt: NOW - 9 * MIN, receivedAt: NOW - 69 * MIN })],
      now: NOW,
    })
    expect(out).toContain('EXPIRED')
    expect(out).toContain('9 min ago')
    expect(out).toContain('NOT reaching Alexa')
  })

  it('flags an account with no stored grant at all', () => {
    const out = buildLinkStatusContent({
      linkedAccounts: [account()],
      tokens: [],
      now: NOW,
    })
    expect(out).toContain('MISSING')
  })

  it('calls a pre-D753 grant LEGACY and says the hub cannot renew it itself', () => {
    const out = buildLinkStatusContent({
      linkedAccounts: [account()],
      tokens: [
        {
          userId: 'u1',
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: NOW + 30 * MIN,
          receivedAt: NOW - 30 * MIN,
        },
      ],
      now: NOW,
    })
    expect(out).toContain('LEGACY')
    expect(out).toContain('no LWA secret')
    expect(out).toContain('30 min')
  })

  it('never echoes a token value', () => {
    const out = buildLinkStatusContent({
      linkedAccounts: [account()],
      tokens: [
        token({ accessToken: 'SECRET-ACCESS', brokerCredential: 'SECRET-CREDENTIAL' }),
        token({ userId: 'u2', accessToken: 'a', refreshToken: 'SECRET-REFRESH' }),
      ],
      now: NOW,
    })
    expect(out).not.toContain('SECRET-ACCESS')
    expect(out).not.toContain('SECRET-REFRESH')
    expect(out).not.toContain('SECRET-CREDENTIAL')
  })
})
