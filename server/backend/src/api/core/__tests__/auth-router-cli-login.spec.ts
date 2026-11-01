/* eslint-disable @typescript-eslint/no-unsafe-assignment -- mock factories cross typed boundaries */
import { describe, it, expect, beforeEach } from 'vitest'
import { staticJwtSigningKey } from '@camstack/server/system'
import { createAuthRouter } from '../auth.router.js'
import { AuthService } from '../../../core/auth/auth.service.js'
import { CliApprovalService } from '../../../core/auth/cli-approval.service.js'
import { createAuthLimiters } from '../auth-limits.js'
import type { AuthenticatedAgent, TrpcContext } from '../../trpc/trpc.context.js'

const ALICE = {
  id: 'u-1',
  username: 'alice',
  isAdmin: false,
  allowedProviders: '*',
  allowedDevices: {},
  scopes: [],
}

function user(overrides: Partial<AuthenticatedAgent> = {}): AuthenticatedAgent {
  return {
    id: 'u-1',
    username: 'alice',
    isAdmin: false,
    permissions: { isAdmin: false, allowedProviders: '*', allowedDevices: {} },
    isApiKey: false,
    interactive: true,
    userDelegated: true,
    sessionId: 'sess-1',
    ...overrides,
  }
}

describe('auth.router — terminal sign-in approval (D988)', () => {
  let auth: AuthService
  let router: ReturnType<typeof createAuthRouter>
  let uid = 0
  let logs: { level: string; message: string; meta: unknown }[] = []
  const logger = {
    info: (message: string, o?: { meta?: unknown }) =>
      logs.push({ level: 'info', message, meta: o?.meta }),
    warn: (message: string, o?: { meta?: unknown }) =>
      logs.push({ level: 'warn', message, meta: o?.meta }),
    error: () => undefined,
    debug: () => undefined,
  }
  const anon = (): TrpcContext => ({
    user: null,
    req: {
      headers: { 'user-agent': 'camstack-cli' },
      socket: { remoteAddress: '127.0.0.1' },
    } as never,
  })
  const as = (u: AuthenticatedAgent) => router.createCaller({ user: u, req: anon().req })

  beforeEach(() => {
    auth = new AuthService(
      { get: () => undefined, update: () => undefined } as never,
      undefined,
      staticJwtSigningKey('unit-test-secret'),
    )
    router = createAuthRouter(
      auth,
      {
        getSingleton: (n: string) =>
          n === 'user-management' ? { listUsers: async () => [ALICE] } : null,
        getCollection: () => [],
      } as never,
      null,
      undefined,
      undefined,
      null,
      {
        cliApprovals: new CliApprovalService(),
        limiters: createAuthLimiters(),
        logger: logger as never,
      },
    )
    uid += 1
    logs = []
  })

  it('approve needs a fresh authentication', async () => {
    const begun = await router.createCaller(anon()).cliLoginBegin({ client: 'camstack-cli/1' })
    await expect(
      as(user({ id: `u-${uid}` })).cliLoginApprove({ userCode: begun.userCode }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('poll: pending, then approved mints once, then 401', async () => {
    const caller = router.createCaller(anon())
    const begun = await caller.cliLoginBegin({ client: 'camstack-cli/1' })
    expect(await caller.cliLoginPoll({ deviceSecret: begun.deviceSecret })).toMatchObject({
      status: 'pending',
    })
    const view = await as(user()).cliLoginDescribe({ userCode: begun.userCode.toLowerCase() })
    expect(view.client).toBe('camstack-cli/1')
    const reauthToken = auth.signReauthToken({
      userId: 'u-1',
      method: 'password',
      sessionId: 'sess-1',
    })
    await as(user()).cliLoginApprove({ userCode: begun.userCode, reauthToken })
    const done = await router
      .createCaller(anon())
      .cliLoginPoll({ deviceSecret: begun.deviceSecret })
    expect(done.status).toBe('approved')
    expect(done.session?.user.id).toBe('u-1')
    expect(auth.verifyToken(done.session?.token ?? '').userId).toBe('u-1')
    await expect(
      router.createCaller(anon()).cliLoginPoll({ deviceSecret: begun.deviceSecret }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('describe shows the observed User-Agent and the approver address; audit lines carry no code or secret', async () => {
    const caller = router.createCaller(anon())
    const begun = await caller.cliLoginBegin({ client: 'self-label' })
    const view = await as(user()).cliLoginDescribe({ userCode: begun.userCode })
    expect(view).toMatchObject({
      client: 'self-label',
      userAgent: 'camstack-cli',
      ip: '127.0.0.1',
      approverIp: '127.0.0.1',
    })
    const reauthToken = auth.signReauthToken({
      userId: 'u-1',
      method: 'password',
      sessionId: 'sess-1',
    })
    await as(user()).cliLoginApprove({ userCode: begun.userCode, reauthToken })
    await caller.cliLoginPoll({ deviceSecret: begun.deviceSecret })
    const approved = logs.filter((l) => /approved/.test(l.message))
    expect(approved.length).toBeGreaterThanOrEqual(2)
    for (const l of approved) {
      expect(l.meta).toMatchObject({ requestId: expect.any(String), ip: '127.0.0.1' })
    }
    const dump = JSON.stringify(logs)
    expect(dump).not.toContain(begun.deviceSecret)
    expect(dump).not.toContain(begun.userCode)
    expect(dump).not.toContain(begun.userCode.replace('-', ''))
  })

  it('deny is reported once; an unknown code is refused', async () => {
    const caller = router.createCaller(anon())
    const begun = await caller.cliLoginBegin()
    await as(user()).cliLoginDeny({ userCode: begun.userCode })
    expect((await caller.cliLoginPoll({ deviceSecret: begun.deviceSecret })).status).toBe('denied')
    await expect(as(user()).cliLoginDescribe({ userCode: 'ZZZZ-ZZZZ' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('a minted token cannot approve', async () => {
    await expect(
      as(user({ userDelegated: false, isApiKey: true })).cliLoginPending(),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('pending list carries no code', async () => {
    const begun = await router.createCaller(anon()).cliLoginBegin()
    const list = await as(user()).cliLoginPending()
    expect(list).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain(begun.userCode.replace('-', ''))
  })

  it('rate limits the operator side per user and begin per client', async () => {
    const me = as(user({ id: `rl-${uid}` }))
    let refused = 0
    for (let i = 0; i < 12; i += 1) {
      await me.cliLoginDescribe({ userCode: 'ZZZZ-ZZZZ' }).catch((e: { code?: string }) => {
        if (e.code === 'TOO_MANY_REQUESTS') refused += 1
      })
    }
    expect(refused).toBeGreaterThan(0)
    const caller = router.createCaller(anon())
    let blocked = 0
    for (let i = 0; i < 12; i += 1) {
      await caller.cliLoginBegin().catch((e: { code?: string }) => {
        if (e.code === 'TOO_MANY_REQUESTS') blocked += 1
      })
    }
    expect(blocked).toBeGreaterThan(0)
  })
})
