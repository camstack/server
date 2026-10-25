import type {
  CredentialTokenClaims,
  IScopedLogger,
  TokenPayload,
  TokenScope,
} from '@camstack/types'
import {
  CREDENTIAL_TOKEN_AUDIENCE,
  CredentialTokenClaimsSchema,
  isCredentialTokenPayload,
  SsoBridgeClaimsSchema,
} from '@camstack/types'
import * as bcrypt from 'bcryptjs'
import * as jwt from 'jsonwebtoken'
import type { z } from 'zod'
import { isSettingsReadUnavailable } from '../kernel/settings-read-error.js'
import { type JwtSigningKeySource, processJwtSigningKey } from './jwt-signing-key.js'
import { logTokenExpiryRejection, parseTokenExpiry } from './token-expiry.js'

/** Minimal no-op logger for default parameter */
const noopLogger: IScopedLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLogger
  },
  withTags() {
    return noopLogger
  },
}

export type { TokenPayload }

export type AuthConfigReader = {
  /**
   * `undefined` is part of the contract, not an accident: a reader answers
   * only the paths it can (`local-auth` pre-resolves a fixed set; a
   * `ConfigManager` falls through to RUNTIME_DEFAULTS and then to nothing).
   * Every consumer here must handle the absent case explicitly.
   */
  get<T>(path: string): T | undefined
  update(section: string, data: Record<string, unknown>): void
}

export class AuthManager {
  private readonly logger: IScopedLogger
  /**
   * Offending `auth.tokenExpiry` values already reported by this instance.
   *
   * `signToken` re-reads the setting on EVERY mint so an operator's change
   * takes effect without a restart — which also means a bad value would log
   * once per login and once per silent refresh from every viewer. The refusal
   * must be visible, not repeated: the first mint after a bad save logs, the
   * rest resolve silently to the same default until the value changes.
   */
  private readonly reportedInvalidExpiries = new Set<string>()

  /**
   * @param signingKey where the session signing key comes from — the process
   *   slot `local-auth` fills from the keychain (D797). Never config, never
   *   env; read on every mint and verify, and it THROWS while unavailable.
   */
  constructor(
    private readonly config: AuthConfigReader,
    logger: IScopedLogger = noopLogger,
    private readonly signingKey: JwtSigningKeySource = processJwtSigningKey,
  ) {
    this.logger = logger
  }

  /** The current signing key; throws `JwtSigningKeyUnavailableError` while there is none. */
  private get jwtSecret(): string {
    return this.signingKey.current()
  }

  /**
   * @param options.expiresInSec an explicit lifetime (a session's access
   *   token): wins over `auth.tokenExpiry`, bounded to at least one minute.
   */
  signToken(
    payload: Omit<TokenPayload, 'iat' | 'exp'>,
    options: { readonly expiresInSec?: number } = {},
  ): string {
    if (options.expiresInSec !== undefined) {
      const seconds = Math.max(60, Math.floor(options.expiresInSec))
      return jwt.sign({ ...payload }, this.jwtSecret, { expiresIn: seconds })
    }
    // Honour the operator-configured lifetime (System → Settings →
    // Authentication → `auth.tokenExpiry`, e.g. `30d`). Read on every mint,
    // so a change takes effect on the next login/refresh with no restart.
    //
    // The value is a free-text box that reaches `jwt.sign`, so it goes
    // through `parseTokenExpiry` first: a malformed value would otherwise
    // THROW here and turn every login into a 500, and a bare number would be
    // read as milliseconds. A refused value logs once and falls back to
    // DEFAULT_TOKEN_EXPIRY — never to an unbounded lifetime.
    const configured = this.readConfiguredExpiry()
    const parsed = parseTokenExpiry(configured)
    if (!parsed.ok) {
      const seen = typeof configured === 'string' ? configured : JSON.stringify(configured)
      if (!this.reportedInvalidExpiries.has(seen)) {
        this.reportedInvalidExpiries.add(seen)
        logTokenExpiryRejection(configured, parsed, this.logger)
      }
    }
    return jwt.sign({ ...payload }, this.jwtSecret, { expiresIn: parsed.seconds })
  }

