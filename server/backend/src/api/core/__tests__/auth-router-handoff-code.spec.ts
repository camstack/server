/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- mock factories cross typed boundaries */
import { describe, it, expect, beforeEach } from 'vitest'
import { createAuthRouter } from '../auth.router.js'
import { AuthService } from '../../../core/auth/auth.service.js'
import {
  HandoffCodeService,
  HANDOFF_CODE_PREFIX,
  HANDOFF_CODE_TTL_MS,
} from '../../../core/auth/handoff-code.service.js'
import { staticJwtSigningKey } from '@camstack/system'
import type { AuthenticatedAgent, TrpcContext } from '../../trpc/trpc.context.js'

/**
 * `auth.createHandoffCode` / `auth.redeemHandoffCode` — one-time
 * native-app login handoff (Phase 2). Router-level contract over a REAL
 * HandoffCodeService with a controllable clock.
 */

interface MockUserRecord {
  id: string
  username: string
  isAdmin: boolean
  allowedProviders: string
  allowedDevices: Record<string, unknown>
  scopes: unknown[]
}

function makeUserRecord(overrides: Partial<MockUserRecord> = {}): MockUserRecord {
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

function makeRegistry(users: MockUserRecord[]): {
  getSingleton: (name: string) => unknown
  getCollection: (name: string) => unknown[]
} {
  return {
    getSingleton: (name: string) =>
      name === 'user-management' ? { listUsers: async () => users } : null,
    getCollection: () => [],
  }
}

function makeConfig(): { get<T>(p: string): T; update(): void } {
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

function makeSessionUser(overrides: Partial<AuthenticatedAgent> = {}): AuthenticatedAgent {
  return {
    id: 'u-1',
    username: 'alice',
    isAdmin: false,
    permissions: { isAdmin: false, allowedProviders: '*', allowedDevices: {} },
    isApiKey: false,
    interactive: true,
    userDelegated: true,
    // A real session: a `renew` code continues the session it was minted from.
    sessionId: 'sess-1',
    ...overrides,
  }
}

function makeClock(start = 5_000_000) {
  const state = { now: start }
  return {
    now: () => state.now,
    advance: (ms: number) => {
      state.now += ms
    },
  }
}

describe('auth.router — handoff codes', () => {
  let auth: AuthService
  let clock: ReturnType<typeof makeClock>
  let router: ReturnType<typeof createAuthRouter>

  beforeEach(() => {
    auth = new AuthService(
      makeConfig() as never,
      undefined,
      staticJwtSigningKey('unit-test-secret'),
    )
    clock = makeClock()
    router = createAuthRouter(
      auth,
      makeRegistry([makeUserRecord(), makeUserRecord({ id: 'u-2', username: 'bob' })]) as never,
      null,
      new HandoffCodeService(clock.now),
    )
  })

  function caller(user: AuthenticatedAgent | null) {
    const ctx: TrpcContext = { user }
    return router.createCaller(ctx)
  }

  it('mint (protected) → redeem (public) round-trips into a session for the minting user', async () => {
    const minted = await caller(makeSessionUser()).createHandoffCode()
    expect(minted.code.startsWith(HANDOFF_CODE_PREFIX)).toBe(true)
    expect(minted.expiresAt).toBe(clock.now() + HANDOFF_CODE_TTL_MS)

    const result = await caller(null).redeemHandoffCode({ code: minted.code })
    expect(result.user).toEqual({ id: 'u-1', username: 'alice', isAdmin: false })
    const payload = auth.verifyToken(result.token)
    expect(payload.userId).toBe('u-1')
    expect(payload.isAdmin).toBe(false)
  })

  it('a code is single-use — the second redeem is UNAUTHORIZED', async () => {
    const minted = await caller(makeSessionUser()).createHandoffCode()
    await caller(null).redeemHandoffCode({ code: minted.code })
    await expect(caller(null).redeemHandoffCode({ code: minted.code })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })

  it('an expired code is UNAUTHORIZED', async () => {
    const minted = await caller(makeSessionUser()).createHandoffCode()
    clock.advance(HANDOFF_CODE_TTL_MS + 1)
    await expect(caller(null).redeemHandoffCode({ code: minted.code })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })

  it('a wrong / forged code is UNAUTHORIZED', async () => {
    await caller(makeSessionUser()).createHandoffCode()
    await expect(
      caller(null).redeemHandoffCode({ code: `${HANDOFF_CODE_PREFIX}${'f'.repeat(64)}` }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('the code is bound to the CALLING user, not any ambient state', async () => {
    const mintedByBob = await caller(
      makeSessionUser({ id: 'u-2', username: 'bob' }),
    ).createHandoffCode()
    const result = await caller(null).redeemHandoffCode({ code: mintedByBob.code })
    expect(result.user.id).toBe('u-2')
  })

  it('createHandoffCode requires authentication', async () => {
    await expect(caller(null).createHandoffCode()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })

  it('minted-token callers cannot mint — a restricted token must not self-upgrade', async () => {
    await expect(
      caller(
        makeSessionUser({ isApiKey: true, interactive: false, userDelegated: false }),
      ).createHandoffCode(),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('share-view token callers cannot mint', async () => {
    const shareUser = makeSessionUser({
      isApiKey: true,
      interactive: false,
      userDelegated: false,
      scopes: [{ type: 'share-view', grant: { kind: 'grid-view', deviceIds: [1] } }],
    })
    await expect(caller(shareUser).createHandoffCode()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('redeem for a user deleted after mint is UNAUTHORIZED', async () => {
    const bare = createAuthRouter(
      auth,
      makeRegistry([]) as never,
      null,
      new HandoffCodeService(clock.now),
    )
    const minted = await bare.createCaller({ user: makeSessionUser() }).createHandoffCode()
    await expect(
      bare.createCaller({ user: null }).redeemHandoffCode({ code: minted.code }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })
})
