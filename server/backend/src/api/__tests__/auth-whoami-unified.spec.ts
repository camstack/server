/* eslint-disable @typescript-eslint/consistent-type-assertions -- test doubles cross typed service boundaries */
/**
 * `GET /api/auth/whoami` answers from the ONE principal for every credential
 * (D892) — the CLI reads `isAdmin` and `scopes` and never classifies a token
 * by its shape. There is no `legacy` field: a pre-D892 bearer is a 401
 * (D895, `legacy-bearer-refused.spec.ts`).
 */
import { attachUserManagementInternal, type UserManagementInternal } from '@camstack/system'
import type { CredentialTokenClaims } from '@camstack/types'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { registerAuthWhoamiRoute } from '../auth-whoami.js'
import { bindHubCredentialStores } from '../trpc/trpc.context.js'

const VIEW_USERS = {
  type: 'capability' as const,
  target: 'user-management',
  access: ['view' as const],
}

const JWTS: Record<string, Record<string, unknown>> = {
  'jwt-admin': { userId: 'u-admin', username: 'root', isAdmin: true, sid: 's-1' },
  'jwt-bob': { userId: 'u-bob', username: 'bob', isAdmin: false, sid: 's-2', scopes: [] },
}

const MINTED: Record<string, CredentialTokenClaims> = {
  'tok-users': { kind: 'credential', sub: 'u-bob', jti: 'jti-users-0000000', scopes: [VIEW_USERS] },
}

const internal = { audit: { record: async () => {} } } as unknown as UserManagementInternal

const userManagement = attachUserManagementInternal(
  {
    listUsers: async () => [
      { id: 'u-admin', isAdmin: true, scopes: [] },
      { id: 'u-bob', isAdmin: false, scopes: [VIEW_USERS] },
    ],
  },
  internal,
)

const authService = {
  verifyToken: (token: string) => {
    const payload = JWTS[token]
    if (payload === undefined) throw new Error('invalid signature')
    return payload
  },
  verifyCredentialToken: (token: string) => {
    const claims = MINTED[token]
    if (claims === undefined) throw new Error('invalid signature')
    return claims
  },
}

const addonRegistry = {
  getCapabilityRegistry: () => ({
    getSingleton: (name: string) => (name === 'user-management' ? userManagement : undefined),
  }),
}

async function whoami(bearer: string): Promise<{ status: number; body: Record<string, unknown> }> {
  bindHubCredentialStores({
    tokenRows: {
      lookupLive: async (jti) =>
        jti === 'jti-users-0000000'
          ? { id: 't-users', subjectId: 'u-bob', label: 'ci', scopes: [VIEW_USERS] }
          : null,
    },
  })
  const app = Fastify()
  await registerAuthWhoamiRoute(app, authService, addonRegistry)
  const res = await app.inject({
    method: 'GET',
    url: '/api/auth/whoami',
    headers: { authorization: `Bearer ${bearer}` },
  })
  await app.close()
  return { status: res.statusCode, body: res.json() }
}

afterEach(() => bindHubCredentialStores({ tokenRows: null }))

describe('whoami answers from the one principal for every credential', () => {
  it.each([
    [
      'admin session',
      'jwt-admin',
      {
        userId: 'u-admin',
        isAdmin: true,
        // A session also holds its own account preferences (D894).
        scopes: ['*', { type: 'preferences-self' }],
        credential: 'session',
      },
    ],
    ['user session', 'jwt-bob', { userId: 'u-bob', isAdmin: false, credential: 'session' }],
    [
      'minted token',
      'tok-users',
      {
        userId: 'u-bob',
        isAdmin: false,
        scopes: [VIEW_USERS],
        credentialId: 't-users',
        credential: 'token',
      },
    ],
  ])('%s', async (_name, bearer, expected) => {
    const { status, body } = await whoami(bearer)
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, ...expected })
    expect(body).not.toHaveProperty('legacy')
  })

  it('a bearer that authenticates nobody is 401', async () => {
    expect((await whoami('garbage')).status).toBe(401)
  })
})