  /**
   * The operator's `auth.tokenExpiry`, or `undefined` → DEFAULT_TOKEN_EXPIRY.
   *
   * On the hub this reader is `ConfigService`, which answers the key from its
   * boot-time mirror of the settings store and REFUSES while that mirror is
   * unknown (pending or failed, D675). A login must not fail over it, so the
   * refusal signs with the default — and says so once per reason, because a
   * mint that silently ignored a saved lifetime is the defect this setting
   * already had once.
   */
  private readConfiguredExpiry(): string | undefined {
    try {
      return this.config.get<string>('auth.tokenExpiry')
    } catch (err: unknown) {
      if (!isSettingsReadUnavailable(err)) throw err
      const key = `unreadable:${err.reason}`
      if (!this.reportedInvalidExpiries.has(key)) {
        this.reportedInvalidExpiries.add(key)
        this.logger.warn(
          'auth.tokenExpiry could not be read from the settings store — signing with the default lifetime',
          { meta: { reason: err.reason, error: err.message } },
        )
      }
      return undefined
    }
  }

  /**
   * Sign a unified token (D892). No `exp`: the token's row — read by `jti` on
   * every verify for revocation — holds its one expiry. The claims are parsed
   * before signing, so nothing outside the schema is ever signed.
   */
  signCredentialToken(claims: CredentialTokenClaims): string {
    return jwt.sign(CredentialTokenClaimsSchema.parse(claims), this.jwtSecret, {
      audience: CREDENTIAL_TOKEN_AUDIENCE,
    })
  }

  /**
   * Verify a session-family JWT: a login session, an account link, a bridge or
   * challenge token. A MINTED token is refused here even though it carries a
   * valid signature (D895): every surface that calls this wants a person's
   * session, and a share link or a script's token must never pass for one.
   * Minted tokens verify only through {@link verifyCredentialToken}.
   */
  verifyToken(token: string): TokenPayload {
    const payload = jwt.verify(token, this.jwtSecret)
    if (isCredentialTokenPayload(payload)) {
      throw new Error('A minted token is not a session credential')
    }
    // Documented type boundary: the claims are whatever this hub signed.
    return payload as TokenPayload
  }

