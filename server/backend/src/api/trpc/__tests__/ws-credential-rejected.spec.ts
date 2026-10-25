/**
 * A WebSocket that presents a bearer resolving to NO principal (revoked,
 * expired) is flagged so the hub closes it with `session-ended`; a socket with
 * no bearer at all (the login screen) is not. Disarm: drop the
 * `credentialRejected` line in `createWsTrpcContext` and the first claim fails.
 */
import type { CreateWSSContextFnOptions } from '@trpc/server/adapters/ws'
import { describe, expect, it } from 'vitest'
import type { AddonRegistryService } from '../../../core/addon/addon-registry.service.js'
import type { AuthService } from '../../../core/auth/auth.service.js'
import { createWsTrpcContext } from '../trpc.context.js'

const authService = {
  verifyToken: (): never => {
    throw new Error('Session is no longer valid (session-revoked)')
  },
  checkSession: () => null,
}

async function contextWith(token: string | undefined) {
  const opts = {
    info: { connectionParams: token === undefined ? {} : { token } },
    req: { headers: {}, url: '/trpc' },
    res: {},
  }
  // The factory reads only `info` and `req`; the cast is the test-double boundary.
  return createWsTrpcContext(
    opts as unknown as CreateWSSContextFnOptions,
    authService as unknown as AuthService,
    {} as AddonRegistryService,
  )
}

describe('createWsTrpcContext - a refused credential', () => {
  it('flags a socket whose bearer resolves to nobody', async () => {
    const ctx = await contextWith('a-revoked-session-jwt')
    expect(ctx.user).toBeNull()
    expect(ctx.credentialRejected).toBe(true)
  })

  it('does not flag a socket that presented no bearer', async () => {
    const ctx = await contextWith(undefined)
    expect(ctx.user).toBeNull()
    expect(ctx.credentialRejected).toBeUndefined()
  })
})
