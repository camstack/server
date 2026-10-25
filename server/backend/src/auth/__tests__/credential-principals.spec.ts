/* eslint-disable @typescript-eslint/consistent-type-assertions -- test doubles cross typed service boundaries */
/**
 * ONE verifier, ONE matcher (D892): every credential the hub accepts — a
 * session, an account link, a minted token — reaches the tRPC procedures
 * through its scopes alone. There is no other format (D895): a pre-D892
 * bearer is pinned to 401 in `legacy-bearer-refused.spec.ts`.
 *
 * Driven through the REAL `createTrpcContext` and the REAL
 * `protectedProcedure` / `adminProcedure`, so the table covers the wiring, not
 * a re-implementation of it.
 *
 * Disarm checks (each flips rows of the table):
 *   - drop the share-view branch of `authorizeProcedure` → the share rows
 *     reach the hand-written route and the admin procedure;
 *   - drop the `lookupLive` revocation read in the verifier → the revoked row
 *     authenticates;
 *   - drop `scopesGrantAdmin(...) && !subject.isAdmin` → the demoted row is admin.
 */
import { attachUserManagementInternal, type UserManagementInternal } from '@camstack/system'
import type { CredentialScope, CredentialTokenClaims, TokenScope } from '@camstack/types'
import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AddonRegistryService } from '../../core/addon/addon-registry.service.js'
import type { AuthService } from '../../core/auth/auth.service.js'
import { createTrpcContext, type TrpcRequest } from '../../api/trpc/trpc.context.js'
import { adminProcedure, protectedProcedure, trpcRouter } from '../../api/trpc/trpc.middleware.js'
import type { VerifiedTokenRow, VerifierTokenRows } from '../credential-verifier.js'

// ── The surface ────────────────────────────────────────────────────────

const router = trpcRouter({
  /** An admin-only hand-written procedure. */
  admin: trpcRouter({ only: adminProcedure.query(() => 'ok') }),
  /** A hand-written core route (no cap entry): authentication only. */
  auth: trpcRouter({ listOwnThings: protectedProcedure.query(() => 'ok') }),
  /** A system-scope cap method (`user-management`, view). */
  userManagement: trpcRouter({ listUsers: protectedProcedure.query(() => 'ok') }),
  /** A device-scope cap method, on the grid-view share allowlist. */
  snapshot: trpcRouter({
    getSnapshot: protectedProcedure.input(z.object({ deviceId: z.number() })).query(() => 'ok'),
  }),
})

// ── The credentials ────────────────────────────────────────────────────

const VIEW_USERS: TokenScope = { type: 'capability', target: 'user-management', access: ['view'] }
const VIEW_DEVICE_5: TokenScope = {
  type: 'device',
  selector: { kind: 'ids', ids: [5] },
  access: ['view'],
}
const SHARE_5: CredentialScope = {
  type: 'share-view',
  grant: { kind: 'grid-view', deviceIds: [5] },
}

const USERS = [
  { id: 'u-admin', isAdmin: true, scopes: [] },
  { id: 'u-bob', isAdmin: false, scopes: [VIEW_DEVICE_5] },
  { id: 'u-carol', isAdmin: false, scopes: [VIEW_USERS] },
  { id: 'u-demoted', isAdmin: false, scopes: [] },
]

/** Session / account-link JWT payloads, by bearer string. */
const JWTS: Record<string, Record<string, unknown>> = {
  'jwt-admin': { userId: 'u-admin', username: 'root', isAdmin: true, sid: 's-1' },
  'jwt-bob': { userId: 'u-bob', username: 'bob', isAdmin: false, sid: 's-2', scopes: [] },
  'jwt-link': {
    kind: 'sso-bridge',
    provider: 'oauth-access',
    sessionId: 'o-1',
    userId: 'u-admin',
    username: 'root',
    isAdmin: false,
    scopes: [VIEW_USERS],
  },
}

/** Minted-token claims, by bearer string: they verify only through their own door (D895). */
const MINTED: Record<string, CredentialTokenClaims> = {
  'tok-admin': { kind: 'credential', sub: 'u-admin', jti: 'jti-admin-0000000', scopes: ['*'] },
  'tok-users': {
    kind: 'credential',
    sub: 'u-carol',
    jti: 'jti-users-0000000',
    scopes: [VIEW_USERS],
  },
  'tok-share': { kind: 'credential', sub: 'u-bob', jti: 'jti-share-0000000', scopes: [SHARE_5] },
  'tok-revoked': { kind: 'credential', sub: 'u-admin', jti: 'jti-revoked-00000', scopes: ['*'] },
  'tok-demoted': { kind: 'credential', sub: 'u-demoted', jti: 'jti-demoted-00000', scopes: ['*'] },
}

