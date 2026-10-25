/**
 * ONE mint (D892, D895): `auth.mintToken({ scopes, expiresIn, label })` issues a
 * signed JWT `{ kind: 'credential', sub, jti, scopes }` backed by a row; the
 * verifier reads the row by `jti` on every request. It is the only mint — an
 * admin token is a token holding `'*'`, a share link a token whose only scope
 * is a share-view grant.
 *
 * Driven through the REAL auth router, the REAL AuthService signing key, the
 * REAL `CredentialTokenService` over in-memory records and the REAL
 * `createTrpcContext`, so a token minted here is the token the hub verifies.
 *
 * Disarm checks:
 *   - drop `scopesWithin` in `mintFor` → "a user cannot mint a scope they do
 *     not hold" and "only an admin mints '*'" mint;
 *   - drop the `revokedAt` check in `lookupLive` → the revoked token still
 *     authenticates;
 *   - drop `assertReauthenticated` for `'*'` → "'*' needs a fresh
 *     re-authentication" mints;
 *   - drop the `addon-routes` refusal in `scopesWithin` → alice mints it;
 *   - drop `canTalkOn` in `scopesWithin` → alice mints talk-back.
 */
import { makeInMemoryRecords, type TokenScope } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { sessionHarness } from '../../../auth/__tests__/session-test-harness.js'
import { CredentialTokenService } from '../../../core/auth/credential-token.service.js'
import { coreAuthRecordKinds } from '../../../core/auth/record-kinds.js'
import { createTrpcContext, type AuthenticatedAgent } from '../../trpc/trpc.context.js'
import { createAuthLimiters } from '../auth-limits.js'
import { createAuthRouter } from '../auth.router.js'

const VIEW_USERS: TokenScope = { type: 'capability', target: 'user-management', access: ['view'] }
const MANAGE_USERS: TokenScope = {
  type: 'capability',
  target: 'user-management',
  access: ['view', 'delete'],
}
const VIEW_CAMS: TokenScope = {
  type: 'device',
  selector: { kind: 'ids', ids: [5, 7] },
  access: ['view'],
}
const DAY = 86_400

async function setup() {
  const users = [
    { id: 'u-root', username: 'root', isAdmin: true, password: 'pw-root-1' },
    {
      id: 'u-alice',
      username: 'alice',
      isAdmin: false,
      password: 'pw-alice-1',
      scopes: [VIEW_USERS, VIEW_CAMS],
    },
  ]
  const h = sessionHarness(users)
  const world = makeInMemoryRecords('core-auth')
  await world.records.declare(coreAuthRecordKinds)
  const kind = world.records.kind(coreAuthRecordKinds['credential-tokens'])
  const tokens = new CredentialTokenService(h.auth)
  tokens.bindKind(() => kind)
  const router = createAuthRouter(h.auth, h.registry as never, null, undefined, undefined, null, {
    sessions: h.backing,
    limiters: createAuthLimiters(),
    credentialTokens: tokens,
  })
  const as = (user: Partial<AuthenticatedAgent> & { id: string }) =>
    router.createCaller({
      user: {
        username: user.id,
        isAdmin: false,
        permissions: { isAdmin: false, allowedProviders: '*', allowedDevices: {} },
        isApiKey: false,
        interactive: true,
        userDelegated: true,
        ...user,
      },
    })
  const root = as({ id: 'u-root', username: 'root', isAdmin: true, scopes: ['*'] })
  const alice = as({ id: 'u-alice', username: 'alice', scopes: [VIEW_USERS, VIEW_CAMS] })
  /** Alice's Home Assistant account link: hers, consented, never a login session. */
  const aliceLink = as({
    id: 'u-alice',
    username: 'alice',
    scopes: [VIEW_CAMS],
    interactive: false,
    userDelegated: true,
    auditTag: 'integration',
  })
  const principalFor = async (token: string) =>
    (
      await createTrpcContext(
        {
          headers: { authorization: `Bearer ${token}` },
          url: '/trpc/system.info',
          socket: { remoteAddress: '192.0.2.20' },
        } as never,
        h.auth,
        h.addonRegistry as never,
        null,
        tokens,
      )
    ).user
  const proof = async () => (await root.reauthenticate({ password: 'pw-root-1' })).reauthToken
  return { ...h, users, router, as, root, alice, aliceLink, principalFor, proof, tokens }
}

