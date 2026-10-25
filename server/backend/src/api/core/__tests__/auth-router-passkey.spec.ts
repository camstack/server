/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- mock factories cross typed boundaries */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createAuthRouter } from '../auth.router.js'
import { AuthService } from '../../../core/auth/auth.service.js'
import { staticJwtSigningKey } from '@camstack/system'

/**
 * Passkey (WebAuthn second-factor) login + self-enrollment tests for
 * `auth.router`. Mirrors the TOTP spec's harness. The passkey provider
 * is resolved cap-agnostically through the `user-passkeys` capability —
 * the mock registry exposes it via `getCollection('user-passkeys')`
 * (the in-process resolution branch), so no Moleculer proxy is needed.
 *
 * Covered contracts:
 *   • Passkey-as-second-factor is OPT-IN (default OFF): `login` reports
 *     `secondFactors: ['passkey']` (+ a challenge token) ONLY when the
 *     user has an enrolled passkey AND enabled the preference. Enrolled
 *     + preference off (or preference lookup failing) → straight session.
 *   • `login` reports both factors when the user has TOTP + opted-in passkey.
 *   • `getOwn`/`setOwnPasskeySecondFactorPreference` bind to `ctx.user.id`.
 *   • `loginBeginPasskey` returns assertion options for the challenged user.
 *   • `loginVerifyPasskey` mints the real session JWT on `verified: true`.
 *   • Failure paths: unverified assertion, forged/expired challenge,
 *     vanished user, no provider available.
 *   • Self-enrollment: begin/finish/list/remove bind to `ctx.user.id`.
 */

interface MockUser {
  id: string
  username: string
  isAdmin: boolean
  allowedProviders: string | string[]
  allowedDevices: Record<string, unknown>
  scopes: unknown[]
}

function makeUser(overrides: Partial<MockUser> = {}): MockUser {
  return {
    id: 'u-1',
    username: 'alice',
    isAdmin: false,
    allowedProviders: '*',
    allowedDevices: {},
    scopes: [],
    ...overrides,
  }
}

interface MockUserManagement {
  validateCredentials: ReturnType<typeof vi.fn>
  getTotpStatus: ReturnType<typeof vi.fn>
  verifyTotp: ReturnType<typeof vi.fn>
  listUsers: ReturnType<typeof vi.fn>
}

function makeUserMgmt(overrides: Partial<MockUserManagement> = {}): MockUserManagement {
  return {
    validateCredentials: vi.fn(),
    getTotpStatus: vi.fn(async () => ({ enabled: false, confirmedAt: null })),
    verifyTotp: vi.fn(async () => ({ valid: true })),
    listUsers: vi.fn(async () => [makeUser()]),
    ...overrides,
  }
}

interface MockPasskeyProvider {
  beginRegistration: ReturnType<typeof vi.fn>
  finishRegistration: ReturnType<typeof vi.fn>
  beginAuthentication: ReturnType<typeof vi.fn>
  finishAuthentication: ReturnType<typeof vi.fn>
  listPasskeys: ReturnType<typeof vi.fn>
  removePasskey: ReturnType<typeof vi.fn>
  getSecondFactorPreference: ReturnType<typeof vi.fn>
  setSecondFactorPreference: ReturnType<typeof vi.fn>
}

function makePasskeyProvider(overrides: Partial<MockPasskeyProvider> = {}): MockPasskeyProvider {
  return {
    beginRegistration: vi.fn(async () => ({ optionsJSON: { challenge: 'reg-chal' } })),
    finishRegistration: vi.fn(async () => ({ success: true as const, credentialId: 'cred-1' })),
    beginAuthentication: vi.fn(async () => ({ optionsJSON: { challenge: 'auth-chal' } })),
    finishAuthentication: vi.fn(async () => ({ verified: true })),
    listPasskeys: vi.fn(async () => []),
    removePasskey: vi.fn(async () => ({ success: true as const })),
    // Opt-in second factor — default OFF, mirroring the addon default.
    getSecondFactorPreference: vi.fn(async () => ({ enabled: false })),
    setSecondFactorPreference: vi.fn(async () => ({ success: true as const })),
    ...overrides,
  }
}

