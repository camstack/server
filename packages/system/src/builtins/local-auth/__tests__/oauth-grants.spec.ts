import { createHash } from 'node:crypto'
import { SsoBridgeClaimsSchema, type TokenScope } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { createOauthGrants, verifyPkceS256 } from '../oauth-grants.js'
import type { OauthSession } from '../oauth-session-manager.js'

// Minimal in-memory sso-bridge stand-in: signs a JSON payload as
// `<base64url(claims)>.<sig>` and verifies by parsing it back.
// `sig` must equal 'sig' — any other suffix causes verifyBridgeToken
// to return null, simulating a bad/tampered signature.
function fakeSsoBridge() {
  return {
    signBridgeToken: async ({ claims }: { claims: Record<string, unknown> }) => ({
      token: Buffer.from(JSON.stringify(claims)).toString('base64url') + '.sig',
    }),
    verifyBridgeToken: async ({
      token,
    }: {
      token: string
    }): Promise<Record<string, unknown> | null> => {
      const [body, sig] = token.split('.')
      if (sig !== 'sig') return null
      return JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as Record<string, unknown>
    },
  }
}

// In-memory fake OauthSessionManager backed by a Map.
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
      if (existing.revokedAt !== null) return true
      store.set(id, { ...existing, revokedAt: Date.now() })
      return true
    },
    async touch(id: string): Promise<void> {
      const existing = store.get(id)
      if (!existing) return
      store.set(id, { ...existing, lastUsedAt: Date.now() })
    },
  }
}

const scopes = [
  {
    type: 'category' as const,
    target: 'device' as const,
    access: ['view', 'create'] as ('view' | 'create' | 'delete')[],
  },
]

