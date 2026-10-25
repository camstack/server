import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { ISsoBridgeProvider, TokenScope } from '@camstack/types'
import type { OauthSessionManager } from './oauth-session-manager.js'

const TTL = { 'oauth-code': 60, 'oauth-access': 3600 } as const

/**
 * The refresh lifetime for an integration whose descriptor declares none.
 * 30 days — the value every link used before `refreshTokenTtlSec` existed, kept
 * as the default so an integration that says nothing is unchanged.
 */
export const DEFAULT_REFRESH_TTL_SEC = 2_592_000

/** Seconds, or `'never'` for a refresh token minted with no `exp` claim. */
export type RefreshTtl = number | 'never'

interface IssueCodeInput {
  integrationId: string
  userId: string
  username: string
  scopes: TokenScope[]
  redirectUri: string
  hubUrl: string
  codeChallenge?: string
  /**
   * From the integration's `OauthIntegrationDescriptor.refreshTokenTtlSec`.
   * Baked into the CODE so it travels with the link: re-reading the descriptor
   * at refresh time would let an edit retroactively change the lifetime of a
   * grant the operator already consented to.
   */
  refreshTtlSec?: RefreshTtl
}

/**
 * PKCE S256 check (RFC 7636 §4.6): `BASE64URL(SHA256(verifier)) === challenge`.
 *
 * Keyed off the CLAIM, never off the descriptor: a code minted with a challenge
 * stays unusable without the verifier even if the integration later stops
 * requiring PKCE. Constant-time compare so a wrong verifier cannot be walked
 * byte by byte inside the code's 60 s window.
 */
export function verifyPkceS256(challenge: string, verifier: string | undefined): boolean {
  if (!verifier) return false
  const expected = Buffer.from(createHash('sha256').update(verifier).digest('base64url'))
  const actual = Buffer.from(challenge)
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}