  /** Verify a minted token (`auth.mintToken`): its signature AND its audience. Throws when invalid. */
  verifyCredentialToken(token: string): CredentialTokenClaims {
    const payload = jwt.verify(token, this.jwtSecret, { audience: CREDENTIAL_TOKEN_AUDIENCE })
    const claims = CredentialTokenClaimsSchema.safeParse(payload)
    if (!claims.success) throw new Error('Not a minted token')
    return claims.data
  }

  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 10)
  }

  async comparePassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash)
  }

  // ── Note: scoped-token validation moved to the user-management cap
  // singleton (capabilityRegistry.getSingleton('user-management')).
  // The legacy `setScopedTokenManager` / `validateScopedToken` bridge
  // existed but was never wired up — addon-upload.ts goes straight
  // to the cap registry now. Path consolidation done 2026-05-11.

  /**
   * Mint a short-lived HMAC-signed bridge token used by SSO-style auth
   * providers (OIDC, SAML, …) to hand the post-callback
   * claims to `/api/auth/sso/finish` without trusting unsigned query
   * parameters. The endpoint verifies the token signature with the same
   * `jwtSecret` and only then mints the user session JWT. This closes
   * the privilege-escalation gap where any client could craft a
   * `?isAdmin=1` link to `/sso/finish` and become admin.
   *
   * The payload carries `kind: 'sso-bridge'` so `verifySsoBridgeToken`
   * can reject session tokens reused as bridge tokens (and vice versa).
   * TTL defaults to 5 minutes — long enough to survive the IdP
   * redirect bounce, short enough that a leaked URL stops being useful
   * before the operator notices.
   */
  signSsoBridgeToken(payload: SsoBridgeClaims, ttlSec: number | 'never' = 300): string {
    const body: Record<string, unknown> = {
      kind: 'sso-bridge',
      userId: payload.userId,
      username: payload.username,
      isAdmin: payload.isAdmin,
      provider: payload.provider,
      ...(payload.email !== undefined ? { email: payload.email } : {}),
      ...(payload.displayName !== undefined ? { displayName: payload.displayName } : {}),
      ...(payload.hubUrl !== undefined ? { hubUrl: payload.hubUrl } : {}),
      ...(payload.scopes !== undefined ? { scopes: payload.scopes } : {}),
      ...(payload.redirectUri !== undefined ? { redirectUri: payload.redirectUri } : {}),
      ...(payload.integrationId !== undefined ? { integrationId: payload.integrationId } : {}),
      ...(payload.jti !== undefined ? { jti: payload.jti } : {}),
      ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
      ...(payload.refreshTtl !== undefined ? { refreshTtl: payload.refreshTtl } : {}),
      ...(payload.linkIntent !== undefined ? { linkIntent: payload.linkIntent } : {}),
      ...(payload.issuer !== undefined ? { issuer: payload.issuer } : {}),
      ...(payload.browserBinding !== undefined ? { browserBinding: payload.browserBinding } : {}),
      ...(payload.app !== undefined ? { app: payload.app } : {}),
    }
    /**
     * `'never'` mints with NO `exp` claim, and the option must be OMITTED to do
     * that — `jwt.sign(body, secret, { expiresIn: undefined })` throws
     * `"expiresIn" should be a number of seconds or string representing a
     * timespan`, so a "no expiry" routed through the numeric path would fail at
     * mint time and break account linking instead of producing an eternal
     * token. `jwt.verify` accepts a token without `exp` and simply performs no
     * expiry check (verified against jsonwebtoken directly, 2026-08-09).
     *
     * The bound on such a token is REVOCATION, not time: `oauthRefresh` and
     * `oauthVerifyAccessToken` both re-read the session and refuse once
     * `revokedAt` is set. That path is the only thing standing between a leaked
     * eternal refresh token and permanent access — see D103.
     */
    if (ttlSec === 'never') return jwt.sign(body, this.jwtSecret)
    return jwt.sign(body, this.jwtSecret, { expiresIn: ttlSec })
  }

  /**
   * Verify + decode a bridge token minted by `signSsoBridgeToken`.
   * Returns `null` for invalid signature, expired token, or wrong
   * `kind` claim. Never throws — the consumer ( `/sso/finish`) treats
   * `null` as 400 Bad Request.
   */
  verifySsoBridgeToken(token: string): SsoBridgeClaims | null {
    try {
      const decoded = jwt.verify(token, this.jwtSecret) as Record<string, unknown>
      if (decoded['kind'] !== 'sso-bridge') return null
      const userId = decoded['userId']
      const username = decoded['username']
      const isAdmin = decoded['isAdmin']
      const provider = decoded['provider']
      if (
        typeof userId !== 'string' ||
        typeof username !== 'string' ||
        typeof isAdmin !== 'boolean' ||
        typeof provider !== 'string'
      ) {
        return null
      }
      const email = typeof decoded['email'] === 'string' ? decoded['email'] : undefined
      const displayName =
        typeof decoded['displayName'] === 'string' ? decoded['displayName'] : undefined
      const hubUrl = typeof decoded['hubUrl'] === 'string' ? decoded['hubUrl'] : undefined
      const scopes = Array.isArray(decoded['scopes'])
        ? (decoded['scopes'] as TokenScope[])
        : undefined
      const redirectUri =
        typeof decoded['redirectUri'] === 'string' ? decoded['redirectUri'] : undefined
      const integrationId =
        typeof decoded['integrationId'] === 'string' ? decoded['integrationId'] : undefined
      const jti = typeof decoded['jti'] === 'string' ? decoded['jti'] : undefined
      const sessionId = typeof decoded['sessionId'] === 'string' ? decoded['sessionId'] : undefined
      const linkIntent =
        typeof decoded['linkIntent'] === 'string' ? decoded['linkIntent'] : undefined
      const issuer = typeof decoded['issuer'] === 'string' ? decoded['issuer'] : undefined
      const browserBinding =
        typeof decoded['browserBinding'] === 'string' ? decoded['browserBinding'] : undefined
      // A native-app bridge (D858) must keep its `app` claim: dropping it would
      // turn an app bridge into a web bridge. A present-but-malformed claim
      // refuses the whole token rather than being ignored.
      const appParsed = SsoBridgeClaimsSchema.shape.app.safeParse(decoded['app'])
      if (!appParsed.success) return null
      const app = appParsed.data
      const rawRefreshTtl = decoded['refreshTtl']
      const refreshTtl =
        rawRefreshTtl === 'never' || (typeof rawRefreshTtl === 'number' && rawRefreshTtl > 0)
          ? rawRefreshTtl
          : undefined
      return {
        userId,
        username,
        isAdmin,
        provider,
        ...(email !== undefined ? { email } : {}),
        ...(displayName !== undefined ? { displayName } : {}),
        ...(hubUrl !== undefined ? { hubUrl } : {}),
        ...(scopes !== undefined ? { scopes } : {}),
        ...(redirectUri !== undefined ? { redirectUri } : {}),
        ...(integrationId !== undefined ? { integrationId } : {}),
        ...(jti !== undefined ? { jti } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(refreshTtl !== undefined ? { refreshTtl } : {}),
        ...(linkIntent !== undefined ? { linkIntent } : {}),
        ...(issuer !== undefined ? { issuer } : {}),
        ...(browserBinding !== undefined ? { browserBinding } : {}),
        ...(app !== undefined ? { app } : {}),
      }
    } catch {
      return null
    }
  }

  /**
   * Mint a TOTP challenge token bridging the two-step login flow:
   *
   *   1. POST /login → password OK + user has 2FA  →  returns
   *      `{requiresTotp: true, challengeToken: '...'}` (this token).
   *   2. POST /login/totp-verify → operator types 6-digit code →
   *      server verifies challenge token + code → mints the real
   *      session JWT.
   *
   * The token carries `kind: 'totp-challenge'` so it can't be confused
   * with a regular session token, plus the `userId` + `username` +
   * `isAdmin` claims that will end up in the final session if the code
   * verifies. TTL defaults to 5 minutes — long enough to type the code,
   * short enough that an abandoned login can't be picked up later.
   */
  signTotpChallengeToken(payload: TotpChallengeClaims, ttlSec: number = 300): string {
    return jwt.sign(
      {
        kind: 'totp-challenge',
        userId: payload.userId,
        username: payload.username,
        isAdmin: payload.isAdmin,
        ...(payload.method !== undefined ? { method: payload.method } : {}),
      },
      this.jwtSecret,
      { expiresIn: ttlSec },
    )
  }

  /**
   * A short-lived proof that the signed-in user just re-entered their password
   * or used a passkey. Sensitive self-service actions (linking a sign-in
   * account, disabling 2FA, removing a passkey, minting an admin token)
   * require one. `kind: 'reauth'` keeps it from ever being a bearer.
   */
  signReauthToken(claims: ReauthClaims, ttlSec: number = REAUTH_TTL_SEC): string {
    return jwt.sign(
      {
        kind: 'reauth',
        userId: claims.userId,
        method: claims.method,
        ...(claims.sessionId !== undefined ? { sid: claims.sessionId } : {}),
      },
      this.jwtSecret,
      { expiresIn: ttlSec },
    )
  }

  /** Decode a re-authentication proof, or `null` (forged, expired, another kind). */
  verifyReauthToken(token: string): ReauthClaims | null {
    try {
      const decoded = jwt.verify(token, this.jwtSecret) as Record<string, unknown>
      if (decoded['kind'] !== 'reauth') return null
      const userId = decoded['userId']
      const method = decoded['method']
      const sid = decoded['sid']
      if (typeof userId !== 'string' || (method !== 'password' && method !== 'passkey')) {
        return null
      }
      return { userId, method, ...(typeof sid === 'string' ? { sessionId: sid } : {}) }
    } catch {
      return null
    }
  }

  /**
   * Verify + decode a TOTP challenge token. Returns `null` for any
   * failure (invalid signature, expired, wrong `kind`, missing
   * claims). The caller MUST also verify the 6-digit code against
   * `totpManager.verify(userId, code)` before minting the real
   * session — this method validates the bridge transport only.
   */
  verifyTotpChallengeToken(token: string): TotpChallengeClaims | null {
    try {
      const decoded = jwt.verify(token, this.jwtSecret) as Record<string, unknown>
      if (decoded['kind'] !== 'totp-challenge') return null
      const userId = decoded['userId']
      const username = decoded['username']
      const isAdmin = decoded['isAdmin']
      if (
        typeof userId !== 'string' ||
        typeof username !== 'string' ||
        typeof isAdmin !== 'boolean'
      ) {
        return null
      }
      const method = decoded['method']
      return {
        userId,
        username,
        isAdmin,
        ...(method === 'password' || method === 'passkey' || method === 'sso' ? { method } : {}),
      }
    } catch {
      return null
    }
  }
}

/** Seconds a re-authentication proof lasts (`signReauthToken`). */
export const REAUTH_TTL_SEC = 300

/** What a re-authentication proof says: who proved it, from which session, how. */
export interface ReauthClaims {
  readonly userId: string
  /** The login session it was proved in — a proof is spent only there. */
  readonly sessionId?: string
  readonly method: 'password' | 'passkey'
}

/**
 * Derived from the cap schema rather than restated.
 *
 * This was a hand-written interface duplicating `SsoBridgeClaimsSchema`, and it
 * had already drifted: `codeChallenge` — the field that makes PKCE mandatory at
 * exchange — was in the schema and absent here, so the claim travelled through
 * a type that did not know it existed. That is the failure mode the repo's
 * `z.infer<>`-never-duplicate-a-shape rule exists to stop.
 */
export type SsoBridgeClaims = z.infer<typeof SsoBridgeClaimsSchema>

export interface TotpChallengeClaims {
  readonly userId: string
  readonly username: string
  readonly isAdmin: boolean
  /** The primary factor the user already proved — recorded on the session it leads to. */
  readonly method?: 'password' | 'passkey' | 'sso'
}