describe('oauth-grants', () => {
  it('issues a code then exchanges it for access + refresh tokens', async () => {
    const g = createOauthGrants(fakeSsoBridge() as never, fakeSessionManager() as never)
    const { code } = await g.oauthIssueCode({
      integrationId: 'export-alexa',
      userId: 'u1',
      username: 'op',
      scopes,
      redirectUri: 'https://cb.example/r',
      hubUrl: 'https://hub.example',
    })
    const out = await g.oauthExchangeCode({ code, redirectUri: 'https://cb.example/r' })
    expect(out).not.toBeNull()
    expect(out!.expiresIn).toBe(3600)
    const claims = await g.oauthVerifyAccessToken({ token: out!.accessToken })
    expect(claims).toEqual({ userId: 'u1', username: 'op', scopes })
  })

  it('rejects an exchange when redirectUri does not match the code', async () => {
    const g = createOauthGrants(fakeSsoBridge() as never, fakeSessionManager() as never)
    const { code } = await g.oauthIssueCode({
      integrationId: 'export-alexa',
      userId: 'u1',
      username: 'op',
      scopes,
      redirectUri: 'https://cb.example/r',
      hubUrl: 'https://hub.example',
    })
    // The redirectUri mismatch is now enforced via the JWT claim, not the old Map.
    expect(await g.oauthExchangeCode({ code, redirectUri: 'https://evil.example/r' })).toBeNull()
  })

  it('rejects an access token presented as a code', async () => {
    const g = createOauthGrants(fakeSsoBridge() as never, fakeSessionManager() as never)
    const { code } = await g.oauthIssueCode({
      integrationId: 'export-alexa',
      userId: 'u1',
      username: 'op',
      scopes,
      redirectUri: 'https://cb.example/r',
      hubUrl: 'https://hub.example',
    })
    const out = await g.oauthExchangeCode({ code, redirectUri: 'https://cb.example/r' })
    expect(
      await g.oauthExchangeCode({ code: out!.accessToken, redirectUri: 'https://cb.example/r' }),
    ).toBeNull()
  })

  it('rejects a code with a tampered signature (signature is the real security boundary)', async () => {
    const g = createOauthGrants(fakeSsoBridge() as never, fakeSessionManager() as never)
    const { code } = await g.oauthIssueCode({
      integrationId: 'export-alexa',
      userId: 'u1',
      username: 'op',
      scopes,
      redirectUri: 'https://cb.example/r',
      hubUrl: 'https://hub.example',
    })
    // Replace the valid '.sig' suffix with a tampered one.
    const tamperedCode = code.replace(/\.sig$/, '.TAMPERED')
    expect(
      await g.oauthExchangeCode({ code: tamperedCode, redirectUri: 'https://cb.example/r' }),
    ).toBeNull()
  })

  it('rejects a second exchange of the same valid code (jti single-use)', async () => {
    const g = createOauthGrants(fakeSsoBridge() as never, fakeSessionManager() as never)
    const { code } = await g.oauthIssueCode({
      integrationId: 'export-alexa',
      userId: 'u1',
      username: 'op',
      scopes,
      redirectUri: 'https://cb.example/r',
      hubUrl: 'https://hub.example',
    })
    const first = await g.oauthExchangeCode({ code, redirectUri: 'https://cb.example/r' })
    expect(first).not.toBeNull()
    // Second exchange of the same code must be rejected regardless of the valid signature.
    const second = await g.oauthExchangeCode({ code, redirectUri: 'https://cb.example/r' })
    expect(second).toBeNull()
  })

  describe('session management', () => {
    it('exchange creates a session record with correct userId, integrationId, and scopes', async () => {
      const sm = fakeSessionManager()
      const g = createOauthGrants(fakeSsoBridge() as never, sm as never)

      const { code } = await g.oauthIssueCode({
        integrationId: 'export-alexa',
        userId: 'u1',
        username: 'op',
        scopes,
        redirectUri: 'https://cb.example/r',
        hubUrl: 'https://hub.example',
      })
      const out = await g.oauthExchangeCode({ code, redirectUri: 'https://cb.example/r' })
      expect(out).not.toBeNull()

      const sessions = await sm.list()
      expect(sessions).toHaveLength(1)
      expect(sessions[0]).toMatchObject({
        userId: 'u1',
        integrationId: 'export-alexa',
        scopes,
        revokedAt: null,
      })
    })

    it('revoking session causes oauthVerifyAccessToken to return null', async () => {
      const sm = fakeSessionManager()
      const g = createOauthGrants(fakeSsoBridge() as never, sm as never)

      const { code } = await g.oauthIssueCode({
        integrationId: 'export-alexa',
        userId: 'u1',
        username: 'op',
        scopes,
        redirectUri: 'https://cb.example/r',
        hubUrl: 'https://hub.example',
      })
      const out = await g.oauthExchangeCode({ code, redirectUri: 'https://cb.example/r' })
      expect(out).not.toBeNull()

      // Token verifies before revocation.
      expect(await g.oauthVerifyAccessToken({ token: out!.accessToken })).not.toBeNull()

      // Revoke the session.
      const sessions = await sm.list()
      await sm.markRevoked(sessions[0]!.id)

      // Same access token must now be rejected.
      expect(await g.oauthVerifyAccessToken({ token: out!.accessToken })).toBeNull()
    })

    it('revoking session causes oauthRefresh to return null', async () => {
      const sm = fakeSessionManager()
      const g = createOauthGrants(fakeSsoBridge() as never, sm as never)

      const { code } = await g.oauthIssueCode({
        integrationId: 'export-alexa',
        userId: 'u1',
        username: 'op',
        scopes,
        redirectUri: 'https://cb.example/r',
        hubUrl: 'https://hub.example',
      })
      const out = await g.oauthExchangeCode({ code, redirectUri: 'https://cb.example/r' })
      expect(out).not.toBeNull()

      // Refresh works before revocation.
      expect(await g.oauthRefresh({ refreshToken: out!.refreshToken })).not.toBeNull()

      // Revoke the session.
      const sessions = await sm.list()
      await sm.markRevoked(sessions[0]!.id)

      // Refresh must now be rejected.
      expect(await g.oauthRefresh({ refreshToken: out!.refreshToken })).toBeNull()
    })
  })

  describe('oauthRefresh', () => {
    it('happy path: exchanges a refresh token for a fresh access + refresh pair with matching claims', async () => {
      const g = createOauthGrants(fakeSsoBridge() as never, fakeSessionManager() as never)
      // Issue a code and exchange it to obtain a refresh token.
      const { code } = await g.oauthIssueCode({
        integrationId: 'export-alexa',
        userId: 'u1',
        username: 'op',
        scopes,
        redirectUri: 'https://cb.example/r',
        hubUrl: 'https://hub.example',
      })
      const original = await g.oauthExchangeCode({ code, redirectUri: 'https://cb.example/r' })
      expect(original).not.toBeNull()

      // Use the refresh token to obtain a new pair.
      const refreshed = await g.oauthRefresh({ refreshToken: original!.refreshToken })
      expect(refreshed).not.toBeNull()
      expect(refreshed).toMatchObject({ expiresIn: 3600 })
      expect(typeof refreshed!.accessToken).toBe('string')
      expect(refreshed!.accessToken.length).toBeGreaterThan(0)
      expect(typeof refreshed!.refreshToken).toBe('string')
      expect(refreshed!.refreshToken.length).toBeGreaterThan(0)

      // The new access token must carry the same subject claims as the original.
      const verified = await g.oauthVerifyAccessToken({ token: refreshed!.accessToken })
      expect(verified).toEqual({ userId: 'u1', username: 'op', scopes })
    })

    it('wrong-kind rejection: an access token (kind oauth-access) is rejected', async () => {
      const g = createOauthGrants(fakeSsoBridge() as never, fakeSessionManager() as never)
      const { code } = await g.oauthIssueCode({
        integrationId: 'export-alexa',
        userId: 'u1',
        username: 'op',
        scopes,
        redirectUri: 'https://cb.example/r',
        hubUrl: 'https://hub.example',
      })
      const pair = await g.oauthExchangeCode({ code, redirectUri: 'https://cb.example/r' })
      expect(pair).not.toBeNull()

      // Passing an access token where a refresh token is expected must return null.
      const result = await g.oauthRefresh({ refreshToken: pair!.accessToken })
      expect(result).toBeNull()
    })

    it('wrong-kind rejection: an authorization code (kind oauth-code) is rejected', async () => {
      const g = createOauthGrants(fakeSsoBridge() as never, fakeSessionManager() as never)
      const { code } = await g.oauthIssueCode({
        integrationId: 'export-alexa',
        userId: 'u1',
        username: 'op',
        scopes,
        redirectUri: 'https://cb.example/r',
        hubUrl: 'https://hub.example',
      })

      // Passing a code token where a refresh token is expected must return null.
      const result = await g.oauthRefresh({ refreshToken: code })
      expect(result).toBeNull()
    })

    it('tampered token: a refresh token with a corrupted signature returns null', async () => {
      const g = createOauthGrants(fakeSsoBridge() as never, fakeSessionManager() as never)
      const { code } = await g.oauthIssueCode({
        integrationId: 'export-alexa',
        userId: 'u1',
        username: 'op',
        scopes,
        redirectUri: 'https://cb.example/r',
        hubUrl: 'https://hub.example',
      })
      const pair = await g.oauthExchangeCode({ code, redirectUri: 'https://cb.example/r' })
      expect(pair).not.toBeNull()

      // Replace the valid '.sig' suffix with a tampered one.
      const tampered = pair!.refreshToken.replace(/\.sig$/, '.TAMPERED')
      const result = await g.oauthRefresh({ refreshToken: tampered })
      expect(result).toBeNull()
    })
  })
})

