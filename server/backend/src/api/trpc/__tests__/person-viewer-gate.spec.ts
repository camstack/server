/**
 * A person (interactive session) is an admin or a viewer (D921, amended).
 * A non-admin with no viewer row is refused a viewer-labelled method, and
 * the refusal is logged once. A viewer with `allow: '*'` and a block cannot
 * reach that device or its child. An API token with a device scope still can.
 *
 * Disarm: stop reducing a person's scopes in `protectedProcedure` — the
 * category row reaches `snapshot.getSnapshot` again and the first test fails.
 */
import type { CredentialScope } from '@camstack/types'
import { describe, expect, it, beforeEach } from 'vitest'
import { z } from 'zod'
import type { AuthenticatedAgent, TrpcContext, TrpcContextLogger } from '../trpc.context.js'
import type { DeviceScopeLookup } from '../scope-access.js'
import { protectedProcedure, trpcRouter } from '../trpc.middleware.js'
import { resetPersonWithoutViewerLog } from '../person-without-viewer.js'

const CAMERA = 5
const SIREN = 7
const OTHER = 9

const lookup: DeviceScopeLookup = {
  getAncestors: (id) => (id === SIREN ? [CAMERA] : []),
  getType: (id) => (id === CAMERA || id === SIREN || id === OTHER ? 'camera' : null),
  getLocation: () => null,
}

const testRouter = trpcRouter({
  snapshot: trpcRouter({
    getSnapshot: protectedProcedure
      .input(z.object({ deviceId: z.number() }))
      .query(({ input }) => ({ deviceId: input.deviceId })),
  }),
})

function user(
  over: Partial<AuthenticatedAgent> & { readonly scopes: readonly CredentialScope[] },
): AuthenticatedAgent {
  return {
    id: 'u-1',
    username: 'ada',
    isAdmin: false,
    permissions: { isAdmin: false, allowedProviders: '*', allowedDevices: {} },
    isApiKey: false,
    interactive: true,
    ...over,
  }
}

function caller(principal: AuthenticatedAgent, logger?: TrpcContextLogger) {
  const ctx: TrpcContext = {
    user: principal,
    deviceScopeLookup: lookup,
    ...(logger !== undefined ? { logger } : {}),
  }
  return testRouter.createCaller(ctx)
}

describe('a person is decided by the viewer row alone', () => {
  beforeEach(() => resetPersonWithoutViewerLog())

  it('a non-admin with no viewer row is refused a viewer-labelled method, logged once', async () => {
    const warns: { message: string; tags?: { userId?: string } }[] = []
    const logger: TrpcContextLogger = {
      warn: (message, options) => {
        warns.push({ message, ...(options?.tags !== undefined ? { tags: options.tags } : {}) })
      },
    }
    const principal = user({
      id: 'u-legacy',
      scopes: [
        { type: 'category', target: 'device', access: ['view', 'create', 'delete'] },
        { type: 'addon-routes', access: ['view', 'create', 'delete'] },
      ],
    })
    const c = caller(principal, logger)
    await expect(c.snapshot.getSnapshot({ deviceId: OTHER })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(c.snapshot.getSnapshot({ deviceId: OTHER })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    expect(warns).toEqual([
      {
        message: 'auth: a person with no viewer grant was refused',
        tags: { userId: 'u-legacy' },
      },
    ])
  })

  it('a viewer with allow * and a block cannot reach that device or its child, and can reach another', async () => {
    const principal = user({
      scopes: [{ type: 'viewer', allow: '*', block: [CAMERA], features: [] }],
    })
    const c = caller(principal)
    await expect(c.snapshot.getSnapshot({ deviceId: CAMERA })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(c.snapshot.getSnapshot({ deviceId: SIREN })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(c.snapshot.getSnapshot({ deviceId: OTHER })).resolves.toEqual({ deviceId: OTHER })
  })

  it('an API token with a device scope still reaches that device', async () => {
    const principal = user({
      id: 'token:cam',
      username: 'token:cam',
      isApiKey: true,
      interactive: false,
      scopes: [{ type: 'device', selector: { kind: 'ids', ids: [CAMERA] }, access: ['view'] }],
    })
    const c = caller(principal)
    await expect(c.snapshot.getSnapshot({ deviceId: CAMERA })).resolves.toEqual({
      deviceId: CAMERA,
    })
    await expect(c.snapshot.getSnapshot({ deviceId: OTHER })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })
})