const ENROLLED_PASSKEY = {
  credentialId: 'cred-1',
  label: 'YubiKey',
  createdAt: 1,
  lastUsedAt: null,
  transports: [],
}

function makeConfig(overrides: Record<string, unknown> = {}): {
  get<T>(p: string): T
  update(s: string, d: Record<string, unknown>): void
} {
  const store: Record<string, unknown> = { ...overrides }
  return {
    get<T>(path: string): T {
      return store[path] as T
    },
    update(_section: string, _data: Record<string, unknown>): void {
      /* no-op */
    },
  }
}

function makeRegistry(
  userMgmt: MockUserManagement | null,
  passkeys: MockPasskeyProvider | null,
): { getSingleton: (name: string) => unknown | null; getCollection: (name: string) => unknown[] } {
  return {
    getSingleton: (name: string) => (name === 'user-management' ? userMgmt : null),
    getCollection: (name: string) => (name === 'user-passkeys' && passkeys ? [passkeys] : []),
  }
}

async function callProc(
  router: ReturnType<typeof createAuthRouter>,
  name: string,
  input: unknown,
  user?: { id: string; username: string; isAdmin: boolean },
): Promise<unknown> {
  const caller = router.createCaller({ user: user ?? null } as never)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = (caller as any)[name]
  return fn(input)
}

