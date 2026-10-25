/* eslint-disable @typescript-eslint/consistent-type-assertions -- test doubles cross typed service boundaries */
/**
 * `preferences.*` (D894): the caller only ever touches its OWN rows, and only
 * a principal holding `preferences-self` gets in.
 *
 * The principals come out of the REAL verifier (a session JWT, a share link,
 * a unified token with and without the grant), and the rows go to the REAL
 * store on the real records engine — the owner stamp is what is under test,
 * so neither is faked.
 *
 * Disarm checks (each was run):
 *   - make `preferencesOwnerOf` skip the scope check → the share / mesh /
 *     token-without-grant rows get in;
 *   - drop `PREFERENCES_SELF_SCOPE` from the session's scopes in the verifier
 *     → the session rows are refused;
 *   - stamp a fixed owner instead of `principal.id` → B reads A's rows.
 */
import { attachUserManagementInternal, type UserManagementInternal } from '@camstack/system'
import {
  createRecordsAccess,
  type CredentialTokenClaims,
  type TokenPayload,
  type TokenScope,
} from '@camstack/types'
import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import { makeRecordsWorld } from '../../../../../../packages/system/src/builtins/sqlite-storage/__tests__/support/records-world.js'
import { localAuthPreferencesRecordKinds } from '../../../../../../packages/system/src/builtins/local-auth/preferences-record-kinds.js'
import { UserPreferencesStore } from '../../../../../../packages/system/src/builtins/local-auth/user-preferences-store.js'
import {
  createCredentialVerifier,
  type VerifiedTokenRow,
} from '../../../auth/credential-verifier.js'
import {
  agentFromPrincipal,
  createMeshTrpcContext,
  type TrpcContext,
} from '../../trpc/trpc.context.js'
import { scopesWithin } from '../../../auth/scope-escalation.js'
import { createPreferencesRouter } from '../preferences.router.js'

const ROWS: Record<string, VerifiedTokenRow> = {
  'jti-prefs-0000000': {
    id: 't-prefs',
    subjectId: 'u-alice',
    label: 'sync',
    scopes: [{ type: 'preferences-self' }],
  },
  'jti-view-00000000': {
    id: 't-view',
    subjectId: 'u-alice',
    label: 'view',
    scopes: [{ type: 'category', target: 'device', access: ['view'] }],
  },
  'jti-share-0000000': {
    id: 't-share',
    subjectId: 'u-alice',
    label: 'share',
    // A share link stays restricted even if it was minted beside the grant.
    scopes: [
      { type: 'share-view', grant: { kind: 'grid-view', deviceIds: [5] } },
      { type: 'preferences-self' },
    ],
  },
  // Bob can view no device: his share grant is cut to nothing at verify, and
  // what is left must not be a preferences token.
  'jti-share-cut-000': {
    id: 't-share-cut',
    subjectId: 'u-bob',
    label: 'share-cut',
    scopes: [
      { type: 'share-view', grant: { kind: 'grid-view', deviceIds: [5] } },
      { type: 'preferences-self' },
    ],
  },
  'jti-root-00000000': { id: 't-root', subjectId: 'u-root', label: 'root', scopes: ['*'] },
}

/** A minted token's claims mirror its row (the verifier trusts the ROW's scopes). */
function tokenClaims(jti: string): CredentialTokenClaims {
  const row = ROWS[jti]
  if (row === undefined) throw new Error(`no row ${jti}`)
  return { kind: 'credential', sub: row.subjectId, jti, scopes: [...row.scopes] }
}

const SESSIONS: Record<string, Record<string, unknown>> = {
  'jwt-alice': { userId: 'u-alice', username: 'alice', isAdmin: false, sid: 's-1' },
  'jwt-bob': { userId: 'u-bob', username: 'bob', isAdmin: false, sid: 's-2' },
  'jwt-root': { userId: 'u-root', username: 'root', isAdmin: true, sid: 's-3' },
}

const MINTED: Record<string, CredentialTokenClaims> = {
  'tok-prefs': tokenClaims('jti-prefs-0000000'),
  'tok-view': tokenClaims('jti-view-00000000'),
  'tok-share': tokenClaims('jti-share-0000000'),
  'tok-share-cut': tokenClaims('jti-share-cut-000'),
  'tok-root': tokenClaims('jti-root-00000000'),
}

const VIEW_DEVICES: TokenScope = { type: 'category', target: 'device', access: ['view'] }