/** The live token rows. `jti-revoked` has none: revoked. */
const ROWS: Record<string, VerifiedTokenRow> = {
  'jti-admin-0000000': { id: 't-admin', subjectId: 'u-admin', label: 'ops', scopes: ['*'] },
  'jti-users-0000000': { id: 't-users', subjectId: 'u-carol', label: 'ci', scopes: [VIEW_USERS] },
  'jti-share-0000000': { id: 't-share', subjectId: 'u-bob', label: 'share', scopes: [SHARE_5] },
  'jti-demoted-00000': { id: 't-dem', subjectId: 'u-demoted', label: 'old', scopes: ['*'] },
}

const tokenRows: VerifierTokenRows = {
  lookupLive: async (jti) => ROWS[jti] ?? null,
}

const fakeAuth = {
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
  checkSession: () => null,
} as unknown as AuthService

const internal = { audit: { record: async () => {} } } as unknown as UserManagementInternal

const userManagement = attachUserManagementInternal(
  {
    listUsers: async () => USERS,
  },
  internal,
)

const registry = {
  getPersistedAncestors: () => [],
  getPersistedType: () => 'camera',
  getPersistedLocation: () => null,
  getPersistedDeviceList: () => [],
  getCapabilityRegistry: () => ({
    getSingleton: (name: string) => (name === 'user-management' ? userManagement : undefined),
  }),
} as unknown as AddonRegistryService

async function callerFor(bearer: string) {
  const req = { headers: { authorization: `Bearer ${bearer}` } } as unknown as TrpcRequest
  const ctx = await createTrpcContext(req, fakeAuth, registry, null, tokenRows)
  return router.createCaller(ctx)
}

type Outcome = 'ok' | 'FORBIDDEN' | 'UNAUTHORIZED'

async function outcome(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    await run()
    return 'ok'
  } catch (error: unknown) {
    if (
      error instanceof TRPCError &&
      (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED')
    ) {
      return error.code
    }
    throw error
  }
}

/** [admin.only, auth.listOwnThings, userManagement.listUsers, snapshot(5), snapshot(9)] */
type Row = readonly [Outcome, Outcome, Outcome, Outcome, Outcome]

const ALL: Row = ['ok', 'ok', 'ok', 'ok', 'ok']
const NOBODY: Row = ['UNAUTHORIZED', 'UNAUTHORIZED', 'UNAUTHORIZED', 'UNAUTHORIZED', 'UNAUTHORIZED']

const TABLE: readonly (readonly [string, string, Row])[] = [
  ['admin session', 'jwt-admin', ALL],
  // A person with a stored device row and no viewer row reaches nothing labelled.
  [
    'user session (no viewer row)',
    'jwt-bob',
    ['FORBIDDEN', 'ok', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN'],
  ],
  [
    'oauth-access link (user-management view)',
    'jwt-link',
    ['FORBIDDEN', 'ok', 'ok', 'FORBIDDEN', 'FORBIDDEN'],
  ],
  ['garbage', 'not-a-token', NOBODY],
  // ── a minted token: permissions are its scopes, nothing else ──
  ["token ['*']", 'tok-admin', ALL],
  [
    'token (user-management view)',
    'tok-users',
    ['FORBIDDEN', 'ok', 'ok', 'FORBIDDEN', 'FORBIDDEN'],
  ],
  [
    'token (share-view grid, device 5)',
    'tok-share',
    ['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'ok', 'FORBIDDEN'],
  ],
  ['token, revoked jti', 'tok-revoked', NOBODY],
  ["token ['*'], subject no longer admin", 'tok-demoted', NOBODY],
]

describe('every credential reaches tRPC through one verifier and one scope matcher', () => {
  it.each(TABLE)('%s', async (_name, bearer, expected) => {
    const caller = await callerFor(bearer)
    const got: Row = [
      await outcome(() => caller.admin.only()),
      await outcome(() => caller.auth.listOwnThings()),
      await outcome(() => caller.userManagement.listUsers()),
      await outcome(() => caller.snapshot.getSnapshot({ deviceId: 5 })),
      await outcome(() => caller.snapshot.getSnapshot({ deviceId: 9 })),
    ]
    expect(got).toEqual(expected)
  })

  it('a principal carries its scopes, its credential id and an audit tag — never a kind flag', async () => {
    const req = { headers: { authorization: 'Bearer tok-users' } } as unknown as TrpcRequest
    const ctx = await createTrpcContext(req, fakeAuth, registry, null, tokenRows)
    expect(ctx.user).toMatchObject({
      id: 'u-carol',
      isAdmin: false,
      scopes: [VIEW_USERS],
      credentialId: 't-users',
      auditTag: 'token',
      interactive: false,
    })
    expect(ctx.user).not.toHaveProperty('legacy')
    expect(ctx.user).not.toHaveProperty('isScoped')
    expect(ctx.user).not.toHaveProperty('shareView')
    expect(ctx.user).not.toHaveProperty('adminTokenId')
  })
})
