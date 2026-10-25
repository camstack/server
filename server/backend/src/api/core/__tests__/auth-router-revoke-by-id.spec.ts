/**
 * `auth.revokeCredentials` revokes BY CREDENTIAL ID (D892): one call can name
 * a token (admin, scoped or share link — one store, D895), a login session and
 * an account link at once, with no `kind`, and each is found in its own store.
 * The caller's own session is still skipped and reported.
 *
 * Disarm: make `revokerById` return 'not-active' for every id → every row of
 * the first case lands in `skipped`.
 */
import { makeInMemoryRecords } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { sessionHarness } from '../../../auth/__tests__/session-test-harness.js'
import { userManagementInternal } from '../../../auth/hub-sessions.js'
import { CredentialTokenService } from '../../../core/auth/credential-token.service.js'
import { coreAuthRecordKinds } from '../../../core/auth/record-kinds.js'
import { createAuthLimiters } from '../auth-limits.js'
import { createAuthRouter } from '../auth.router.js'

async function setup() {
  const h = sessionHarness([
    { id: 'u-root', username: 'root', isAdmin: true, password: 'pw-root-1' },
    { id: 'u-alice', username: 'alice', isAdmin: false, password: 'pw-alice-1' },
  ])
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
  const internal = userManagementInternal(h.registry as never)
  if (internal === null) throw new Error('no internal')
  const session = await h.sessions.create({
    userId: 'u-root',
    method: 'password',
    refreshable: false,
    lifetimeMs: 3_600_000,
  })
  const root = router.createCaller({
    user: {
      id: 'u-root',
      username: 'root',
      isAdmin: true,
      permissions: { isAdmin: true, allowedProviders: '*', allowedDevices: {} },
      isApiKey: false,
      interactive: true,
      userDelegated: true,
      scopes: ['*'],
      sessionId: session.session.id,
      credentialId: session.session.id,
    },
  })
  return { ...h, root, tokens, internal, ownSession: session.session.id }
}

describe('auth.revokeCredentials — by credential id, not kind', () => {
  it('revokes a scoped token, a session, an admin token, a share link and an account link in one call', async () => {
    const h = await setup()
    const unified = await h.tokens.mint({
      subjectId: 'u-alice',
      createdBy: 'u-alice',
      label: 'ci',
      scopes: [{ type: 'capability', target: 'user-management', access: ['view'] }],
      expiresAt: Date.now() + 86_400_000,
    })
    const alice = await h.sessions.create({
      userId: 'u-alice',
      method: 'password',
      refreshable: false,
      lifetimeMs: 3_600_000,
    })
    const admin = await h.tokens.mint({
      subjectId: 'u-root',
      createdBy: 'u-root',
      label: 'ops',
      scopes: ['*'],
      expiresAt: Date.now() + 86_400_000,
    })
    const share = await h.tokens.mint({
      subjectId: 'u-alice',
      createdBy: 'u-alice',
      label: 'wall',
      scopes: [{ type: 'share-view', grant: { kind: 'grid-view', deviceIds: [1] } }],
      expiresAt: null,
    })
    h.plantOauthSession('oa-ha')
    const ids = [unified.record.id, alice.session.id, admin.record.id, share.record.id, 'oa-ha']
    const result = await h.root.revokeCredentials({ ids, confirmCount: ids.length })
    expect(result).toEqual({ revoked: ids, skipped: [] })
    expect(await h.tokens.lookupLive('x'.repeat(16))).toBeNull()
    expect((await h.tokens.get(unified.record.id))?.revokedAt).not.toBeNull()
    expect(h.internal.sessions.check(alice.session.id).state).not.toBe('active')
    expect((await h.tokens.get(admin.record.id))?.revokedAt).not.toBeNull()
    expect((await h.tokens.get(share.record.id))?.revokedAt).not.toBeNull()
    expect(h.oauthSession('oa-ha')?.revokedAt).not.toBeNull()
  })

  it("never revokes the caller's own session, and says so", async () => {
    const h = await setup()
    const result = await h.root.revokeCredentials({ ids: [h.ownSession, 'nope'], confirmCount: 2 })
    expect(result).toEqual({
      revoked: [],
      skipped: [
        { id: h.ownSession, reason: 'current-session' },
        { id: 'nope', reason: 'not-active' },
      ],
    })
  })
})
