/* eslint-disable @typescript-eslint/consistent-type-assertions -- test mocks cross typed service boundaries */
/**
 * A bearer that is not an ACCESS CREDENTIAL authenticates nothing on `/trpc`.
 *
 * The hole this pins. Every token this hub mints verifies under the same
 * `auth.jwtSecret`, so `verifyToken` succeeding means "we minted this", never
 * "this is an API credential" (D103). `/addon/:addonId/*` learned that on
 * 2026-08-09 and refuses a non-credential outright via `gateAddonJwt`; `/trpc`
 * did not. An `oauth-code` — 60 seconds, single-use, and it travels in a
 * browser REDIRECT URL where it lands in history, referrers and proxy logs —
 * resolved to a full principal carrying the link's consented scopes, and so did
 * a 30-day `oauth-refresh` that belongs to `POST /oauth/token` and nowhere
 * else. Both were an authenticated hub session for as long as they lived.
 *
 * The allowlist, and why each entry is on the side it is on:
 *
 *   • `session` (no `kind` claim) — every real credential this hub hands a
 *     human or a machine: `auth.login`'s JWT, the SSO-minted session from
 *     `/api/auth/sso/finish`. ALLOWED.
 *   • `integration` (`kind: 'sso-bridge'`, `provider: 'oauth-access'`) — the
 *     account-link credential. This IS the Home Assistant component's bearer on
 *     `/trpc`; refusing it would break every linked integration. ALLOWED.
 *   • `not-a-credential` — everything else: `oauth-code`, `oauth-refresh`, any
 *     other `sso-bridge` provider (`oidc`, `magic-link`: those travel as
 *     `?bridge=` to `/api/auth/sso/finish`, never as a bearer), and
 *     `kind: 'totp-challenge'`. REFUSED.
 *
 * TOTP is the constraint that had to be checked before refusing, and it holds:
 * the challenge token is a procedure INPUT (`loginVerifyTotp({ challengeToken,
 * code })`) on a PUBLIC rate-limited procedure, never an `Authorization`
 * header. The SDK is explicit about it — `login()` calls `setToken` only when
 * `!requiresSecondFactor` — and the admin UI hands the challenge straight to
 * `verifyTotp` without storing it. The last test here proves it end-to-end
 * through the real router: the challenge resolves to NO principal and the
 * second leg still mints the session.
 *
 * Neutralisation: delete the `not-a-credential` branch in `resolveUser` and the
 * first three tests flip back to a full principal.
 */
import { describe, expect, it, type Mock, vi } from 'vitest'
import type { AddonRegistryService } from '../../../core/addon/addon-registry.service.js'
import { AuthService } from '../../../core/auth/auth.service.js'
import { createAuthRouter } from '../../core/auth.router.js'
import { createTrpcContext, type TrpcContextLogger, type TrpcRequest } from '../trpc.context.js'
import { staticJwtSigningKey } from '@camstack/system'

/** The grant an `oauth-code` carries — the same set the link is consented at. */
const LINK_GRANT = [
  { type: 'category', target: 'device', access: ['view', 'create'] },
  { type: 'capability', target: 'device-manager', access: ['view'] },
] as const

function fakeRegistry(
  users: readonly { id: string; isAdmin: boolean; scopes?: unknown }[] = [],
): AddonRegistryService {
  return {
    getPersistedAncestors: () => [],
    getPersistedType: () => null,
    getPersistedLocation: () => null,
    getPersistedDeviceList: () => [],
    getCapabilityRegistry: () => ({
      getSingleton: (name: string) =>
        name === 'user-management' ? { listUsers: async () => users } : undefined,
    }),
  } as unknown as AddonRegistryService
}

function reqWithBearer(token: string): TrpcRequest {
  return { headers: { authorization: `Bearer ${token}` } } as unknown as TrpcRequest
}

