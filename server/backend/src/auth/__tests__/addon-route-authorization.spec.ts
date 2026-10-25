/* eslint-disable @typescript-eslint/consistent-type-assertions -- test doubles cross typed service boundaries */
/**
 * `/addon/:addonId/*` — routes and data planes — authorizes through the SAME
 * verifier and the SAME scope matcher as tRPC (D892). No prefix check of its
 * own: `main.ts` calls `verifier.verify(bearer)` then `authorizeAddonRoute`.
 *
 * A token with `addon:X` never reaches X's ADMIN routes, and its grant's
 * access flavour applies — the same rule an integration token always had. A
 * pre-D892 bearer is a 401 here as everywhere (D895,
 * `legacy-bearer-refused.spec.ts`).
 *
 * Disarm checks:
 *   - drop the share-view branch of `authorizeAddonRoute` → the share rows
 *     reach the control route and the events-only plane;
 *   - drop the `access === 'admin'` refusal → the session and token rows reach
 *     the admin route.
 */
import { attachUserManagementInternal, type UserManagementInternal } from '@camstack/system'
import type { CredentialTokenClaims, TokenPayload, TokenScope } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  authorizeAddonRoute,
  type AddonRouteTarget,
} from '../../api/trpc/principal-authorization.js'
import { createCredentialVerifier, type VerifiedTokenRow } from '../credential-verifier.js'

const ADDON_X: TokenScope = { type: 'addon', target: 'x', access: ['view'] }
const VIEW_5_6: TokenScope = {
  type: 'device',
  selector: { kind: 'ids', ids: [5, 6] },
  access: ['view'],
}

const JWTS: Record<string, Record<string, unknown>> = {
  'jwt-admin': { userId: 'u-admin', username: 'root', isAdmin: true, sid: 's-1' },
  'jwt-bob': { userId: 'u-bob', username: 'bob', isAdmin: false, sid: 's-2' },
  'jwt-link': {
    kind: 'sso-bridge',
    provider: 'oauth-access',
    userId: 'u-bob',
    isAdmin: false,
    scopes: [{ type: 'addon', target: 'x', access: ['view', 'create'] }],
  },
  'jwt-code': { kind: 'sso-bridge', provider: 'oauth-code', userId: 'u-bob', isAdmin: false },
}

const MINTED: Record<string, CredentialTokenClaims> = {
  'tok-x': { kind: 'credential', sub: 'u-bob', jti: 'jti-x-00000000000', scopes: [ADDON_X] },
  'tok-share': {
    kind: 'credential',
    sub: 'u-bob',
    jti: 'jti-share-0000000',
    scopes: [{ type: 'share-view', grant: { kind: 'grid-view', deviceIds: [5, 6] } }],
  },
}

const ROWS: Record<string, VerifiedTokenRow> = {
  'jti-x-00000000000': { id: 't-x', subjectId: 'u-bob', label: 'x', scopes: [ADDON_X] },
  'jti-share-0000000': {
    id: 't-share',
    subjectId: 'u-bob',
    label: 'share',
    scopes: [{ type: 'share-view', grant: { kind: 'grid-view', deviceIds: [5, 6] } }],
  },
}

const internal = { audit: { record: async () => {} } } as unknown as UserManagementInternal

const users = attachUserManagementInternal(
  {
    listUsers: async () => [
      { id: 'u-admin', isAdmin: true, scopes: [] },
      // Bob holds what his tokens name: a token never outgrows its subject.
      { id: 'u-bob', isAdmin: false, scopes: [ADDON_X, VIEW_5_6] },
    ],
  },
  internal,
)

const verifier = createCredentialVerifier({
  verifyJwt: (token) => {
    const payload = JWTS[token]
    if (payload === undefined) throw new Error('invalid signature')
    return payload as unknown as TokenPayload
  },
  verifyCredentialJwt: (token) => {
    const claims = MINTED[token]
    if (claims === undefined) throw new Error('invalid signature')
    return claims
  },
  users: () => users,
  internal: () => internal,
  deviceScopeLookup: {
    getAncestors: () => [],
    getType: () => null,
    getLocation: () => null,
  },
  tokenRows: () => ({ lookupLive: async (jti) => ROWS[jti] ?? null }),
})

type Outcome = 401 | 403 | 'ok' | 'ok+share'

async function reach(bearer: string, target: AddonRouteTarget): Promise<Outcome> {
  const principal = await verifier.verify(bearer)
  if (principal === null) return 401
  const verdict = authorizeAddonRoute(principal.scopes, target)
  if (!verdict.ok) return verdict.status
  return verdict.shareHeaders === null ? 'ok' : 'ok+share'
}

const X_GET: AddonRouteTarget = { addonId: 'x', method: 'GET', access: 'authenticated' }
const X_POST: AddonRouteTarget = { addonId: 'x', method: 'POST', access: 'authenticated' }
const X_ADMIN: AddonRouteTarget = { addonId: 'x', method: 'GET', access: 'admin' }
const Y_GET: AddonRouteTarget = { addonId: 'y', method: 'GET', access: 'authenticated' }
const PLANE_GRID: AddonRouteTarget = {
  addonId: 'x',
  method: 'GET',
  access: 'authenticated',
  share: ['grid-view'],
}
const PLANE_EVENTS: AddonRouteTarget = {
  addonId: 'x',
  method: 'GET',
  access: 'authenticated',
  share: ['events-view'],
}

const TARGETS = [X_GET, X_POST, X_ADMIN, Y_GET, PLANE_GRID, PLANE_EVENTS] as const
type Row = readonly [Outcome, Outcome, Outcome, Outcome, Outcome, Outcome]

const TABLE: readonly (readonly [string, string, Row])[] = [
  ['admin session', 'jwt-admin', ['ok', 'ok', 'ok', 'ok', 'ok', 'ok']],
  ['user session', 'jwt-bob', ['ok', 'ok', 403, 'ok', 'ok', 'ok']],
  ['oauth-access link (addon:x view+create)', 'jwt-link', ['ok', 'ok', 403, 403, 'ok', 'ok']],
  ['oauth-code (not a credential)', 'jwt-code', [401, 401, 401, 401, 401, 401]],
  ['token (addon:x view)', 'tok-x', ['ok', 403, 403, 403, 'ok', 'ok']],
  ['token (share-view grid)', 'tok-share', [403, 403, 403, 403, 'ok+share', 403]],
  ['unknown bearer', 'garbage', [401, 401, 401, 401, 401, 401]],
]

describe('addon routes authorize through the one verifier and the one scope matcher', () => {
  it.each(TABLE)('%s', async (_name, bearer, expected) => {
    const got: Outcome[] = []
    for (const target of TARGETS) got.push(await reach(bearer, target))
    expect(got).toEqual(expected)
  })

  it('a share principal is forwarded ITS devices, in headers the hub writes', async () => {
    const principal = await verifier.verify('tok-share')
    expect(principal).not.toBeNull()
    const verdict = authorizeAddonRoute(principal?.scopes ?? [], PLANE_GRID)
    expect(verdict).toEqual({
      ok: true,
      shareHeaders: { 'x-camstack-share-kind': 'grid-view', 'x-camstack-share-devices': '5,6' },
    })
  })
})
