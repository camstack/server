/**
 * The refresh token's lifetime is declared by the INTEGRATION, not hardcoded.
 *
 * These assertions deliberately never check "30 days" against the default —
 * that passes whether or not anything reads the descriptor. Every case pins a
 * descriptor value that DIFFERS from the default and follows it through the
 * mint, the claim, and the re-mint on refresh.
 */
import type { TokenScope } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { createOauthGrants, DEFAULT_REFRESH_TTL_SEC } from '../oauth-grants.js'
import type { OauthSession } from '../oauth-session-manager.js'

interface SignCall {
  readonly claims: Record<string, unknown>
  readonly ttlSec: number | 'never' | undefined
}

/** Records every sign so the TTL actually handed to the signer is observable —
 *  the fake must not supply what production forgot to pass. */
function recordingSsoBridge() {
  const calls: SignCall[] = []
  return {
    calls,
    signBridgeToken: async (input: {
      claims: Record<string, unknown>
      ttlSec?: number | 'never'
    }) => {
      calls.push({ claims: input.claims, ttlSec: input.ttlSec })
      return { token: Buffer.from(JSON.stringify(input.claims)).toString('base64url') + '.sig' }
    },
    verifyBridgeToken: async ({ token }: { token: string }) => {
      const [body, sig] = token.split('.')
      if (sig !== 'sig') return null
      return JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as Record<string, unknown>
    },
  }
}

function fakeSessionManager() {
  const store = new Map<string, OauthSession>()
  let seq = 0
  return {
    store,
    async create(input: {
      userId: string
      username: string
      integrationId: string
      scopes: TokenScope[]
    }): Promise<OauthSession> {
      const now = Date.now()
      const session: OauthSession = {
        id: `session-${++seq}`,
        userId: input.userId,
        username: input.username,
        integrationId: input.integrationId,
        scopes: input.scopes,
        createdAt: now,
        lastUsedAt: now,
        revokedAt: null,
      }
      store.set(session.id, session)
      return session
    },
    async list(): Promise<OauthSession[]> {
      return Array.from(store.values())
    },
    async getById(id: string): Promise<OauthSession | null> {
      return store.get(id) ?? null
    },
    async markRevoked(id: string): Promise<boolean> {
      const existing = store.get(id)
      if (!existing) return false
      store.set(id, { ...existing, revokedAt: Date.now() })
      return true
    },
    async touch(): Promise<void> {},
  }
}

const scopes: TokenScope[] = [{ type: 'category', target: 'device', access: ['view', 'create'] }]
const REDIRECT = 'https://cb.example/r'

/** Signer calls come in pairs: access first, then refresh. */
function refreshTtlOf(calls: readonly SignCall[]): number | 'never' | undefined {
  const refresh = calls.filter((c) => c.claims['provider'] === 'oauth-refresh')
  return refresh[refresh.length - 1]?.ttlSec
}

async function link(
  bridge: ReturnType<typeof recordingSsoBridge>,
  refreshTtlSec: number | 'never' | undefined,
) {
  const g = createOauthGrants(bridge as never, fakeSessionManager() as never)
  const { code } = await g.oauthIssueCode({
    integrationId: 'test-integration',
    userId: 'u1',
    username: 'op',
    scopes,
    redirectUri: REDIRECT,
    hubUrl: 'https://hub.example',
    ...(refreshTtlSec !== undefined ? { refreshTtlSec } : {}),
  })
  const pair = await g.oauthExchangeCode({ code, redirectUri: REDIRECT })
  return { g, pair }
}

describe('per-integration refresh-token lifetime', () => {
  it('signs the refresh with the ONE YEAR the descriptor asked for, not the default', async () => {
    const ONE_YEAR = 365 * 24 * 60 * 60
    expect(ONE_YEAR).not.toBe(DEFAULT_REFRESH_TTL_SEC) // the assertion must discriminate
    const bridge = recordingSsoBridge()
    await link(bridge, ONE_YEAR)
    expect(refreshTtlOf(bridge.calls)).toBe(ONE_YEAR)
  })

  it("signs the refresh with NO expiry when the descriptor says 'never'", async () => {
    const bridge = recordingSsoBridge()
    await link(bridge, 'never')
    expect(refreshTtlOf(bridge.calls)).toBe('never')
  })

  it('leaves the ACCESS token at one hour regardless of the refresh lifetime', async () => {
    const bridge = recordingSsoBridge()
    const { pair } = await link(bridge, 'never')
    expect(pair!.expiresIn).toBe(3600)
    const access = bridge.calls.filter((c) => c.claims['provider'] === 'oauth-access')
    expect(access[0]!.ttlSec).toBe(3600)
  })

  it('falls back to the 30-day default when the descriptor declares nothing', async () => {
    const bridge = recordingSsoBridge()
    await link(bridge, undefined)
    expect(refreshTtlOf(bridge.calls)).toBe(DEFAULT_REFRESH_TTL_SEC)
  })

  it('carries the lifetime into the re-mint, so a refresh does not silently shorten the link', async () => {
    const ONE_YEAR = 365 * 24 * 60 * 60
    const bridge = recordingSsoBridge()
    const { g, pair } = await link(bridge, ONE_YEAR)
    const again = await g.oauthRefresh({ refreshToken: pair!.refreshToken })
    expect(again).not.toBeNull()
    expect(refreshTtlOf(bridge.calls)).toBe(ONE_YEAR)
  })

  it("REVOCATION still bounds a 'never' token — the only thing that does", async () => {
    // This is the whole security story for an eternal refresh token. If this
    // ever goes green-by-accident, a leaked token is permanent access.
    const bridge = recordingSsoBridge()
    const sessions = fakeSessionManager()
    const g = createOauthGrants(bridge as never, sessions as never)
    const { code } = await g.oauthIssueCode({
      integrationId: 'test-integration',
      userId: 'u1',
      username: 'op',
      scopes,
      redirectUri: REDIRECT,
      hubUrl: 'https://hub.example',
      refreshTtlSec: 'never',
    })
    const pair = await g.oauthExchangeCode({ code, redirectUri: REDIRECT })
    expect(await g.oauthRefresh({ refreshToken: pair!.refreshToken })).not.toBeNull()

    const [session] = Array.from(sessions.store.values())
    await sessions.markRevoked(session!.id)

    expect(await g.oauthRefresh({ refreshToken: pair!.refreshToken })).toBeNull()
    expect(await g.oauthVerifyAccessToken({ token: pair!.accessToken })).toBeNull()
  })
})
