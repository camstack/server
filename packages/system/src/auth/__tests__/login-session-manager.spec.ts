import type { SettingsStoreClient } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeStore } from '../../builtins/local-auth/__tests__/memory-settings-store.js'
import { LoginSessionManager } from '../login-session-manager.js'

const DAY = 86_400_000
const MONTH = 30 * DAY

function manager(start = 1_000_000) {
  let now = start
  const store = makeStore() as unknown as SettingsStoreClient
  const sessions = new LoginSessionManager(store, { now: () => now })
  return {
    sessions,
    store,
    advance: (ms: number) => {
      now += ms
    },
    at: () => now,
  }
}

describe('LoginSessionManager', () => {
  it('a new session is active, carries its user and expires one lifetime later', async () => {
    const { sessions, at } = manager()
    const { session, refreshToken } = await sessions.create({
      userId: 'u-1',
      lifetimeMs: MONTH,
      refreshable: true,
      method: 'password',
      client: 'Firefox',
      ip: '203.0.113.4',
    })
    expect(sessions.check(session.id)).toMatchObject({ state: 'active' })
    expect(session.userId).toBe('u-1')
    expect(session.expiresAt).toBe(at() + MONTH)
    expect(refreshToken).toMatch(/^csr_[A-Za-z0-9_-]{40,}$/)
  })

  it('a legacy (non-refreshable) session has no refresh token', async () => {
    const { sessions } = manager()
    const { refreshToken } = await sessions.create({
      userId: 'u-1',
      lifetimeMs: MONTH,
      refreshable: false,
      method: 'password',
    })
    expect(refreshToken).toBeNull()
  })

  it('refresh rotates the token and slides the expiry', async () => {
    const { sessions, advance, at } = manager()
    const created = await sessions.create({
      userId: 'u-1',
      lifetimeMs: MONTH,
      refreshable: true,
      method: 'password',
    })
    advance(DAY)
    const refreshed = await sessions.refresh(created.refreshToken ?? '', MONTH)
    if (!refreshed.ok) throw new Error(refreshed.reason)
    expect(refreshed.session.id).toBe(created.session.id)
    expect(refreshed.refreshToken).not.toBe(created.refreshToken)
    expect(refreshed.session.expiresAt).toBe(at() + MONTH)
  })

  it('SECURITY: an old refresh token presented after the grace window revokes the whole session (theft)', async () => {
    const { sessions, advance } = manager()
    const created = await sessions.create({
      userId: 'u-1',
      lifetimeMs: MONTH,
      refreshable: true,
      method: 'password',
    })
    const first = await sessions.refresh(created.refreshToken ?? '', MONTH)
    if (!first.ok) throw new Error(first.reason)
    advance(5 * 60_000)
    expect(await sessions.refresh(created.refreshToken ?? '', MONTH)).toEqual({
      ok: false,
      reason: 'reused',
    })
    expect(sessions.check(created.session.id).state).toBe('revoked')
    // …and the thief's fresh token is dead with it.
    expect((await sessions.refresh(first.refreshToken, MONTH)).ok).toBe(false)
  })

  it('two tabs refreshing at once (inside the grace window) do not log the user out', async () => {
    const { sessions, advance } = manager()
    const created = await sessions.create({
      userId: 'u-1',
      lifetimeMs: MONTH,
      refreshable: true,
      method: 'password',
    })
    const tabA = await sessions.refresh(created.refreshToken ?? '', MONTH)
    advance(2_000)
    const tabB = await sessions.refresh(created.refreshToken ?? '', MONTH)
    expect(tabA.ok && tabB.ok).toBe(true)
    expect(sessions.check(created.session.id).state).toBe('active')
  })

  it('an unknown or garbage refresh token is refused without touching anything', async () => {
    const { sessions } = manager()
    expect(await sessions.refresh('csr_nope', MONTH)).toEqual({ ok: false, reason: 'unknown' })
    expect(await sessions.refresh('', MONTH)).toEqual({ ok: false, reason: 'unknown' })
  })

  it('an expired session cannot be refreshed and checks expired', async () => {
    const { sessions, advance } = manager()
    const created = await sessions.create({
      userId: 'u-1',
      lifetimeMs: DAY,
      refreshable: true,
      method: 'password',
    })
    advance(DAY + 1)
    expect(sessions.check(created.session.id).state).toBe('expired')
    expect(await sessions.refresh(created.refreshToken ?? '', DAY)).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('revoke ends one session at once; refresh is refused after it', async () => {
    const { sessions } = manager()
    const a = await sessions.create({
      userId: 'u-1',
      lifetimeMs: MONTH,
      refreshable: true,
      method: 'password',
    })
    const b = await sessions.create({
      userId: 'u-1',
      lifetimeMs: MONTH,
      refreshable: true,
      method: 'password',
    })
    expect(await sessions.revoke(a.session.id, 'logout')).toBe(true)
    expect(sessions.check(a.session.id).state).toBe('revoked')
    expect(sessions.check(b.session.id).state).toBe('active')
    expect((await sessions.refresh(a.refreshToken ?? '', MONTH)).ok).toBe(false)
  })

  it("revokeAllForUser spares only the named session, never another user's, and sets the legacy cutoff", async () => {
    const { sessions, at, advance } = manager()
    const keep = await sessions.create({
      userId: 'u-1',
      lifetimeMs: MONTH,
      refreshable: true,
      method: 'password',
    })
    const other = await sessions.create({
      userId: 'u-1',
      lifetimeMs: MONTH,
      refreshable: true,
      method: 'passkey',
    })
    const bob = await sessions.create({
      userId: 'u-2',
      lifetimeMs: MONTH,
      refreshable: true,
      method: 'password',
    })
    advance(10)
    const revoked = await sessions.revokeAllForUser('u-1', {
      exceptSessionId: keep.session.id,
      reason: 'password-changed',
    })
    expect(revoked).toBe(1)
    expect(sessions.check(keep.session.id).state).toBe('active')
    expect(sessions.check(other.session.id).state).toBe('revoked')
    expect(sessions.check(bob.session.id).state).toBe('active')
    expect(sessions.legacyCutoff('u-1')).toBe(at())
    expect(sessions.legacyCutoff('u-2')).toBe(0)
  })

  it('state survives a restart: a new manager over the same store knows revocations and cutoffs', async () => {
    const { sessions, store, at } = manager()
    const a = await sessions.create({
      userId: 'u-1',
      lifetimeMs: MONTH,
      refreshable: true,
      method: 'password',
    })
    await sessions.revokeAllForUser('u-1', { reason: 'user-deleted' })
    const reborn = new LoginSessionManager(store, { now: () => at() })
    await reborn.load()
    expect(reborn.check(a.session.id).state).toBe('revoked')
    expect(reborn.legacyCutoff('u-1')).toBe(at())
    expect((await reborn.refresh(a.refreshToken ?? '', MONTH)).ok).toBe(false)
  })

  it('lists a user’s ACTIVE sessions, newest first, without secrets', async () => {
    const { sessions, advance } = manager()
    const a = await sessions.create({
      userId: 'u-1',
      lifetimeMs: MONTH,
      refreshable: true,
      method: 'password',
    })
    advance(5)
    const b = await sessions.create({
      userId: 'u-1',
      lifetimeMs: MONTH,
      refreshable: false,
      method: 'sso',
    })
    await sessions.create({
      userId: 'u-2',
      lifetimeMs: MONTH,
      refreshable: true,
      method: 'password',
    })
    const listed = sessions.listForUser('u-1')
    expect(listed.map((s) => s.id)).toEqual([b.session.id, a.session.id])
    expect(JSON.stringify(listed)).not.toMatch(/refreshHash|csr_/)
  })

  it('reap drops expired and long-revoked rows, keeps the cutoffs', async () => {
    const { sessions, advance } = manager()
    const a = await sessions.create({
      userId: 'u-1',
      lifetimeMs: DAY,
      refreshable: true,
      method: 'password',
    })
    await sessions.revokeAllForUser('u-2', { reason: 'user-deleted' })
    advance(40 * DAY)
    expect(await sessions.reap()).toBe(1)
    expect(sessions.check(a.session.id).state).toBe('unknown')
    expect(sessions.legacyCutoff('u-2')).toBeGreaterThan(0)
  })
})