describe('auth.mintToken — one format, permissions as scopes', () => {
  it('mints a signed JWT whose principal carries exactly the scopes asked', async () => {
    const h = await setup()
    const { token, record } = await h.alice.mintToken({
      scopes: [VIEW_USERS],
      expiresIn: 7 * DAY,
      label: 'ci',
    })
    expect(token.split('.')).toHaveLength(3)
    expect(record).toMatchObject({ subjectId: 'u-alice', label: 'ci' })
    expect(record).not.toHaveProperty('legacy')
    expect(JSON.stringify(await h.alice.listTokens())).not.toContain(token)
    const principal = await h.principalFor(token)
    expect(principal).toMatchObject({
      id: 'u-alice',
      isAdmin: false,
      scopes: [VIEW_USERS],
      credentialId: record.id,
      auditTag: 'token',
      interactive: false,
    })
  })

  it("SECURITY: '*' needs an admin AND a fresh re-authentication, and is admin when used", async () => {
    const h = await setup()
    await expect(
      h.root.mintToken({ scopes: ['*'], expiresIn: DAY, label: 'ops' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const { token } = await h.root.mintToken({
      scopes: ['*'],
      expiresIn: DAY,
      label: 'ops',
      reauthToken: await h.proof(),
    })
    expect(await h.principalFor(token)).toMatchObject({
      id: 'u-root',
      isAdmin: true,
      scopes: ['*'],
    })
  })

  it("SECURITY: only an admin mints '*'", async () => {
    const h = await setup()
    await expect(
      h.alice.mintToken({ scopes: ['*'], expiresIn: DAY, label: 'x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('SECURITY: a user cannot mint a scope they do not hold', async () => {
    const h = await setup()
    await expect(
      h.alice.mintToken({ scopes: [MANAGE_USERS], expiresIn: DAY, label: 'x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      h.alice.mintToken({
        scopes: [{ type: 'category', target: 'system', access: ['view'] }],
        expiresIn: DAY,
        label: 'x',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('SECURITY: a non-admin cannot mint addon-routes (every addon at once); an admin can', async () => {
    const h = await setup()
    const aliceSession = h.as({
      id: 'u-alice',
      // What the verifier hands a non-admin's session.
      scopes: [VIEW_USERS, { type: 'addon-routes', access: ['view', 'create', 'delete'] }],
    })
    await expect(
      aliceSession.mintToken({
        scopes: [{ type: 'addon-routes', access: ['view'] }],
        expiresIn: DAY,
        label: 'x',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      h.root.mintToken({
        scopes: [{ type: 'addon-routes', access: ['view'] }],
        expiresIn: DAY,
        label: 'x',
      }),
    ).resolves.toMatchObject({ record: { label: 'x' } })
  })

  it('SECURITY: a share link with talk-back needs talk-back on every device', async () => {
    const h = await setup()
    await expect(
      h.alice.mintToken({
        scopes: [{ type: 'share-view', grant: { kind: 'grid-view', deviceIds: [5], talk: true } }],
        expiresIn: DAY,
        label: 'x',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const talker = h.as({
      id: 'u-alice',
      scopes: [{ ...VIEW_CAMS, access: ['view', 'create'] }],
    })
    await expect(
      talker.mintToken({
        scopes: [{ type: 'share-view', grant: { kind: 'grid-view', deviceIds: [5], talk: true } }],
        expiresIn: DAY,
        label: 'x',
      }),
    ).resolves.toMatchObject({ record: { label: 'x' } })
  })

  it('SECURITY: a token cannot mint a token, nor turn itself into a session', async () => {
    const h = await setup()
    const { token } = await h.root.mintToken({
      scopes: ['*'],
      expiresIn: DAY,
      label: 'ops',
      reauthToken: await h.proof(),
    })
    const principal = await h.principalFor(token)
    if (principal === null) throw new Error('no principal')
    expect(principal.sessionId).toBeUndefined()
    expect(principal.interactive).toBe(false)
    const viaToken = h.router.createCaller({ user: principal })
    await expect(
      viaToken.mintToken({ scopes: [VIEW_USERS], expiresIn: DAY, label: 'y' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(viaToken.createHandoffCode()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('SECURITY: every use of a * token is audited, with the path and the client address', async () => {
    const h = await setup()
    const { token } = await h.root.mintToken({
      scopes: ['*'],
      expiresIn: DAY,
      label: 'ops',
      reauthToken: await h.proof(),
    })
    await h.principalFor(token)
    await new Promise((r) => setTimeout(r, 0))
    const used = (await h.root.listAuthAudit()).filter((e) => e.action === 'admin-token-used')
    expect(used).toHaveLength(1)
    expect(used[0]).toMatchObject({
      userId: 'u-root',
      ip: '192.0.2.20',
      detail: { name: 'ops', path: '/trpc/system.info' },
    })
    expect(JSON.stringify(used)).not.toContain(token)
  })

  it('SECURITY: a revoked jti is refused at once', async () => {
    const h = await setup()
    const { token, record } = await h.alice.mintToken({
      scopes: [VIEW_USERS],
      expiresIn: DAY,
      label: 'ci',
    })
    expect(await h.principalFor(token)).not.toBeNull()
    expect(await h.alice.revokeToken({ id: record.id })).toEqual({ success: true })
    expect(await h.principalFor(token)).toBeNull()
  })

  it('SECURITY: a * token dies with its subject’s admin bit', async () => {
    const h = await setup()
    const { token } = await h.root.mintToken({
      scopes: ['*'],
      expiresIn: DAY,
      label: 'ops',
      reauthToken: await h.proof(),
    })
    const root = h.users.find((u) => u.id === 'u-root')
    if (root !== undefined) root.isAdmin = false
    expect(await h.principalFor(token)).toBeNull()
  })

  it('SECURITY: lifetime is mandatory, at most 90 days; never-expiring only for a share link', async () => {
    const h = await setup()
    await expect(
      h.alice.mintToken({ scopes: [VIEW_USERS], expiresIn: 91 * DAY, label: 'x' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      h.alice.mintToken({ scopes: [VIEW_USERS], expiresIn: 'never', label: 'x' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('a share-view grant stands alone', async () => {
    const h = await setup()
    await expect(
      h.root.mintToken({
        scopes: [{ type: 'share-view', grant: { kind: 'grid-view', deviceIds: [5] } }, VIEW_USERS],
        expiresIn: DAY,
        label: 'x',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('an admin mints on behalf of a user (cut to that user at verify); a user cannot', async () => {
    const h = await setup()
    const { token, record } = await h.root.mintToken({
      scopes: [VIEW_USERS],
      expiresIn: DAY,
      label: 'for alice',
      subjectId: 'u-alice',
    })
    expect(record.subjectId).toBe('u-alice')
    expect(await h.principalFor(token)).toMatchObject({ id: 'u-alice', scopes: [VIEW_USERS] })
    await expect(
      h.alice.mintToken({ scopes: [VIEW_USERS], expiresIn: DAY, label: 'x', subjectId: 'u-root' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      h.root.mintToken({
        scopes: ['*'],
        expiresIn: DAY,
        label: 'x',
        subjectId: 'u-alice',
        reauthToken: await h.proof(),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('there is no other mint: the admin-token and share-link routes are gone', () => {
    const procedures = Object.keys(createAuthRouter(null as never, null)._def.procedures)
    for (const gone of [
      'createAdminToken',
      'listAdminTokens',
      'revokeAdminToken',
      'createShareToken',
      'extendShareToken',
      'revokeShareToken',
      'listShareTokens',
    ]) {
      expect(procedures).not.toContain(gone)
    }
    expect(procedures).toEqual(expect.arrayContaining(['mintToken', 'listTokens', 'extendToken']))
  })
})

describe('a share link is a token (D895)', () => {
  const GRID = { kind: 'grid-view' as const, deviceIds: [5, 7] }

  it('an account link mints a lone share-view token, finds it by label, extends it in place, revokes it', async () => {
    const h = await setup()
    const { token, record } = await h.aliceLink.mintToken({
      scopes: [{ type: 'share-view', grant: GRID }],
      expiresIn: 3_600,
      label: 'ha-embed:dashboard',
    })
    expect(await h.principalFor(token)).toMatchObject({
      scopes: [{ type: 'share-view', grant: GRID }],
      isAdmin: false,
    })
    const found = await h.aliceLink.listTokens({ label: 'ha-embed:dashboard' })
    expect(found.map((t) => t.id)).toEqual([record.id])
    expect(found[0]).toMatchObject({
      label: 'ha-embed:dashboard',
      scopes: [{ type: 'share-view', grant: GRID }],
      createdAt: expect.any(Number),
      expiresAt: expect.any(Number),
      lastUsedAt: expect.anything(),
    })
    const moved = await h.aliceLink.extendToken({ id: record.id, expiresIn: 7 * DAY })
    expect(moved.expiresAt ?? 0).toBeGreaterThan(record.expiresAt ?? 0)
    // Same token, new lifetime: the one already handed out keeps working.
    expect(await h.principalFor(token)).not.toBeNull()
    expect(await h.aliceLink.revokeToken({ id: record.id })).toEqual({ success: true })
    expect(await h.principalFor(token)).toBeNull()
  })

  it('SECURITY: an account link mints NOTHING but a lone share-view grant', async () => {
    const h = await setup()
    await expect(
      h.aliceLink.mintToken({ scopes: [VIEW_CAMS], expiresIn: DAY, label: 'x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('SECURITY: an account link lists, extends and revokes only share links', async () => {
    const h = await setup()
    const ci = await h.alice.mintToken({ scopes: [VIEW_USERS], expiresIn: DAY, label: 'ci' })
    expect((await h.aliceLink.listTokens()).map((t) => t.id)).not.toContain(ci.record.id)
    await expect(
      h.aliceLink.extendToken({ id: ci.record.id, expiresIn: DAY }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(h.aliceLink.revokeToken({ id: ci.record.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('SECURITY: extendToken obeys the mint rules — owner or admin, never past 90 days', async () => {
    const h = await setup()
    const { record } = await h.root.mintToken({
      scopes: [{ type: 'share-view', grant: GRID }],
      expiresIn: DAY,
      label: 'wall',
    })
    await expect(h.alice.extendToken({ id: record.id, expiresIn: DAY })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(h.root.extendToken({ id: record.id, expiresIn: 91 * DAY })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    })
    await expect(h.root.extendToken({ id: record.id, expiresIn: 'never' })).resolves.toMatchObject({
      expiresAt: null,
    })
    const ci = await h.alice.mintToken({ scopes: [VIEW_USERS], expiresIn: DAY, label: 'ci' })
    await expect(
      h.alice.extendToken({ id: ci.record.id, expiresIn: 'never' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('a revoked token cannot be extended back to life', async () => {
    const h = await setup()
    const { record } = await h.root.mintToken({
      scopes: [{ type: 'share-view', grant: GRID }],
      expiresIn: DAY,
      label: 'wall',
    })
    await h.root.revokeToken({ id: record.id })
    await expect(h.root.extendToken({ id: record.id, expiresIn: DAY })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})