const users = attachUserManagementInternal(
  {
    listUsers: async () => [
      // Alice may view devices, so her view token and share link keep their grant.
      { id: 'u-alice', isAdmin: false, scopes: [VIEW_DEVICES] },
      { id: 'u-bob', isAdmin: false, scopes: [] },
      { id: 'u-root', isAdmin: true, scopes: [] },
    ],
  },
  { audit: { record: async () => {} } } as unknown as UserManagementInternal,
)

const verifier = createCredentialVerifier({
  verifyJwt: (token) => {
    const payload = SESSIONS[token]
    if (payload === undefined) throw new Error('invalid signature')
    return payload as unknown as TokenPayload
  },
  verifyCredentialJwt: (token) => {
    const claims = MINTED[token]
    if (claims === undefined) throw new Error('invalid signature')
    return claims
  },
  users: () => users,
  internal: () => null,
  tokenRows: () => ({ lookupLive: async (jti) => ROWS[jti] ?? null }),
})

async function world() {
  const recordsWorld = makeRecordsWorld()
  await recordsWorld.provider.init()
  const records = createRecordsAccess({
    owner: 'local-auth',
    transport: recordsWorld.transportFor('local-auth'),
    secrets: null,
  })
  await records.declare(localAuthPreferencesRecordKinds)
  const store = new UserPreferencesStore(
    records.kind(localAuthPreferencesRecordKinds['user-preferences']),
  )
  const router = createPreferencesRouter({ preferences: () => store })
  const as = async (bearer: string) => {
    const principal = await verifier.verify(bearer)
    if (principal === null) throw new Error(`${bearer} authenticates nobody`)
    const ctx: TrpcContext = { user: agentFromPrincipal(principal) }
    return router.createCaller(ctx)
  }
  return { router, store, as }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error: unknown) {
    return error instanceof TRPCError ? error.code : 'other'
  }
}

describe('preferences router — owner isolation', () => {
  it("B cannot read, change or delete A's rows; each call acts on the caller", async () => {
    const { as } = await world()
    const alice = await as('jwt-alice')
    const bob = await as('jwt-bob')
    await alice.put({ namespace: 'viewer.app', value: { theme: 'dark' }, deviceId: 'phone' })

    expect(await bob.get({})).toEqual({ rows: [] })
    expect(await bob.get({ namespaces: ['viewer.app'] })).toEqual({ rows: [] })
    expect(await bob.changedSince({ revisionByNamespace: {} })).toEqual({ rows: [], deleted: [] })
    // A `userId` the client smuggles in is not part of the contract: stripped.
    const smuggled = { namespace: 'viewer.app', value: { theme: 'pwned' }, userId: 'u-alice' }
    await bob.put(smuggled)
    expect(await bob.delete({ namespace: 'viewer.app' })).toEqual({ deleted: true })

    const rows = (await alice.get({})).rows
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      value: { theme: 'dark' },
      revision: 1,
      updatedByDevice: 'phone',
    })
  })

  it('an admin is no exception: it reads only its own rows', async () => {
    const { as } = await world()
    await (await as('jwt-alice')).put({ namespace: 'viewer.app', value: { a: 1 } })
    const root = await as('jwt-root')
    expect(await root.get({})).toEqual({ rows: [] })
    await root.put({ namespace: 'viewer.app', value: { r: 1 } })
    expect((await (await as('jwt-alice')).get({})).rows[0]?.value).toEqual({ a: 1 })
  })
})

describe('preferences router — who gets in', () => {
  it('sessions (admin or not) and a token minted with preferences-self get in', async () => {
    const { as } = await world()
    for (const bearer of ['jwt-alice', 'jwt-root', 'tok-prefs']) {
      expect(await codeOf((await as(bearer)).get({})), bearer).toBe('ok')
    }
    // The token acts for its SUBJECT: what it writes, Alice's session reads.
    await (await as('tok-prefs')).put({ namespace: 'viewer.grids', value: { g: 1 } })
    expect((await (await as('jwt-alice')).get({})).rows.map((r) => r.namespace)).toEqual([
      'viewer.grids',
    ])
  })

  it('share links, view-only tokens, an admin-only token and the mesh are refused', async () => {
    const { router, as } = await world()
    for (const bearer of ['tok-share', 'tok-view', 'tok-root']) {
      const caller = await as(bearer)
      expect(await codeOf(caller.get({})), bearer).toBe('FORBIDDEN')
      expect(await codeOf(caller.put({ namespace: 'viewer.app', value: {} })), bearer).toBe(
        'FORBIDDEN',
      )
      expect(await codeOf(caller.changedSince({ revisionByNamespace: {} })), bearer).toBe(
        'FORBIDDEN',
      )
      expect(await codeOf(caller.delete({ namespace: 'viewer.app' })), bearer).toBe('FORBIDDEN')
    }
    const mesh = router.createCaller(createMeshTrpcContext())
    expect(await codeOf(mesh.get({}))).toBe('FORBIDDEN')
  })

  it('a share link whose grant is cut to nothing never becomes a preferences token', async () => {
    const { as } = await world()
    const principal = await verifier.verify('tok-share-cut')
    // Refused outright, or let in with nothing that reaches preferences.
    if (principal === null) return
    expect(principal.scopes.some((s) => s !== '*' && s.type === 'preferences-self')).toBe(false)
    expect(await codeOf((await as('tok-share-cut')).get({}))).toBe('FORBIDDEN')
  })
})

