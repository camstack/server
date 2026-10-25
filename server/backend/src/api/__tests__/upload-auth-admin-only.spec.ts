/**
 * An upload installs code that runs on the hub (an addon tarball, a server
 * closure), so `/api/addons/upload` and `/api/server-upload` are ADMIN only
 * (security review 2026-10-21, HIGH). They used to admit any principal whose
 * scopes matched `addons.installPackage` — a non-admin session granted
 * `category:system [create]` could upload a closure.
 *
 * Disarm: put `authorizeProcedure(principal.scopes, 'addons.installPackage')`
 * back in place of `principal.isAdmin` → the non-admin rows pass.
 */
import type { TokenScope } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { authorizeUploadRequest, type UploadAuthTokenVerifier } from '../upload-auth.js'

const SYSTEM_CREATE: TokenScope = { type: 'category', target: 'system', access: ['view', 'create'] }
const ADDONS_CREATE: TokenScope = { type: 'capability', target: 'addons', access: ['create'] }

const USERS = [
  { id: 'u-admin', isAdmin: true, scopes: [] },
  { id: 'u-ops', isAdmin: false, scopes: [SYSTEM_CREATE, ADDONS_CREATE] },
]

const JWTS: Record<string, Record<string, unknown>> = {
  admin: { userId: 'u-admin', username: 'root', isAdmin: true, sid: 's-1' },
  ops: {
    userId: 'u-ops',
    username: 'ops',
    isAdmin: false,
    sid: 's-2',
    scopes: [SYSTEM_CREATE, ADDONS_CREATE],
  },
}

const authService: UploadAuthTokenVerifier = {
  verifyToken: (token) => {
    const payload = JWTS[token]
    if (payload === undefined) throw new Error('invalid signature')
    return payload
  },
  verifyCredentialToken: () => {
    throw new Error('not a minted token')
  },
}

const addonRegistry = {
  getCapabilityRegistry: () => ({
    getSingleton: (name: string) =>
      name === 'user-management' ? { listUsers: async () => USERS } : null,
  }),
}

describe('the upload routes are admin only', () => {
  it('an admin session uploads', async () => {
    expect(
      await authorizeUploadRequest({ authHeader: 'Bearer admin', authService, addonRegistry }),
    ).toEqual({ ok: true })
  })

  it('SECURITY: a non-admin session holding system create AND addons create does not', async () => {
    expect(
      await authorizeUploadRequest({ authHeader: 'Bearer ops', authService, addonRegistry }),
    ).toMatchObject({ ok: false, status: 403 })
  })

  it('no header, or a bearer that authenticates nobody, is a 401', async () => {
    expect(
      await authorizeUploadRequest({ authHeader: undefined, authService, addonRegistry }),
    ).toMatchObject({ ok: false, status: 401 })
    expect(
      await authorizeUploadRequest({ authHeader: 'Bearer junk', authService, addonRegistry }),
    ).toMatchObject({ ok: false, status: 401 })
  })
})
