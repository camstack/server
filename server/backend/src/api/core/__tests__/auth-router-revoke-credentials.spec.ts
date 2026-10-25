import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { sessionHarness } from '../../../auth/__tests__/session-test-harness.js'
import { CredentialTokenService } from '../../../core/auth/credential-token.service.js'
import { coreAuthRecordKinds } from '../../../core/auth/record-kinds.js'
import type { AuthenticatedAgent } from '../../trpc/trpc.context.js'
import { createAuthLimiters } from '../auth-limits.js'
import { createAuthRouter } from '../auth.router.js'

/**
 * `auth.revokeCredentials` — the ONLY bulk revoke (D819), by credential id
 * (D892, D895: one token store — admin tokens, scoped tokens and share links
 * are all `credential-tokens` rows).
 *
 * The operator lost every share link on 2026-10-09 to a client-side
 * "Revoke all never used" button: it looped `revokeShareToken` over every
 * user's links whose `lastUsedAt` was absent. These specs pin the
 * replacement's contract: the server revokes EXACTLY the ids the operator
 * previewed — it never evaluates a predicate of its own — the confirmed count
 * must match, and the caller's own current session or token is never touched.
 */

const DAY_MS = 86_400_000

async function setup() {
  const users = [
    { id: 'u-root', username: 'root', isAdmin: true, password: 'pw-root-1' },
    { id: 'u-alice', username: 'alice', isAdmin: false, password: 'pw-alice-1' },
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
  const base = {
    isAdmin: false,
    permissions: { isAdmin: false, allowedProviders: '*' as const, allowedDevices: {} },
    isApiKey: false,
    interactive: true,
    userDelegated: true,
  }
  const as = (user: Partial<AuthenticatedAgent> & { id: string }) =>
    router.createCaller({
      user: {
        username: user.id,
        ...base,
        ...(user.isAdmin === true ? { scopes: ['*'] } : {}),
        ...user,
      },
    })
  const rootSession = async () =>
    h.sessions.create({
      userId: 'u-root',
      method: 'password',
      refreshable: false,
      lifetimeMs: 3_600_000,
    })
  const rootAs = (sessionId: string) =>
    as({
      id: 'u-root',
      username: 'root',
      isAdmin: true,
      permissions: { isAdmin: true, allowedProviders: '*', allowedDevices: {} },
      sessionId,
    })
  const mintLinks = async (userId: string, n: number) => {
    const ids: string[] = []
    for (let i = 0; i < n; i += 1) {
      const { record } = await tokens.mint({
        subjectId: userId,
        createdBy: userId,
        label: `share ${i}`,
        scopes: [{ type: 'share-view', grant: { kind: 'grid-view', deviceIds: [i + 1] } }],
        expiresAt: Date.now() + DAY_MS,
      })
      ids.push(record.id)
    }
    return ids
  }
  const mintAdmin = async (label: string) =>
    tokens.mint({
      subjectId: 'u-root',
      createdBy: 'u-root',
      label,
      scopes: ['*'],
      expiresAt: Date.now() + DAY_MS,
    })
  /** Every token not revoked, by id. */
  const live = async () =>
    (await tokens.list()).filter((t) => t.revokedAt === null).map((t) => t.id)
  return { ...h, router, as, rootAs, rootSession, tokens, mintLinks, mintAdmin, live }
}

describe('auth.revokeCredentials', () => {
  it('revokes EXACTLY the listed share links and leaves every other link alone', async () => {
    const h = await setup()
    const own = await h.mintLinks('u-root', 3)
    const alices = await h.mintLinks('u-alice', 4)
    const { session } = await h.rootSession()
    const targets = [own[0] ?? '', alices[2] ?? '']

    const result = await h.rootAs(session.id).revokeCredentials({
      ids: targets,
      confirmCount: 2,
    })

    expect(result.revoked.toSorted()).toEqual(targets.toSorted())
    expect(result.skipped).toEqual([])
    const left = (await h.live()).toSorted()
    expect(left).toEqual([...own.slice(1), alices[0], alices[1], alices[3]].toSorted())
  })

  it('SECURITY: a never-used link is NOT revoked unless its id is listed (no server-side predicate)', async () => {
    const h = await setup()
    const [used, neverUsed] = await h.mintLinks('u-alice', 2)
    const { session } = await h.rootSession()
    await h.rootAs(session.id).revokeCredentials({
      ids: [used ?? ''],
      confirmCount: 1,
    })
    expect(await h.live()).toEqual([neverUsed])
  })

  it('SECURITY: a confirmed count that does not match the ids refuses and revokes nothing', async () => {
    const h = await setup()
    const ids = await h.mintLinks('u-alice', 3)
    const { session } = await h.rootSession()
    await expect(
      h.rootAs(session.id).revokeCredentials({ ids, confirmCount: 2 }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(await h.live()).toHaveLength(3)
  })

  it('SECURITY: duplicate ids refuse — a count must mean distinct credentials', async () => {
    const h = await setup()
    const [a] = await h.mintLinks('u-alice', 1)
    const { session } = await h.rootSession()
    await expect(
      h.rootAs(session.id).revokeCredentials({
        ids: [a ?? '', a ?? ''],
        confirmCount: 2,
      }),
    ).rejects.toThrow()
    expect(await h.live()).toHaveLength(1)
  })

  it('SECURITY: never ends the caller’s own current login session, even when it is listed', async () => {
    const h = await setup()
    const here = await h.rootSession()
    const elsewhere = await h.rootSession()
    const alice = await h.sessions.create({
      userId: 'u-alice',
      method: 'password',
      refreshable: false,
      lifetimeMs: 3_600_000,
    })

    const result = await h.rootAs(here.session.id).revokeCredentials({
      ids: [here.session.id, elsewhere.session.id, alice.session.id],
      confirmCount: 3,
    })

    expect(result.revoked.toSorted()).toEqual([elsewhere.session.id, alice.session.id].toSorted())
    expect(result.skipped).toEqual([{ id: here.session.id, reason: 'current-session' }])
    expect(h.sessions.check(here.session.id).state).toBe('active')
    expect(h.sessions.check(elsewhere.session.id).state).toBe('revoked')
    expect(h.sessions.check(alice.session.id).state).toBe('revoked')
  })

  it('SECURITY: a listed session never moves the user-wide cutoff (other sessions survive)', async () => {
    const h = await setup()
    const here = await h.rootSession()
    const a = await h.sessions.create({
      userId: 'u-alice',
      method: 'password',
      refreshable: false,
      lifetimeMs: 3_600_000,
    })
    const b = await h.sessions.create({
      userId: 'u-alice',
      method: 'password',
      refreshable: false,
      lifetimeMs: 3_600_000,
    })
    await h.rootAs(here.session.id).revokeCredentials({
      ids: [a.session.id],
      confirmCount: 1,
    })
    expect(h.sessions.check(b.session.id).state).toBe('active')
    expect(h.sessions.legacyCutoff('u-alice')).toBe(0)
  })

  it('revokes only the listed admin tokens; an unknown or already revoked one is reported, not counted', async () => {
    const h = await setup()
    const { session } = await h.rootSession()
    const a = await h.mintAdmin('a')
    const b = await h.mintAdmin('b')
    const c = await h.mintAdmin('c')
    await h.tokens.revoke(c.record.id)

    const result = await h.rootAs(session.id).revokeCredentials({
      ids: [a.record.id, c.record.id, 'nope'],
      confirmCount: 3,
    })

    expect(result.revoked).toEqual([a.record.id])
    expect(result.skipped).toEqual([
      { id: c.record.id, reason: 'not-active' },
      { id: 'nope', reason: 'not-active' },
    ])
    expect(await h.live()).toContain(b.record.id)
  })

  it('SECURITY: an admin token cannot bulk-revoke — and so can never revoke itself', async () => {
    const h = await setup()
    const a = await h.mintAdmin('ops')
    const viaToken = h.as({
      id: 'u-root',
      isAdmin: true,
      permissions: { isAdmin: true, allowedProviders: '*', allowedDevices: {} },
      scopes: ['*'],
      interactive: false,
      userDelegated: false,
      credentialId: a.record.id,
    })
    await expect(
      viaToken.revokeCredentials({ ids: [a.record.id], confirmCount: 1 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await h.live()).toEqual([a.record.id])
  })

  it('SECURITY: a non-admin cannot bulk-revoke', async () => {
    const h = await setup()
    const ids = await h.mintLinks('u-alice', 1)
    await expect(
      h.as({ id: 'u-alice' }).revokeCredentials({ ids, confirmCount: 1 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await h.live()).toHaveLength(1)
  })

  it('audits every bulk revoke: who, how many, which ids', async () => {
    const h = await setup()
    const ids = await h.mintLinks('u-alice', 2)
    const { session } = await h.rootSession()
    await h.rootAs(session.id).revokeCredentials({ ids, confirmCount: 2 })
    const audit = (await h.rootAs(session.id).listAuthAudit()).filter(
      (e) => e.action === 'credentials-revoked',
    )
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      userId: 'u-root',
      detail: { kind: 'by-id', requested: 2, revoked: 2, skipped: 0 },
    })
    expect(String(audit[0]?.detail?.['ids'])).toContain(ids[0] ?? '?')
  })

  it('revokes an active OAuth session and deletes an already-revoked one', async () => {
    const h = await setup()
    const { session } = await h.rootSession()
    h.plantOauthSession('oa-live')
    h.plantOauthSession('oa-dead', Date.now() - 1_000)
    const result = await h.rootAs(session.id).revokeCredentials({
      ids: ['oa-live', 'oa-dead', 'missing'],
      confirmCount: 3,
    })
    expect(result.revoked.toSorted()).toEqual(['oa-dead', 'oa-live'])
    expect(result.skipped).toEqual([{ id: 'missing', reason: 'not-active' }])
    // Active → marked revoked (still listed); already-revoked → removed.
    expect(h.oauthSession('oa-live')?.revokedAt).not.toBeNull()
    expect(h.oauthSession('oa-dead')).toBeUndefined()
  })
})