describe('preferences router — conflicts, limits, poll', () => {
  it('a stale baseRevision answers a typed conflict carrying the current row', async () => {
    const { as } = await world()
    const phone = await as('jwt-alice')
    await phone.put({ namespace: 'viewer.app', value: { v: 1 }, deviceId: 'phone' })
    await phone.put({
      namespace: 'viewer.app',
      value: { v: 2 },
      baseRevision: 1,
      deviceId: 'tablet',
    })
    const stale = await phone.put({ namespace: 'viewer.app', value: { v: 'x' }, baseRevision: 1 })
    expect(stale).toEqual({
      status: 'conflict',
      current: {
        namespace: 'viewer.app',
        value: { v: 2 },
        revision: 2,
        updatedAt: expect.any(Number),
        updatedByDevice: 'tablet',
      },
    })
  })

  it('limits answer typed errors; a bad namespace is refused at the input', async () => {
    const { as } = await world()
    const alice = await as('jwt-alice')
    const big = { blob: 'x'.repeat(256 * 1024) }
    expect(await codeOf(alice.put({ namespace: 'viewer.app', value: big }))).toBe(
      'PAYLOAD_TOO_LARGE',
    )
    for (let i = 0; i < 32; i++) await alice.put({ namespace: `ns-${i}`, value: {} })
    expect(await codeOf(alice.put({ namespace: 'ns-overflow', value: {} }))).toBe('BAD_REQUEST')
    for (const bad of ['Viewer.App', '1abc', 'a:b', '', 'a'.repeat(65)]) {
      expect(await codeOf(alice.put({ namespace: bad, value: {} })), bad).toBe('BAD_REQUEST')
    }
    expect(await codeOf(alice.put({ namespace: 'ok', value: {}, deviceId: 'd'.repeat(65) }))).toBe(
      'BAD_REQUEST',
    )
  })

  it('changedSince returns only rows the client does not hold, and the deletions', async () => {
    const { as } = await world()
    const phone = await as('jwt-alice')
    const a = await phone.put({ namespace: 'viewer.app', value: { a: 1 } })
    const c = await phone.put({ namespace: 'viewer.cameras', value: { c: 1 } })
    if (a.status !== 'saved' || c.status !== 'saved') throw new Error('unreachable')
    const held = { 'viewer.app': a.row.revision, 'viewer.cameras': c.row.revision }
    expect(await phone.changedSince({ revisionByNamespace: held })).toEqual({
      rows: [],
      deleted: [],
    })
    const tablet = await as('tok-prefs')
    await tablet.put({ namespace: 'viewer.cameras', value: { c: 2 } })
    await tablet.delete({ namespace: 'viewer.app' })
    const delta = await phone.changedSince({ revisionByNamespace: held })
    expect(delta.deleted).toEqual(['viewer.app'])
    expect(delta.rows.map((r) => [r.namespace, r.revision, r.value])).toEqual([
      ['viewer.cameras', 2, { c: 2 }],
    ])
  })

  it('answers PRECONDITION_FAILED while no store is registered', async () => {
    const router = createPreferencesRouter({ preferences: () => null })
    const principal = await verifier.verify('jwt-alice')
    if (principal === null) throw new Error('unreachable')
    const caller = router.createCaller({ user: agentFromPrincipal(principal) })
    expect(await codeOf(caller.get({}))).toBe('PRECONDITION_FAILED')
  })
})

describe('preferences-self — minting', () => {
  it('a session may mint it; a token without it may not hand it out', async () => {
    const session = await verifier.verify('jwt-alice')
    const viewOnly = await verifier.verify('tok-view')
    if (session === null || viewOnly === null) throw new Error('unreachable')
    expect(scopesWithin([{ type: 'preferences-self' }], session.scopes)).toEqual({ ok: true })
    expect(scopesWithin([{ type: 'preferences-self' }], viewOnly.scopes)).toEqual({
      ok: false,
      reason: 'you do not hold preferences-self',
    })
  })
})
