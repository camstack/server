/* eslint-disable @typescript-eslint/consistent-type-assertions -- test doubles cross typed service boundaries */
/**
 * D895: the pre-D892 opaque formats authenticate NOBODY — not on tRPC, not on
 * an addon route or data plane, not on an upload, not on whoami — even when
 * their rows are still on disk and live (the operator drops them by hand;
 * nothing reads them).
 *
 * The world below is the one D892 accepted them in: the user-management
 * provider still answers `validateScopedToken` and `adminTokens.validate` for
 * a live scoped and admin token, and a share store answers a live share link
 * (each in its old opaque format, spelled from parts below). On the old
 * code every one of these bearers reached its surface (an admin, a scoped
 * principal, a share-view principal); here each is a 401.
 *
 * Disarm: put any one prefix adapter back in `createCredentialVerifier`
 * (`if (bearer.startsWith(…)) return legacy…(bearer)`) → that prefix's four
 * rows go green-to-red.
 */
import { attachUserManagementInternal, type UserManagementInternal } from '@camstack/system'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { registerAuthWhoamiRoute } from '../../api/auth-whoami.js'
import { authorizeUploadRequest } from '../../api/upload-auth.js'
import {
  bindHubCredentialStores,
  createTrpcContext,
  hubCredentialVerifier,
  type TrpcRequest,
} from '../../api/trpc/trpc.context.js'
import { protectedProcedure, trpcRouter } from '../../api/trpc/trpc.middleware.js'
import type { AddonRegistryService } from '../../core/addon/addon-registry.service.js'
import type { AuthService } from '../../core/auth/auth.service.js'
import { authorizeAddonBearer } from '../addon-route-auth.js'

// Spelled from parts so no source file carries a legacy prefix literal
// (`check-no-legacy-token-prefix`); the bearers are exactly what a pre-D892
// client sends.
const ADMIN = ['cs', 'a_live'].join('')
const SCOPED = ['cs', 't_live'].join('')
const SHARE = ['cs', 'v_live'].join('')

const USERS = [
  { id: 'u-admin', isAdmin: true, scopes: [] },
  { id: 'u-bob', isAdmin: false, scopes: [] },
]

/** The legacy rows, still on disk and live. */
const internal = {
  adminTokens: {
    validate: async (token: string) =>
      token === ADMIN
        ? {
            id: 'a-1',
            createdBy: 'u-admin',
            name: 'ops',
            tokenPrefix: ADMIN,
            createdAt: 0,
            expiresAt: Number.MAX_SAFE_INTEGER,
            lastUsedAt: null,
            revokedAt: null,
          }
        : null,
    list: async () => [],
  },
  audit: { record: async () => {}, list: async () => [] },
} as unknown as UserManagementInternal

const userManagement = attachUserManagementInternal(
  {
    listUsers: async () => USERS,
    validateScopedToken: async ({ token }: { token: string }) =>
      token === SCOPED
        ? {
            id: 'c-1',
            userId: 'u-bob',
            tokenPrefix: SCOPED,
            scopes: [{ type: 'category', target: 'system', access: ['view', 'create'] }],
          }
        : null,
  },
  internal,
)

/** Every legacy store a pre-D895 hub bound; `tokenRows` is the only one a verifier still reads. */
const legacyStores = {
  shareTokens: {
    validate: async (token: string) =>
      token === SHARE
        ? {
            id: 'v-1',
            userId: 'u-bob',
            tokenPrefix: SHARE,
            scope: { kind: 'grid-view', deviceIds: [5] },
          }
        : null,
  },
  tokenRows: { lookupLive: async () => null },
}

/** No legacy bearer is a JWT: the hub's verify throws for each, as it does for garbage. */
const authService = {
  verifyToken: () => {
    throw new Error('jwt malformed')
  },
  verifyCredentialToken: () => {
    throw new Error('jwt malformed')
  },
} as unknown as AuthService

const addonRegistry = {
  getPersistedAncestors: () => [],
  getPersistedType: () => 'camera',
  getPersistedLocation: () => null,
  getPersistedDeviceList: () => [],
  getCapabilityRegistry: () => ({
    getSingleton: (name: string) => (name === 'user-management' ? userManagement : undefined),
  }),
} as unknown as AddonRegistryService

const router = trpcRouter({
  auth: trpcRouter({ listOwnThings: protectedProcedure.query(() => 'ok') }),
})

const silent = { warn: () => {} }

afterEach(() => bindHubCredentialStores({ tokenRows: null }))

const BEARERS: readonly (readonly [string, string])[] = [
  ['an admin token (csa)', ADMIN],
  ['a scoped token (cst)', SCOPED],
  ['a share link (csv)', SHARE],
]

describe('a pre-D892 bearer authenticates nobody, on every surface (D895)', () => {
  it.each(BEARERS)('%s → 401 on tRPC', async (_name, bearer) => {
    bindHubCredentialStores(legacyStores)
    const req = { headers: { authorization: `Bearer ${bearer}` } } as unknown as TrpcRequest
    const ctx = await createTrpcContext(req, authService, addonRegistry)
    expect(ctx.user).toBeNull()
    await expect(router.createCaller(ctx).auth.listOwnThings()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })

  it.each(BEARERS)('%s → 401 on an addon route and a data plane', async (_name, bearer) => {
    bindHubCredentialStores(legacyStores)
    const verifier = hubCredentialVerifier({ authService, addonRegistry })
    for (const target of [
      { addonId: 'pipeline-analytics', method: 'GET', access: 'authenticated' as const },
      {
        addonId: 'stream-broker',
        method: 'GET',
        access: 'authenticated' as const,
        share: ['grid-view' as const],
      },
    ]) {
      const result = await authorizeAddonBearer({ bearer, verifier, target, logger: silent })
      expect(result).toMatchObject({ ok: false, status: 401 })
    }
  })

  it.each(BEARERS)('%s → 401 on the upload routes', async (_name, bearer) => {
    bindHubCredentialStores(legacyStores)
    const result = await authorizeUploadRequest({
      authHeader: `Bearer ${bearer}`,
      authService,
      addonRegistry,
    })
    expect(result).toMatchObject({ ok: false, status: 401 })
  })

  it.each(BEARERS)('%s → 401 on /api/auth/whoami', async (_name, bearer) => {
    bindHubCredentialStores(legacyStores)
    const app = Fastify()
    await registerAuthWhoamiRoute(app, authService, addonRegistry)
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/whoami',
      headers: { authorization: `Bearer ${bearer}` },
    })
    await app.close()
    expect(res.statusCode).toBe(401)
    expect(res.json()).toMatchObject({ ok: false })
  })
})
