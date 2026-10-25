/* eslint-disable @typescript-eslint/no-unsafe-assignment -- mock factories cross typed boundaries */
import { staticJwtSigningKey } from '@camstack/system'
import { describe, expect, it, vi } from 'vitest'
import { AuthService } from '../../../core/auth/auth.service.js'
import type { TrpcContext } from '../../trpc/trpc.context.js'
import { createAuthLimiters } from '../auth-limits.js'
import { createAuthRouter } from '../auth.router.js'

/**
 * Rate-limit buckets of the public auth surface (security plan §5.2):
 * per REAL client address behind the tunnel, and per account on failures.
 */

const ALICE = {
  id: 'u-alice',
  username: 'alice',
  isAdmin: false,
  allowedProviders: '*' as const,
  allowedDevices: {},
  scopes: [],
}

function makeAuth(): AuthService {
  return new AuthService(
    { get: () => undefined, update: () => undefined } as never,
    undefined,
    staticJwtSigningKey('rate-limit-secret'),
  )
}

function setup() {
  const userMgmt = {
    validateCredentials: vi.fn(async (input: { username: string; password: string }) =>
      input.username === 'alice' && input.password === 'right'
        ? { ...ALICE, totpEnabled: false }
        : null,
    ),
    getTotpStatus: vi.fn(async () => ({ enabled: false, confirmedAt: null })),
    listUsers: vi.fn(async () => [ALICE]),
  }
  const registry = {
    getSingleton: (name: string) => (name === 'user-management' ? userMgmt : null),
    getCollection: () => [],
    getCollectionEntries: () => [],
    isProviderDisabled: () => false,
  }
  const router = createAuthRouter(makeAuth(), registry as never, null, undefined, undefined, null, {
    limiters: createAuthLimiters(() => 1_000),
  })
  return { router, userMgmt }
}

/** A request that came through the Cloudflare tunnel from `client`. */
function tunnelled(client: string): TrpcContext {
  return {
    user: null,
    req: {
      headers: { 'cf-connecting-ip': client },
      socket: { remoteAddress: '127.0.0.1' },
    } as never,
  }
}

describe('auth rate limits', () => {
  it('per client: one remote client hitting the limit does not lock out another (the tunnel)', async () => {
    const { router } = setup()
    const attacker = router.createCaller(tunnelled('203.0.113.1'))
    for (let i = 0; i < 10; i++) {
      await expect(attacker.login({ username: 'bob', password: 'x' })).rejects.toThrow()
    }
    await expect(attacker.login({ username: 'bob', password: 'x' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    })
    const victim = router.createCaller(tunnelled('198.51.100.2'))
    await expect(victim.login({ username: 'alice', password: 'right' })).resolves.toMatchObject({
      user: { id: 'u-alice' },
    })
  })

  it('per account: failures from MANY addresses lock that account, and only that account', async () => {
    const { router, userMgmt } = setup()
    for (let i = 0; i < 20; i++) {
      const caller = router.createCaller(tunnelled(`203.0.113.${i + 1}`))
      await expect(caller.login({ username: 'alice', password: 'wrong' })).rejects.toThrow(
        /Invalid credentials/,
      )
    }
    const fresh = router.createCaller(tunnelled('198.51.100.9'))
    const calls = userMgmt.validateCredentials.mock.calls.length
    // Locked: refused BEFORE the password is checked, even the right one.
    await expect(fresh.login({ username: 'ALICE', password: 'right' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    })
    expect(userMgmt.validateCredentials.mock.calls.length).toBe(calls)
    // Another account is untouched.
    await expect(fresh.login({ username: 'bob', password: 'x' })).rejects.toThrow(
      /Invalid credentials/,
    )
  })

  it("per account: the owner's successful logins never spend the failure bucket", async () => {
    const { router } = setup()
    for (let i = 0; i < 25; i++) {
      const caller = router.createCaller(tunnelled(`198.51.100.${i + 1}`))
      await expect(caller.login({ username: 'alice', password: 'right' })).resolves.toBeDefined()
    }
  })
})
