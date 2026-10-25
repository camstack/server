/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- mock factories cross typed boundaries */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TRPCError } from '@trpc/server'
import { createAuthRouter } from '../auth.router.js'
import { AuthService } from '../../../core/auth/auth.service.js'
import { staticJwtSigningKey } from '@camstack/system'

/**
 * Usernameless (passkey-FIRST) login tests for `auth.router` — the
 * `passkeyLoginBegin` / `passkeyLoginFinish` public procedures backing
 * the primary-stage login-method widget. Mirrors the second-factor
 * passkey spec's harness (in-process `getCollection('user-passkeys')`
 * resolution, no Moleculer proxy).
 *
 * Covered contracts:
 *   • `passkeyLoginBegin` proxies the provider's
 *     `beginDiscoverableAuthentication` (no user binding) and returns
 *     the assertion options.
 *   • `passkeyLoginFinish` mints the REAL session JWT for the
 *     credential-owning user on `verified: true` when no OTHER second
 *     factor remains. 2FA applies uniformly to every primary method:
 *     when the user has TOTP enrolled the finish leg returns the same
 *     challenge-token LoginResult shape `login` returns. The passkey
 *     itself is never re-demanded as a second factor on this path
 *     (re-proving the factor that just signed in adds nothing) — even
 *     when the passkey-2FA preference is opted in.
 *   • Failure paths: unverified assertion → UNAUTHORIZED, missing
 *     provider → clean error, vanished user, missing user-management.
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
  beginDiscoverableAuthentication: ReturnType<typeof vi.fn>
  finishDiscoverableAuthentication: ReturnType<typeof vi.fn>
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
    beginDiscoverableAuthentication: vi.fn(async () => ({
      optionsJSON: { challenge: 'disc-chal', allowCredentials: [] },
    })),
    finishDiscoverableAuthentication: vi.fn(async () => ({ verified: true, userId: 'u-1' })),
    listPasskeys: vi.fn(async () => []),
    removePasskey: vi.fn(async () => ({ success: true as const })),
    // Opt-in second factor — default OFF, mirroring the addon default.
    getSecondFactorPreference: vi.fn(async () => ({ enabled: false })),
    setSecondFactorPreference: vi.fn(async () => ({ success: true as const })),
    ...overrides,
  }
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
): Promise<unknown> {
  const caller = router.createCaller({ user: null } as never)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = (caller as any)[name]
  return fn(input)
}

describe('auth.router — usernameless (discoverable) passkey login', () => {
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

  describe('passkeyLoginBegin', () => {
    it('returns discoverable assertion options (no user binding)', async () => {
      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(router, 'passkeyLoginBegin', undefined)) as {
        optionsJSON: Record<string, unknown>
      }
      expect(result.optionsJSON).toEqual({ challenge: 'disc-chal', allowCredentials: [] })
      expect(passkeys.beginDiscoverableAuthentication).toHaveBeenCalledWith({})
    })

    it('throws a clean error when no user-passkeys provider is registered', async () => {
      const router = createAuthRouter(auth, makeRegistry(userMgmt, null) as never)
      await expect(callProc(router, 'passkeyLoginBegin', undefined)).rejects.toThrow(
        /Passkey authentication is not available/,
      )
    })
  })

  describe('passkeyLoginFinish', () => {
    it('mints the real session JWT for the credential-owning user', async () => {
      passkeys.finishDiscoverableAuthentication.mockResolvedValueOnce({
        verified: true,
        userId: 'u-1',
      })
      userMgmt.listUsers.mockResolvedValueOnce([makeUser({ scopes: ['scope-a'] })])
      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(router, 'passkeyLoginFinish', {
        response: { id: 'cred-1' },
      })) as {
        token: string
        user: { id: string; username: string; isAdmin: boolean }
        requiresTotp?: boolean
        secondFactors?: string[]
      }

      expect(passkeys.finishDiscoverableAuthentication).toHaveBeenCalledWith({
        response: { id: 'cred-1' },
      })
      expect(result.user).toEqual({ id: 'u-1', username: 'alice', isAdmin: false })
      expect(result.requiresTotp).toBe(false)
      // A REAL session, not a challenge token.
      expect(auth.verifyToken(result.token).userId).toBe('u-1')
    })

    it('bounces to the TOTP second-factor stage when TOTP is enrolled (2FA applies to every primary method)', async () => {
      userMgmt.getTotpStatus.mockResolvedValue({ enabled: true, confirmedAt: Date.now() })
      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(router, 'passkeyLoginFinish', {
        response: { id: 'cred-1' },
      })) as {
        token: string
        user: { id: string; username: string; isAdmin: boolean }
        requiresTotp?: boolean
        secondFactors?: string[]
      }

      expect(result.requiresTotp).toBe(true)
      expect(result.secondFactors).toEqual(['totp'])
      expect(result.user).toEqual({ id: 'u-1', username: 'alice', isAdmin: false })
      // A CHALLENGE token — not a session.
      const claims = auth.verifyTotpChallengeToken(result.token)
      expect(claims?.userId).toBe('u-1')
    })

    it('never re-demands the passkey as second factor — even when the preference is opted in', async () => {
      // The passkey already satisfied the primary factor; only OTHER
      // factors (TOTP) can remain. With TOTP off + passkey-2FA on, the
      // sign-in must complete in one step.
      userMgmt.getTotpStatus.mockResolvedValue({ enabled: false, confirmedAt: null })
      passkeys.listPasskeys.mockResolvedValue([{ credentialId: 'cred-1' }])
      passkeys.getSecondFactorPreference.mockResolvedValue({ enabled: true })
      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(router, 'passkeyLoginFinish', {
        response: { id: 'cred-1' },
      })) as { token: string; requiresTotp?: boolean; secondFactors?: string[] }

      expect(result.requiresTotp).toBe(false)
      expect(result.secondFactors ?? []).toEqual([])
      expect(auth.verifyToken(result.token).userId).toBe('u-1')
    })

    it('with TOTP + opted-in passkey-2FA, only totp remains after a passkey-first sign-in', async () => {
      userMgmt.getTotpStatus.mockResolvedValue({ enabled: true, confirmedAt: Date.now() })
      passkeys.listPasskeys.mockResolvedValue([{ credentialId: 'cred-1' }])
      passkeys.getSecondFactorPreference.mockResolvedValue({ enabled: true })
      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(router, 'passkeyLoginFinish', {
        response: { id: 'cred-1' },
      })) as { token: string; requiresTotp?: boolean; secondFactors?: string[] }

      expect(result.requiresTotp).toBe(true)
      expect(result.secondFactors).toEqual(['totp'])
    })

    it('the TOTP challenge minted by a passkey-first sign-in completes via loginVerifyTotp', async () => {
      userMgmt.getTotpStatus.mockResolvedValue({ enabled: true, confirmedAt: Date.now() })
      const router = createAuthRouter(auth, registry as never)
      const challenge = (await callProc(router, 'passkeyLoginFinish', {
        response: { id: 'cred-1' },
      })) as { token: string }

      userMgmt.verifyTotp.mockResolvedValueOnce({ valid: true })
      const session = (await callProc(router, 'loginVerifyTotp', {
        challengeToken: challenge.token,
        code: '123456',
      })) as { token: string }
      expect(auth.verifyToken(session.token).userId).toBe('u-1')
    })

    it('rejects an unverified assertion with UNAUTHORIZED', async () => {
      passkeys.finishDiscoverableAuthentication.mockResolvedValueOnce({
        verified: false,
        userId: null,
      })
      const router = createAuthRouter(auth, registry as never)
      const err = await callProc(router, 'passkeyLoginFinish', { response: { id: 'x' } }).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(TRPCError)
      expect((err as TRPCError).code).toBe('UNAUTHORIZED')
      expect((err as TRPCError).message).toMatch(/Passkey verification failed/)
    })

    it('rejects verified:true with a missing userId (defensive)', async () => {
      passkeys.finishDiscoverableAuthentication.mockResolvedValueOnce({
        verified: true,
        userId: null,
      })
      const router = createAuthRouter(auth, registry as never)
      const err = await callProc(router, 'passkeyLoginFinish', { response: { id: 'x' } }).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(TRPCError)
      expect((err as TRPCError).code).toBe('UNAUTHORIZED')
    })

    it('throws a clean error when no user-passkeys provider is registered', async () => {
      const router = createAuthRouter(auth, makeRegistry(userMgmt, null) as never)
      await expect(
        callProc(router, 'passkeyLoginFinish', { response: { id: 'x' } }),
      ).rejects.toThrow(/Passkey authentication is not available/)
    })

    it('rejects when the credential-owning user no longer exists', async () => {
      passkeys.finishDiscoverableAuthentication.mockResolvedValueOnce({
        verified: true,
        userId: 'ghost',
      })
      userMgmt.listUsers.mockResolvedValueOnce([])
      const router = createAuthRouter(auth, registry as never)
      await expect(
        callProc(router, 'passkeyLoginFinish', { response: { id: 'x' } }),
      ).rejects.toThrow(/User no longer exists/)
    })

    it('rejects when user-management is unavailable', async () => {
      const router = createAuthRouter(auth, makeRegistry(null, passkeys) as never)
      await expect(
        callProc(router, 'passkeyLoginFinish', { response: { id: 'x' } }),
      ).rejects.toThrow(/user-management/)
    })
  })
})