/** An AuthService stand-in that verifies exactly one payload. */
function fakeAuth(payload: Record<string, unknown>): AuthService {
  return { verifyToken: () => payload } as unknown as AuthService
}

function spyLogger(): { warn: Mock<TrpcContextLogger['warn']> } {
  return { warn: vi.fn<TrpcContextLogger['warn']>() }
}

describe('/trpc refuses a bearer that is not an access credential', () => {
  it('refuses an oauth-code — single-use, 60s, and it rides in a redirect URL', async () => {
    const logger = spyLogger()
    const ctx = await createTrpcContext(
      reqWithBearer('code-token'),
      fakeAuth({
        kind: 'sso-bridge',
        provider: 'oauth-code',
        userId: 'u-linker',
        username: 'apocaliss92',
        isAdmin: false,
        redirectUri: 'https://ha.local/auth/external/callback',
        integrationId: 'homeassistant',
        scopes: LINK_GRANT,
      }),
      fakeRegistry(),
      logger,
    )
    expect(ctx.user).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        meta: expect.objectContaining({ reason: 'bridge token provider=oauth-code' }),
      }),
    )
  })

  it('refuses an oauth-refresh — it belongs to POST /oauth/token', async () => {
    const logger = spyLogger()
    const ctx = await createTrpcContext(
      reqWithBearer('refresh-token'),
      fakeAuth({
        kind: 'sso-bridge',
        provider: 'oauth-refresh',
        sessionId: '711f4882-f75c-4153-a508-01bdc5b8391e',
        userId: 'u-linker',
        username: 'apocaliss92',
        isAdmin: false,
        scopes: LINK_GRANT,
      }),
      fakeRegistry(),
      logger,
    )
    expect(ctx.user).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        meta: expect.objectContaining({ reason: 'bridge token provider=oauth-refresh' }),
      }),
    )
  })

  it('refuses a totp-challenge and an SSO hand-off bridge token', async () => {
    const challenge = await createTrpcContext(
      reqWithBearer('challenge'),
      // Exactly what `signTotpChallengeToken` signs. `isAdmin: true` is the
      // point: leg 1 mints this after the PASSWORD alone, and an admin
      // principal bypasses the scope matcher entirely — so accepting it made
      // the second factor optional for anyone willing to send leg 1's token as
      // a bearer instead of typing a code.
      fakeAuth({ kind: 'totp-challenge', userId: 'u-1', username: 'alice', isAdmin: true }),
      fakeRegistry(),
      spyLogger(),
    )
    expect(challenge.user).toBeNull()

    // `oidc` / `magic-link` bridges travel as `?bridge=` to
    // `/api/auth/sso/finish`, which swaps them for a real session. As a
    // bearer they are nothing.
    for (const provider of ['oidc', 'magic-link', 'saml']) {
      const ctx = await createTrpcContext(
        reqWithBearer('bridge'),
        fakeAuth({ kind: 'sso-bridge', provider, userId: 'u-1', username: 'alice', isAdmin: true }),
        fakeRegistry(),
        spyLogger(),
      )
      expect(ctx.user).toBeNull()
    }
  })

  it('a refusal never falls back to the store — an admin claim buys nothing', async () => {
    const ctx = await createTrpcContext(
      reqWithBearer('code-token'),
      // A forged-looking `isAdmin: true` on a code: the refusal is on the
      // token's KIND, so the claim is never read.
      fakeAuth({ kind: 'sso-bridge', provider: 'oauth-code', userId: 'u-1', isAdmin: true }),
      fakeRegistry([{ id: 'u-1', isAdmin: true, scopes: [] }]),
      spyLogger(),
    )
    expect(ctx.user).toBeNull()
  })
})

