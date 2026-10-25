/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- mock factories cross typed boundaries */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createAuthRouter } from '../auth.router.js'
import { AuthService } from '../../../core/auth/auth.service.js'
import { staticJwtSigningKey } from '@camstack/system'

/**
 * Two-phase TOTP login flow tests for `auth.router`. Focus on the
 * cap-router contracts the SDK + admin-ui depend on:
 *
 *   • `login` returns `requiresTotp: true` + a short-lived challenge
 *     token when the user has TOTP enrolled.
 *   • `login` returns a regular session token when the user has NO
 *     TOTP (backwards compat).
 *   • `loginVerifyTotp` validates the challenge token + code and
 *     mints the real session JWT.
 *   • Failure paths: wrong code, expired/forged challenge, missing
 *     user, missing user-management cap.
 */

interface MockUser {
  id: string
  username: string
  isAdmin: boolean
  passwordHash: string
  allowedProviders: string | string[]
  allowedDevices: Record<string, unknown>
  scopes: unknown[]
}

interface MockUserManagement {
  validateCredentials: ReturnType<typeof vi.fn>
  getTotpStatus: ReturnType<typeof vi.fn>
  verifyTotp: ReturnType<typeof vi.fn>
  listUsers: ReturnType<typeof vi.fn>
}

function makeUser(overrides: Partial<MockUser> = {}): MockUser {
  return {
    id: 'u-1',
    username: 'alice',
    isAdmin: false,
    passwordHash: 'hashed',
    allowedProviders: '*',
    allowedDevices: {},
    scopes: [],
    ...overrides,
  }
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

function makeRegistry(userMgmt: MockUserManagement): {
  getSingleton: (name: string) => unknown | null
  getCollection: (name: string) => unknown[]
} {
  return {
    getSingleton: (name: string) => (name === 'user-management' ? userMgmt : null),
    // No passkey provider registered in the TOTP-only harness.
    getCollection: () => [],
  }
}

/** Invoke a tRPC procedure directly via the router's internal API. */
async function callProc(
  router: ReturnType<typeof createAuthRouter>,
  name: 'login' | 'loginVerifyTotp',
  input: unknown,
): Promise<unknown> {
  const caller = router.createCaller({} as never)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = (caller as any)[name]
  return fn(input)
}

describe('auth.router — TOTP gate', () => {
  let auth: AuthService
  let userMgmt: MockUserManagement
  let registry: ReturnType<typeof makeRegistry>

  beforeEach(() => {
    auth = new AuthService(
      makeConfig() as never,
      undefined,
      staticJwtSigningKey('unit-test-secret'),
    )
    userMgmt = makeUserMgmt()
    registry = makeRegistry(userMgmt)
  })

  describe('login (phase 1)', () => {
    it('returns a regular session token + requiresTotp:false when user has NO TOTP', async () => {
      const u = makeUser()
      userMgmt.validateCredentials.mockResolvedValueOnce(u)
      userMgmt.getTotpStatus.mockResolvedValueOnce({ enabled: false, confirmedAt: null })

      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(router, 'login', { username: 'alice', password: 'pw' })) as {
        token: string
        user: { id: string; username: string; isAdmin: boolean }
        requiresTotp?: boolean
      }

      expect(result.requiresTotp).toBe(false)
      expect(result.user).toEqual({ id: 'u-1', username: 'alice', isAdmin: false })
      // The token verifies as a regular session token (NOT a challenge).
      const verified = auth.verifyToken(result.token)
      expect(verified.userId).toBe('u-1')
      // verifyTotpChallengeToken should NOT recognize a regular session token.
      expect(auth.verifySsoBridgeToken(result.token)).toBeNull()
    })

    it('returns a challenge token + requiresTotp:true when user HAS TOTP', async () => {
      const u = makeUser()
      userMgmt.validateCredentials.mockResolvedValueOnce(u)
      userMgmt.getTotpStatus.mockResolvedValueOnce({ enabled: true, confirmedAt: Date.now() })

      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(router, 'login', { username: 'alice', password: 'pw' })) as {
        token: string
        user: { id: string; username: string; isAdmin: boolean }
        requiresTotp?: boolean
      }

      expect(result.requiresTotp).toBe(true)
      // The challenge token MUST NOT verify as a session JWT — it has
      // `kind: 'totp-challenge'` and the standard verifyToken expects
      // the session shape (it'd throw or return garbage).
      const challengeClaims = auth.verifyTotpChallengeToken(result.token)
      expect(challengeClaims).not.toBeNull()
      expect(challengeClaims!.userId).toBe('u-1')
      expect(challengeClaims!.isAdmin).toBe(false)
    })

    it('rejects invalid credentials', async () => {
      userMgmt.validateCredentials.mockResolvedValueOnce(null)
      const router = createAuthRouter(auth, registry as never)
      await expect(
        callProc(router, 'login', { username: 'alice', password: 'wrong' }),
      ).rejects.toThrow('Invalid credentials')
    })

    it('throws when user-management cap is unregistered (boot failure)', async () => {
      const emptyRegistry = { getSingleton: () => null } as never
      const router = createAuthRouter(auth, emptyRegistry)
      await expect(
        callProc(router, 'login', { username: 'alice', password: 'pw' }),
      ).rejects.toThrow(/user-management.*capability not registered/)
    })

    it('falls through to session-token branch when getTotpStatus method is absent (older user-mgmt builds)', async () => {
      const u = makeUser()
      const legacyMgmt = {
        validateCredentials: vi.fn().mockResolvedValueOnce(u),
        // getTotpStatus deliberately undefined
        verifyTotp: vi.fn(),
        listUsers: vi.fn(),
      }
      const router = createAuthRouter(auth, makeRegistry(legacyMgmt as never) as never)
      const result = (await callProc(router, 'login', { username: 'alice', password: 'pw' })) as {
        requiresTotp?: boolean
      }
      expect(result.requiresTotp).toBe(false)
    })
  })

  describe('loginVerifyTotp (phase 2)', () => {
    it('mints the real session JWT when challenge + code are both valid', async () => {
      const u = makeUser({ scopes: [{ type: 'category', target: 'storage', access: ['view'] }] })
      userMgmt.verifyTotp.mockResolvedValueOnce({ valid: true })
      userMgmt.listUsers.mockResolvedValueOnce([u])

      const challengeToken = auth.signTotpChallengeToken({
        userId: u.id,
        username: u.username,
        isAdmin: u.isAdmin,
      })

      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(router, 'loginVerifyTotp', {
        challengeToken,
        code: '123456',
      })) as {
        token: string
        user: { id: string; username: string; isAdmin: boolean }
        requiresTotp?: boolean
      }

      expect(result.requiresTotp).toBe(false)
      expect(result.user.id).toBe('u-1')
      // Session JWT verifies + carries the user's scopes snapshot.
      const decoded = auth.verifyToken(result.token)
      expect(decoded.userId).toBe('u-1')
    })

    it('rejects an invalid/expired challenge token', async () => {
      const router = createAuthRouter(auth, registry as never)
      await expect(
        callProc(router, 'loginVerifyTotp', { challengeToken: 'not.a.real.jwt', code: '123456' }),
      ).rejects.toThrow(/Invalid or expired TOTP challenge/)
    })

    it('rejects a forged challenge token (signed with wrong secret)', async () => {
      const other = new AuthService(
        makeConfig() as never,
        undefined,
        staticJwtSigningKey('attacker-secret'),
      )
      const forged = other.signTotpChallengeToken({
        userId: 'u-1',
        username: 'alice',
        isAdmin: true,
      })
      const router = createAuthRouter(auth, registry as never)
      await expect(
        callProc(router, 'loginVerifyTotp', { challengeToken: forged, code: '000000' }),
      ).rejects.toThrow(/Invalid or expired TOTP challenge/)
    })

    it('rejects a session token reused as a challenge token (wrong kind)', async () => {
      const sessionTok = auth.signToken({
        userId: 'u-1',
        username: 'alice',
        isAdmin: true,
        allowedProviders: '*',
        allowedDevices: {},
      })
      const router = createAuthRouter(auth, registry as never)
      await expect(
        callProc(router, 'loginVerifyTotp', { challengeToken: sessionTok, code: '000000' }),
      ).rejects.toThrow(/Invalid or expired TOTP challenge/)
    })

    it('rejects a wrong 6-digit code', async () => {
      userMgmt.verifyTotp.mockResolvedValueOnce({ valid: false })
      const challengeToken = auth.signTotpChallengeToken({
        userId: 'u-1',
        username: 'alice',
        isAdmin: false,
      })
      const router = createAuthRouter(auth, registry as never)
      await expect(
        callProc(router, 'loginVerifyTotp', { challengeToken, code: '000000' }),
      ).rejects.toThrow(/Invalid TOTP code/)
    })

    it('rejects when the user vanishes between legs (deleted concurrently)', async () => {
      userMgmt.verifyTotp.mockResolvedValueOnce({ valid: true })
      // The fresh listUsers() call returns nothing — user was deleted.
      userMgmt.listUsers.mockResolvedValueOnce([])
      const challengeToken = auth.signTotpChallengeToken({
        userId: 'ghost',
        username: 'alice',
        isAdmin: false,
      })
      const router = createAuthRouter(auth, registry as never)
      await expect(
        callProc(router, 'loginVerifyTotp', { challengeToken, code: '123456' }),
      ).rejects.toThrow(/User no longer exists/)
    })

    it('uses the FRESHLY fetched user record (scope changes pick up immediately)', async () => {
      // Issue challenge for u-1 with empty scopes (the in-token snapshot).
      const challengeToken = auth.signTotpChallengeToken({
        userId: 'u-1',
        username: 'alice',
        isAdmin: false,
      })
      // Between the two legs, an admin granted u-1 a new scope.
      userMgmt.verifyTotp.mockResolvedValueOnce({ valid: true })
      userMgmt.listUsers.mockResolvedValueOnce([
        makeUser({ scopes: [{ type: 'category', target: 'addon', access: ['view'] }] }),
      ])
      const router = createAuthRouter(auth, registry as never)
      const result = (await callProc(router, 'loginVerifyTotp', {
        challengeToken,
        code: '123456',
      })) as { token: string }
      const decoded = auth.verifyToken(result.token)
      // The fresh scope is in the minted session JWT, not the snapshot
      // from the (potentially stale) password leg.
      const scopes = (decoded as { scopes?: unknown[] }).scopes
      expect(scopes).toHaveLength(1)
    })
  })
})
