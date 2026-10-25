import { describe, expect, it } from 'vitest'
import { createAuthNetworkPolicy, TRUSTED_NETWORKS_KEY } from '../../../auth/auth-network-policy.js'
import { sessionHarness } from '../../../auth/__tests__/session-test-harness.js'
import type { TrpcContext } from '../../trpc/trpc.context.js'
import { createAuthLimiters } from '../auth-limits.js'
import { createAuthRouter } from '../auth.router.js'

/**
 * Opt-in: a login made DIRECTLY from a trusted network may skip its second
 * factor — never one that came through the tunnel or a proxy — and every
 * skip is audited.
 */

function setup(trustedNetworks: readonly string[]) {
  const users = [{ id: 'u-alice', username: 'alice', isAdmin: false, password: 'pw-alice-1' }]
  const h = sessionHarness(users)
  // Alice has TOTP enrolled.
  Object.assign(h.userManagement, {
    getTotpStatus: async () => ({ enabled: true, confirmedAt: 1 }),
  })
  const network = createAuthNetworkPolicy((key) =>
    key === TRUSTED_NETWORKS_KEY ? trustedNetworks : undefined,
  )
  const router = createAuthRouter(h.auth, h.registry as never, null, undefined, undefined, null, {
    network,
    sessions: h.backing,
    limiters: createAuthLimiters(),
  })
  const from = (peer: string, headers: Record<string, string> = {}) => {
    const ctx: TrpcContext = {
      user: null,
      req: { headers, socket: { remoteAddress: peer } } as never,
    }
    return router.createCaller(ctx)
  }
  return { ...h, from }
}

const LOGIN = { username: 'alice', password: 'pw-alice-1' }

describe('trusted-network second-factor skip', () => {
  it('OFF by default: TOTP is asked even from the LAN', async () => {
    const h = setup([])
    const result = await h.from('192.168.1.40').login(LOGIN)
    expect(result.secondFactors).toEqual(['totp'])
  })

  it('a DIRECT login from the trusted network gets a session — and the skip is audited', async () => {
    const h = setup(['192.168.1.0/24'])
    const result = await h.from('192.168.1.40').login(LOGIN)
    expect(result.secondFactors).toBeUndefined()
    expect(h.auth.verifyToken(result.token).sid).toBeDefined()
    const audit = await h.auditLog.list()
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      action: 'second-factor-skipped',
      userId: 'u-alice',
      ip: '192.168.1.40',
      detail: { method: 'password', factors: 'totp' },
    })
  })

  it('SECURITY: refused through the tunnel, even when the forwarded client is on the list', async () => {
    const h = setup(['192.168.1.0/24'])
    const result = await h
      .from('127.0.0.1', { 'cf-connecting-ip': '192.168.1.40', 'x-forwarded-for': '192.168.1.40' })
      .login(LOGIN)
    expect(result.secondFactors).toEqual(['totp'])
    expect(await h.auditLog.list()).toHaveLength(0)
  })

  it('SECURITY: a forged X-Forwarded-For from outside never makes a trusted address', async () => {
    const h = setup(['192.168.1.0/24'])
    const result = await h.from('203.0.113.9', { 'x-forwarded-for': '192.168.1.40' }).login(LOGIN)
    expect(result.secondFactors).toEqual(['totp'])
  })

  it('from outside the listed network the factor is asked', async () => {
    const h = setup(['192.168.1.0/24'])
    expect((await h.from('192.168.2.40').login(LOGIN)).secondFactors).toEqual(['totp'])
  })
})