// ── PKCE ───────────────────────────────────────────────────────────────────
//
// The requirement travels with the CODE, not with the integration descriptor:
// a code minted with a challenge stays unredeemable without the verifier even
// if the integration later stops asking for PKCE. That is the property these
// tests pin, because it is the one that is easy to lose in a refactor.

describe('oauth-grants — PKCE', () => {
  // BASE64URL(SHA256("verifier-abc")), computed independently of the
  // implementation so the test cannot agree with a broken digest.
  const VERIFIER = 'verifier-abc'
  const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')

  async function issueWithChallenge() {
    const g = createOauthGrants(fakeSsoBridge() as never, fakeSessionManager() as never)
    const { code } = await g.oauthIssueCode({
      integrationId: 'homeassistant',
      userId: 'u1',
      username: 'op',
      scopes,
      redirectUri: 'http://192.168.10.40:8123/auth/external/callback',
      hubUrl: 'https://hub.example',
      codeChallenge: CHALLENGE,
    })
    return { g, code, redirectUri: 'http://192.168.10.40:8123/auth/external/callback' }
  }

  it('exchanges when the verifier hashes to the challenge', async () => {
    const { g, code, redirectUri } = await issueWithChallenge()
    const out = await g.oauthExchangeCode({ code, redirectUri, codeVerifier: VERIFIER })
    expect(out).not.toBeNull()
  })

  it('refuses when the verifier is MISSING — an intercepted code is worthless', async () => {
    const { g, code, redirectUri } = await issueWithChallenge()
    expect(await g.oauthExchangeCode({ code, redirectUri })).toBeNull()
  })

  it('refuses a wrong verifier', async () => {
    const { g, code, redirectUri } = await issueWithChallenge()
    expect(
      await g.oauthExchangeCode({ code, redirectUri, codeVerifier: 'verifier-abd' }),
    ).toBeNull()
  })

  it('refuses the CHALLENGE replayed as the verifier', async () => {
    const { g, code, redirectUri } = await issueWithChallenge()
    expect(await g.oauthExchangeCode({ code, redirectUri, codeVerifier: CHALLENGE })).toBeNull()
  })

  it('a failed verifier does not burn the code — a typo is recoverable', async () => {
    const { g, code, redirectUri } = await issueWithChallenge()
    expect(await g.oauthExchangeCode({ code, redirectUri, codeVerifier: 'nope' })).toBeNull()
    expect(await g.oauthExchangeCode({ code, redirectUri, codeVerifier: VERIFIER })).not.toBeNull()
  })

  it('ignores a verifier on a code that carries no challenge (Alexa is unchanged)', async () => {
    const g = createOauthGrants(fakeSsoBridge() as never, fakeSessionManager() as never)
    const { code } = await g.oauthIssueCode({
      integrationId: 'export-alexa',
      userId: 'u1',
      username: 'op',
      scopes,
      redirectUri: 'https://cb.example/r',
      hubUrl: 'https://hub.example',
    })
    const out = await g.oauthExchangeCode({
      code,
      redirectUri: 'https://cb.example/r',
      codeVerifier: 'irrelevant',
    })
    expect(out).not.toBeNull()
  })
})

describe('verifyPkceS256', () => {
  it('is S256, not plain', () => {
    const challenge = createHash('sha256').update('v').digest('base64url')
    expect(verifyPkceS256(challenge, 'v')).toBe(true)
    expect(verifyPkceS256('v', 'v')).toBe(false)
  })
  it('is false on an undefined verifier rather than throwing', () => {
    expect(verifyPkceS256('anything', undefined)).toBe(false)
  })
})

describe('SsoBridgeClaimsSchema', () => {
  // The fake bridge above round-trips arbitrary JSON. The REAL one is a cap
  // whose claims go through this Zod object, which STRIPS unknown keys — so a
  // challenge missing from the schema would vanish between issue and exchange
  // while every test above stayed green. This is that gap, closed.
  it('carries codeChallenge through a parse', () => {
    const parsed = SsoBridgeClaimsSchema.parse({
      userId: 'u1',
      username: 'op',
      isAdmin: false,
      provider: 'oauth-code',
      codeChallenge: 'abc',
    })
    expect(parsed.codeChallenge).toBe('abc')
  })
})