describe('/trpc still admits every real credential', () => {
  it('an ordinary session JWT passes', async () => {
    const ctx = await createTrpcContext(
      reqWithBearer('session-token'),
      fakeAuth({ userId: 'u-session', username: 'bob', isAdmin: false, scopes: [] }),
      fakeRegistry([{ id: 'u-session', isAdmin: false, scopes: [] }]),
      spyLogger(),
    )
    expect(ctx.user).toMatchObject({ id: 'u-session', username: 'bob', isAdmin: false })
  })

  it('an oauth-access account-link token passes, with its grant intact', async () => {
    const ctx = await createTrpcContext(
      reqWithBearer('access-token'),
      fakeAuth({
        kind: 'sso-bridge',
        provider: 'oauth-access',
        sessionId: '711f4882-f75c-4153-a508-01bdc5b8391e',
        userId: 'u-linker',
        username: 'apocaliss92',
        isAdmin: false,
        scopes: LINK_GRANT,
      }),
      fakeRegistry([{ id: 'u-linker', isAdmin: true, scopes: [] }]),
      spyLogger(),
    )
    expect(ctx.user?.scopes).toEqual(LINK_GRANT)
    expect(ctx.user?.credential).toBe('oauth-access')
  })

  it('a JWT claiming the removed `api_key` type is NOT an API key — no keyId identity, no isApiKey', async () => {
    const legacy = await createTrpcContext(
      reqWithBearer('api-key-token'),
      fakeAuth({
        keyId: 'key-1',
        username: 'ci',
        isAdmin: false,
        type: 'api_key',
        scopes: [],
      } as never),
      fakeRegistry([]),
      spyLogger(),
    )
    expect(legacy.user?.id).not.toBe('key-1')
    expect(legacy.user?.isApiKey).toBe(false)
  })
})

describe('the TOTP login is unaffected — the challenge never travels as a bearer', () => {
  function makeConfig(): { get<T>(p: string): T; update(s: string, d: object): void } {
    const store: Record<string, unknown> = {}
    return {
      get<T>(path: string): T {
        return store[path] as T
      },
      update(): void {
        /* no-op */
      },
    }
  }

  it('login → challenge → loginVerifyTotp mints the session with NO principal in context', async () => {
    const auth = new AuthService(
      makeConfig() as never,
      undefined,
      staticJwtSigningKey('unit-test-secret'),
    )
    const user = {
      id: 'u-1',
      username: 'alice',
      isAdmin: false,
      allowedProviders: '*',
      allowedDevices: {},
      scopes: [],
    }
    const userMgmt = {
      validateCredentials: async () => user,
      getTotpStatus: async () => ({ enabled: true, confirmedAt: Date.now() }),
      verifyTotp: async () => ({ valid: true }),
      listUsers: async () => [user],
    }
    const router = createAuthRouter(auth, {
      getSingleton: (n: string) => (n === 'user-management' ? userMgmt : null),
      // No passkey provider in this harness — TOTP is the only factor.
      getCollection: () => [],
    } as never)
    const caller = router.createCaller({ user: null } as never)

    const leg1 = await caller.login({ username: 'alice', password: 'pw' })
    expect(leg1.requiresTotp).toBe(true)

    // The challenge presented as a BEARER authenticates nothing…
    const asBearer = await createTrpcContext(
      reqWithBearer(leg1.token),
      auth,
      fakeRegistry([user]),
      spyLogger(),
    )
    expect(asBearer.user).toBeNull()

    // …and the second leg does not care, because it reads the challenge from
    // its INPUT on an unauthenticated procedure.
    const leg2 = await caller.loginVerifyTotp({ challengeToken: leg1.token, code: '123456' })
    expect(leg2.requiresTotp).toBe(false)
    expect(auth.verifyToken(leg2.token).userId).toBe('u-1')

    // And the session it minted DOES authenticate.
    const session = await createTrpcContext(
      reqWithBearer(leg2.token),
      auth,
      fakeRegistry([user]),
      spyLogger(),
    )
    expect(session.user).toMatchObject({ id: 'u-1', username: 'alice' })
  })
})
