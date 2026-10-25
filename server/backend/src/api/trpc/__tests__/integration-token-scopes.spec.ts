/* eslint-disable @typescript-eslint/consistent-type-assertions -- test mocks cross typed service boundaries */
/**
 * An ACCOUNT-LINK token is governed by the grant baked into it, never by the
 * linking user's stored scopes.
 *
 * The bug this pins (2026-08-19, Home Assistant setup failure). The live-scope
 * refresh added on 2026-08-15 ("scope edits reach live sessions without a
 * re-login") re-reads the user record for every principal whose JWT says
 * `isAdmin: false` and REPLACES the token's scopes with the store's. An
 * `oauth-access` token always carries `isAdmin: false` (`oauth-grants.ts`
 * `baseClaims`), and the linking user is normally an ADMIN — and "admins are
 * intentionally unscoped", so their record holds `scopes: []`. The consented
 * grant was therefore overwritten with the empty set on every call, and the
 * hub answered the component's first request with
 *
 *   FORBIDDEN deviceExport.listExposedDevices
 *   "No scope grants view on 'device-export' (system-scope cap). Have: (none)"
 *
 * `Have: (none)` is the tell: the link's own session row on the live hub
 * carried all six scopes, `capability:device-export[view]` included.
 *
 * Neutralisation: drop the `principal.kind === 'session'` guard in
 * `resolveUser` and the first test flips back to `[]`.
 */
import { capabilityScopesOf } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { AddonRegistryService } from '../../../core/addon/addon-registry.service.js'
import type { AuthService } from '../../../core/auth/auth.service.js'
import { createTrpcContext } from '../trpc.context.js'
import type { TrpcRequest } from '../trpc.context.js'
import { checkScopeAccess } from '../scope-access.js'

/** The grant the `homeassistant` descriptor asks for, as minted at consent. */
const LINK_GRANT = [
  { type: 'category', target: 'device', access: ['view', 'create'] },
  { type: 'capability', target: 'device-manager', access: ['view'] },
  { type: 'capability', target: 'device-state', access: ['view'] },
  {
    type: 'capability',
    target: 'pipeline-orchestrator',
    access: ['view', 'create'],
  },
  { type: 'capability', target: 'device-export', access: ['view'] },
  { type: 'addon', target: 'homeassistant-export', access: ['view', 'create'] },
] as const

/** An `oauth-access` JWT: `kind: 'sso-bridge'`, never `isAdmin`. */
function linkTokenPayload(userId: string): Record<string, unknown> {
  return {
    kind: 'sso-bridge',
    provider: 'oauth-access',
    sessionId: '711f4882-f75c-4153-a508-01bdc5b8391e',
    userId,
    username: 'apocaliss92',
    isAdmin: false,
    scopes: LINK_GRANT,
  }
}

function fakeRegistry(users: readonly { id: string; isAdmin: boolean; scopes?: unknown }[]) {
  return {
    getPersistedAncestors: () => [],
    getPersistedType: () => null,
    getPersistedLocation: () => null,
    getPersistedDeviceList: () => [],
    getCapabilityRegistry: () => ({
      getSingleton: (name: string) =>
        name === 'user-management' ? { listUsers: async () => users } : undefined,
    }),
  } as unknown as AddonRegistryService
}

function reqWithBearer(token: string): TrpcRequest {
  return {
    headers: { authorization: `Bearer ${token}` },
  } as unknown as TrpcRequest
}

function fakeAuth(payload: Record<string, unknown>): AuthService {
  return { verifyToken: () => payload } as unknown as AuthService
}

describe('an account-link token keeps its own grant', () => {
  it('an ADMIN-owned link is not stripped by the (empty) admin scope record', async () => {
    // A distinct userId per test: `liveScopeMemo` is module-level.
    const userId = 'user-admin-link'
    const ctx = await createTrpcContext(
      reqWithBearer('link-token'),
      fakeAuth(linkTokenPayload(userId)),
      // "Admins are intentionally unscoped" — local-auth.addon.ts.
      fakeRegistry([{ id: userId, isAdmin: true, scopes: [] }]),
    )
    expect(ctx.user?.scopes).toEqual(LINK_GRANT)
    // The call the Home Assistant component makes FIRST.
    expect(
      checkScopeAccess(
        capabilityScopesOf(ctx.user?.scopes ?? []),
        'deviceExport.listExposedDevices',
      ),
    ).toMatchObject({ ok: true })
  })

  it("a NON-ADMIN owner's own scopes never stand in for the link's grant", async () => {
    const userId = 'user-plain-link'
    const ctx = await createTrpcContext(
      reqWithBearer('link-token'),
      fakeAuth(linkTokenPayload(userId)),
      fakeRegistry([
        {
          id: userId,
          isAdmin: false,
          scopes: [{ type: 'category', target: 'system', access: ['view', 'create'] }],
        },
      ]),
    )
    expect(ctx.user?.scopes).toEqual(LINK_GRANT)
  })

  it('an ordinary session JWT reads the store, not the JWT (the 2026-08-15 fix stands)', async () => {
    const userId = 'user-session-viewer'
    const stored = [{ type: 'viewer', allow: '*', block: [], features: [] }]
    const ctx = await createTrpcContext(
      reqWithBearer('session-token'),
      // No `kind` claim — that is what makes a JWT a session.
      fakeAuth({ userId, username: 'bob', isAdmin: false, scopes: [] }),
      fakeRegistry([{ id: userId, isAdmin: false, scopes: stored }]),
    )
    // The store's viewer row, then what every person's session reaches on
    // addon routes (D892) and its own preferences (D894). The JWT's empty
    // copy is not consulted.
    expect(ctx.user?.scopes).toMatchObject([
      { type: 'viewer', allow: '*', block: [], features: [] },
      { type: 'addon-routes', access: ['view', 'create', 'delete'] },
      { type: 'preferences-self' },
    ])
  })

  it('a person session drops a stored grant that is not a viewer row', async () => {
    const userId = 'user-session-legacy'
    const stored = [{ type: 'device', selector: { kind: 'all' }, access: ['view'] }]
    const ctx = await createTrpcContext(
      reqWithBearer('session-token'),
      fakeAuth({ userId, username: 'bob', isAdmin: false, scopes: [] }),
      fakeRegistry([{ id: userId, isAdmin: false, scopes: stored }]),
    )
    expect(ctx.user?.scopes).toMatchObject([
      { type: 'addon-routes', access: ['view', 'create', 'delete'] },
      { type: 'preferences-self' },
    ])
  })
})