describe('auth.router — passkey second factor', () => {
  let auth: AuthService
  let userMgmt: MockUserManagement
  let passkeys: MockPasskeyProvider
  let registry: ReturnType<typeof makeRegistry>

  beforeEach(() => {
    auth = new AuthService(
      makeConfig() as never,
      undefined,
      staticJwtSigningKey('unit-test-secret'),
    )
    userMgmt = makeUserMgmt()
    passkeys = makePasskeyProvider()
    registry = makeRegistry(userMgmt, passkeys)
  })

  describe('login gate — passkey second factor is OPT-IN', () => {
    it('reports secondFactors: [passkey] (challenge token, requiresTotp:false) when a passkey is enrolled AND the preference is enabled', async () => {
      userMgmt.validateCredentials.mockResolvedValueOnce(makeUser())
      userMgmt.getTotpStatus.mockResolvedValueOnce({ enabled: false, confirmedAt: null })
      passkeys.listPasskeys.mockResolvedValueOnce([ENROLLED_PASSKEY])
      passkeys.getSecondFactorPreference.mockResolvedValueOnce({ enabled: true })

      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(router, 'login', { username: 'alice', password: 'pw' })) as {
        token: string
        requiresTotp?: boolean
        secondFactors?: string[]
      }

      expect(result.requiresTotp).toBe(false)
      expect(result.secondFactors).toEqual(['passkey'])
      expect(passkeys.getSecondFactorPreference).toHaveBeenCalledWith({ userId: 'u-1' })
      // The token is a challenge token, NOT a session.
      const claims = auth.verifyTotpChallengeToken(result.token)
      expect(claims?.userId).toBe('u-1')
    })

    it('mints a real session when a passkey is enrolled but the preference is OFF (the default)', async () => {
      userMgmt.validateCredentials.mockResolvedValueOnce(makeUser())
      userMgmt.getTotpStatus.mockResolvedValueOnce({ enabled: false, confirmedAt: null })
      passkeys.listPasskeys.mockResolvedValueOnce([ENROLLED_PASSKEY])
      // getSecondFactorPreference default mock → { enabled: false }

      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(router, 'login', { username: 'alice', password: 'pw' })) as {
        token: string
        requiresTotp?: boolean
        secondFactors?: string[]
      }

      expect(result.requiresTotp).toBe(false)
      expect(result.secondFactors ?? []).toEqual([])
      expect(auth.verifyToken(result.token).userId).toBe('u-1')
    })

    it('reports both factors when TOTP is enrolled and the passkey preference is enabled', async () => {
      userMgmt.validateCredentials.mockResolvedValueOnce(makeUser())
      userMgmt.getTotpStatus.mockResolvedValueOnce({ enabled: true, confirmedAt: Date.now() })
      passkeys.listPasskeys.mockResolvedValueOnce([ENROLLED_PASSKEY])
      passkeys.getSecondFactorPreference.mockResolvedValueOnce({ enabled: true })

      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(router, 'login', { username: 'alice', password: 'pw' })) as {
        requiresTotp?: boolean
        secondFactors?: string[]
      }

      expect(result.requiresTotp).toBe(true)
      expect(result.secondFactors).toEqual(['totp', 'passkey'])
    })

    it('reports ONLY totp when TOTP is enrolled and the passkey preference is off (TOTP behavior unchanged)', async () => {
      userMgmt.validateCredentials.mockResolvedValueOnce(makeUser())
      userMgmt.getTotpStatus.mockResolvedValueOnce({ enabled: true, confirmedAt: Date.now() })
      passkeys.listPasskeys.mockResolvedValueOnce([ENROLLED_PASSKEY])

      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(router, 'login', { username: 'alice', password: 'pw' })) as {
        requiresTotp?: boolean
        secondFactors?: string[]
      }

      expect(result.requiresTotp).toBe(true)
      expect(result.secondFactors).toEqual(['totp'])
    })

    it('mints a real session (no second factor) when neither TOTP nor passkey is enrolled', async () => {
      userMgmt.validateCredentials.mockResolvedValueOnce(makeUser())
      userMgmt.getTotpStatus.mockResolvedValueOnce({ enabled: false, confirmedAt: null })
      passkeys.listPasskeys.mockResolvedValueOnce([])

      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(router, 'login', { username: 'alice', password: 'pw' })) as {
        token: string
        requiresTotp?: boolean
        secondFactors?: string[]
      }

      expect(result.requiresTotp).toBe(false)
      expect(result.secondFactors ?? []).toEqual([])
      expect(auth.verifyToken(result.token).userId).toBe('u-1')
    })

    it('never queries the preference for a user with no enrolled passkey', async () => {
      userMgmt.validateCredentials.mockResolvedValueOnce(makeUser())
      userMgmt.getTotpStatus.mockResolvedValueOnce({ enabled: false, confirmedAt: null })
      passkeys.listPasskeys.mockResolvedValueOnce([])

      const router = createAuthRouter(auth, registry as never)
      await callProc(router, 'login', { username: 'alice', password: 'pw' })
      expect(passkeys.getSecondFactorPreference).not.toHaveBeenCalled()
    })

    it('does not block login when passkey introspection throws', async () => {
      userMgmt.validateCredentials.mockResolvedValueOnce(makeUser())
      userMgmt.getTotpStatus.mockResolvedValueOnce({ enabled: false, confirmedAt: null })
      passkeys.listPasskeys.mockRejectedValueOnce(new Error('transport down'))

      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(router, 'login', { username: 'alice', password: 'pw' })) as {
        token: string
        secondFactors?: string[]
      }
      expect(result.secondFactors ?? []).toEqual([])
      expect(auth.verifyToken(result.token).userId).toBe('u-1')
    })

    it('treats a failing preference lookup as OFF (login is never blocked)', async () => {
      userMgmt.validateCredentials.mockResolvedValueOnce(makeUser())
      userMgmt.getTotpStatus.mockResolvedValueOnce({ enabled: false, confirmedAt: null })
      passkeys.listPasskeys.mockResolvedValueOnce([ENROLLED_PASSKEY])
      passkeys.getSecondFactorPreference.mockRejectedValueOnce(new Error('transport down'))

      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(router, 'login', { username: 'alice', password: 'pw' })) as {
        token: string
        secondFactors?: string[]
      }
      expect(result.secondFactors ?? []).toEqual([])
      expect(auth.verifyToken(result.token).userId).toBe('u-1')
    })
  })

  describe('own second-factor preference (self-service)', () => {
    const sessionUser = { id: 'u-1', username: 'alice', isAdmin: false }

    it('getOwnPasskeySecondFactorPreference binds to the session user', async () => {
      passkeys.getSecondFactorPreference.mockResolvedValueOnce({ enabled: true })
      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(
        router,
        'getOwnPasskeySecondFactorPreference',
        undefined,
        sessionUser,
      )) as { enabled: boolean }
      expect(result).toEqual({ enabled: true })
      expect(passkeys.getSecondFactorPreference).toHaveBeenCalledWith({ userId: 'u-1' })
    })

    it('getOwnPasskeySecondFactorPreference degrades to disabled without a provider', async () => {
      const router = createAuthRouter(auth, makeRegistry(userMgmt, null) as never)
      const result = (await callProc(
        router,
        'getOwnPasskeySecondFactorPreference',
        undefined,
        sessionUser,
      )) as { enabled: boolean }
      expect(result).toEqual({ enabled: false })
    })

    it('setOwnPasskeySecondFactorPreference forwards the session userId + flag', async () => {
      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(
        router,
        'setOwnPasskeySecondFactorPreference',
        { enabled: true },
        sessionUser,
      )) as { success: true }
      expect(result.success).toBe(true)
      expect(passkeys.setSecondFactorPreference).toHaveBeenCalledWith({
        userId: 'u-1',
        enabled: true,
      })
    })

    it('setOwnPasskeySecondFactorPreference throws without a provider', async () => {
      const router = createAuthRouter(auth, makeRegistry(userMgmt, null) as never)
      await expect(
        callProc(router, 'setOwnPasskeySecondFactorPreference', { enabled: true }, sessionUser),
      ).rejects.toThrow(/Passkey management is not available/)
    })
  })

  describe('loginBeginPasskey', () => {
    it('returns assertion options for the challenged user', async () => {
      const challengeToken = auth.signTotpChallengeToken({
        userId: 'u-1',
        username: 'alice',
        isAdmin: false,
      })
      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(router, 'loginBeginPasskey', { challengeToken })) as {
        optionsJSON: Record<string, unknown>
      }
      expect(result.optionsJSON).toEqual({ challenge: 'auth-chal' })
      expect(passkeys.beginAuthentication).toHaveBeenCalledWith({ userId: 'u-1' })
    })

    it('rejects a forged/expired challenge token', async () => {
      const router = createAuthRouter(auth, registry as never)
      await expect(
        callProc(router, 'loginBeginPasskey', { challengeToken: 'not.a.jwt' }),
      ).rejects.toThrow(/Invalid or expired login challenge/)
    })

    it('throws when no user-passkeys provider is registered', async () => {
      const challengeToken = auth.signTotpChallengeToken({
        userId: 'u-1',
        username: 'alice',
        isAdmin: false,
      })
      const router = createAuthRouter(auth, makeRegistry(userMgmt, null) as never)
      await expect(callProc(router, 'loginBeginPasskey', { challengeToken })).rejects.toThrow(
        /Passkey authentication is not available/,
      )
    })
  })

  describe('loginVerifyPasskey', () => {
    it('mints the real session JWT when the assertion verifies', async () => {
      passkeys.finishAuthentication.mockResolvedValueOnce({ verified: true })
      userMgmt.listUsers.mockResolvedValueOnce([makeUser()])
      const challengeToken = auth.signTotpChallengeToken({
        userId: 'u-1',
        username: 'alice',
        isAdmin: false,
      })
      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(router, 'loginVerifyPasskey', {
        challengeToken,
        response: { id: 'cred-1' },
      })) as { token: string; requiresTotp?: boolean }

      expect(result.requiresTotp).toBe(false)
      expect(auth.verifyToken(result.token).userId).toBe('u-1')
    })

    it('rejects when the assertion does not verify', async () => {
      passkeys.finishAuthentication.mockResolvedValueOnce({ verified: false })
      const challengeToken = auth.signTotpChallengeToken({
        userId: 'u-1',
        username: 'alice',
        isAdmin: false,
      })
      const router = createAuthRouter(auth, registry as never)
      await expect(
        callProc(router, 'loginVerifyPasskey', { challengeToken, response: { id: 'x' } }),
      ).rejects.toThrow(/Passkey verification failed/)
    })

    it('rejects a forged challenge token (wrong secret)', async () => {
      const other = new AuthService(
        makeConfig() as never,
        undefined,
        staticJwtSigningKey('attacker'),
      )
      const forged = other.signTotpChallengeToken({
        userId: 'u-1',
        username: 'alice',
        isAdmin: true,
      })
      const router = createAuthRouter(auth, registry as never)
      await expect(
        callProc(router, 'loginVerifyPasskey', { challengeToken: forged, response: {} }),
      ).rejects.toThrow(/Invalid or expired login challenge/)
    })

    it('rejects when the user vanished between legs', async () => {
      passkeys.finishAuthentication.mockResolvedValueOnce({ verified: true })
      userMgmt.listUsers.mockResolvedValueOnce([])
      const challengeToken = auth.signTotpChallengeToken({
        userId: 'ghost',
        username: 'alice',
        isAdmin: false,
      })
      const router = createAuthRouter(auth, registry as never)
      await expect(
        callProc(router, 'loginVerifyPasskey', { challengeToken, response: { id: 'x' } }),
      ).rejects.toThrow(/User no longer exists/)
    })
  })

  describe('self-service enrollment', () => {
    const sessionUser = { id: 'u-1', username: 'alice', isAdmin: false }

    it('beginOwnPasskeyRegistration binds userId+username to the session', async () => {
      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(
        router,
        'beginOwnPasskeyRegistration',
        undefined,
        sessionUser,
      )) as { optionsJSON: Record<string, unknown> }
      expect(result.optionsJSON).toEqual({ challenge: 'reg-chal' })
      expect(passkeys.beginRegistration).toHaveBeenCalledWith({ userId: 'u-1', username: 'alice' })
    })

    it('finishOwnPasskeyRegistration forwards the label + session userId', async () => {
      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(
        router,
        'finishOwnPasskeyRegistration',
        { response: { id: 'cred-1' }, label: 'MacBook' },
        sessionUser,
      )) as { success: true; credentialId: string }
      expect(result.success).toBe(true)
      expect(passkeys.finishRegistration).toHaveBeenCalledWith({
        userId: 'u-1',
        response: { id: 'cred-1' },
        label: 'MacBook',
      })
    })

    it('listOwnPasskeys returns the session user credentials', async () => {
      passkeys.listPasskeys.mockResolvedValueOnce([
        {
          credentialId: 'cred-1',
          label: 'MacBook',
          createdAt: 1,
          lastUsedAt: null,
          transports: [],
        },
      ])
      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(
        router,
        'listOwnPasskeys',
        undefined,
        sessionUser,
      )) as unknown[]
      expect(result).toHaveLength(1)
      expect(passkeys.listPasskeys).toHaveBeenCalledWith({ userId: 'u-1' })
    })

    it('removeOwnPasskey binds the session userId', async () => {
      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(
        router,
        'removeOwnPasskey',
        {
          credentialId: 'cred-1',
          reauthToken: auth.signReauthToken({ userId: sessionUser.id, method: 'password' }),
        },
        sessionUser,
      )) as { success: true }
      expect(result.success).toBe(true)
      expect(passkeys.removePasskey).toHaveBeenCalledWith({ userId: 'u-1', credentialId: 'cred-1' })
    })
  })
})