interface TokenPair {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

interface VerifiedAccess {
  userId: string
  username: string
  scopes: TokenScope[]
}

/** OAuth account-linking grant logic. Pure over an injected sso-bridge
 *  signer so it is unit-testable without the capability registry.
 *
 *  Authorization codes are short-lived (60 s). The `redirectUri`,
 *  `integrationId`, and a unique `jti` are embedded in the signed JWT
 *  so the HMAC signature is the real security boundary. Single-use is
 *  enforced by a `jti` consumed-set. The old in-process `pendingCodes`
 *  Map is gone — a hub restart no longer breaks in-flight exchanges,
 *  only risking a single replay within the remaining 60 s TTL. */
export function createOauthGrants(
  ssoBridge: ISsoBridgeProvider,
  sessionManager: OauthSessionManager,
) {
  // Consumed jti set — maps jti → expiry timestamp (ms).
  // Entries are pruned after TTL['oauth-code'] seconds to bound memory.
  const consumedJtis = new Map<string, number>()

  const baseClaims = (userId: string, username: string, scopes: TokenScope[], hubUrl: string) => ({
    userId,
    username,
    isAdmin: false as const,
    scopes,
    hubUrl,
  })

  /**
   * The ACCESS token's hour is deliberately NOT configurable. It is the window
   * an operator must wait out after revoking a link (nothing re-reads the
   * session on the JWT path), so lengthening it would weaken revocation for
   * every integration; the refresh lifetime is the knob, because a refresh is
   * re-checked against the session every time it is used.
   */
  async function mintPair(
    userId: string,
    username: string,
    scopes: TokenScope[],
    hubUrl: string,
    sessionId: string,
    refreshTtl: RefreshTtl,
  ): Promise<TokenPair> {
    const access = await ssoBridge.signBridgeToken({
      claims: {
        ...baseClaims(userId, username, scopes, hubUrl),
        provider: 'oauth-access',
        sessionId,
      },
      ttlSec: TTL['oauth-access'],
    })
    const refresh = await ssoBridge.signBridgeToken({
      claims: {
        ...baseClaims(userId, username, scopes, hubUrl),
        provider: 'oauth-refresh',
        sessionId,
        // Carried on the token so the NEXT refresh re-mints with the same
        // lifetime instead of silently dropping back to the default.
        refreshTtl,
      },
      ttlSec: refreshTtl,
    })
    return {
      accessToken: access.token,
      refreshToken: refresh.token,
      expiresIn: TTL['oauth-access'],
    }
  }

  /** Read a lifetime off verified claims, ignoring anything malformed. */
  function readRefreshTtl(raw: unknown): RefreshTtl {
    if (raw === 'never') return 'never'
    if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw
    return DEFAULT_REFRESH_TTL_SEC
  }

  return {
    async oauthIssueCode(input: IssueCodeInput): Promise<{ code: string }> {
      const jti = randomUUID()
      const { token } = await ssoBridge.signBridgeToken({
        claims: {
          ...baseClaims(input.userId, input.username, input.scopes, input.hubUrl),
          provider: 'oauth-code',
          redirectUri: input.redirectUri,
          integrationId: input.integrationId,
          jti,
          ...(input.codeChallenge ? { codeChallenge: input.codeChallenge } : {}),
          ...(input.refreshTtlSec !== undefined ? { refreshTtl: input.refreshTtlSec } : {}),
        },
        ttlSec: TTL['oauth-code'],
      })
      return { code: token }
    },

    async oauthExchangeCode(input: {
      code: string
      redirectUri: string
      codeVerifier?: string
    }): Promise<TokenPair | null> {
      // Signature check is load-bearing: verify FIRST.
      const claims = await ssoBridge.verifyBridgeToken({ token: input.code })
      if (!claims || claims.provider !== 'oauth-code') return null

      // Binding check: redirectUri must match what was baked into the signed code.
      if (claims.redirectUri !== input.redirectUri) return null

      // PKCE: a code carrying a challenge is worthless without the verifier.
      // This is what replaces the client_secret for a public client whose
      // source is published — an intercepted code cannot be redeemed.
      const codeChallenge = claims.codeChallenge
      if (typeof codeChallenge === 'string' && codeChallenge !== '') {
        if (!verifyPkceS256(codeChallenge, input.codeVerifier)) return null
      }

      // jti single-use enforcement.
      const jti = claims.jti
      if (!jti) return null
      const expiryMs = Date.now() + TTL['oauth-code'] * 1000
      if (consumedJtis.has(jti)) return null
      consumedJtis.set(jti, expiryMs)
      setTimeout(() => {
        consumedJtis.delete(jti)
      }, TTL['oauth-code'] * 1000).unref?.()

      const scopes = (claims.scopes ?? []) as TokenScope[]
      const session = await sessionManager.create({
        userId: claims.userId,
        username: claims.username,
        integrationId:
          typeof claims.integrationId === 'string' ? claims.integrationId : '<unknown>',
        scopes,
      })
      return mintPair(
        claims.userId,
        claims.username,
        scopes,
        claims.hubUrl ?? '',
        session.id,
        readRefreshTtl(claims.refreshTtl),
      )
    },

    async oauthRefresh(input: { refreshToken: string }): Promise<TokenPair | null> {
      const claims = await ssoBridge.verifyBridgeToken({ token: input.refreshToken })
      if (!claims || claims.provider !== 'oauth-refresh') return null

      const sessionId = typeof claims.sessionId === 'string' ? claims.sessionId : null
      if (!sessionId) return null

      const session = await sessionManager.getById(sessionId)
      if (!session || session.revokedAt != null) return null

      await sessionManager.touch(sessionId)
      const scopes = (claims.scopes ?? []) as TokenScope[]
      return mintPair(
        claims.userId,
        claims.username,
        scopes,
        claims.hubUrl ?? '',
        sessionId,
        readRefreshTtl(claims.refreshTtl),
      )
    },

    async oauthVerifyAccessToken(input: { token: string }): Promise<VerifiedAccess | null> {
      const claims = await ssoBridge.verifyBridgeToken({ token: input.token })
      if (!claims || claims.provider !== 'oauth-access') return null

      const sessionId = typeof claims.sessionId === 'string' ? claims.sessionId : null
      if (!sessionId) return null

      const session = await sessionManager.getById(sessionId)
      if (!session || session.revokedAt != null) return null

      return {
        userId: claims.userId,
        username: claims.username,
        scopes: (claims.scopes ?? []) as TokenScope[],
      }
    },
  }
}
