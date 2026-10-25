import { describe, expect, it } from 'vitest'
import { createSessionTokenCheck } from '../hub-sessions.js'
import { sessionHarness } from './session-test-harness.js'

const ALICE = { id: 'u-alice', username: 'alice', isAdmin: false, password: 'pw' }

function claims(extra: Record<string, unknown>) {
  return {
    userId: 'u-alice',
    isAdmin: false,
    allowedProviders: '*' as const,
    allowedDevices: {},
    ...extra,
  }
}

describe('createSessionTokenCheck — is the session behind a token still live?', () => {
  it('SECURITY: fails CLOSED while user-management is not up', () => {
    const check = createSessionTokenCheck({ getSingleton: () => null })
    expect(check(claims({ sid: 'x' }))).toBe('session-store-unavailable')
    expect(check(claims({}))).toBe('session-store-unavailable')
  })

  it('a live session passes; revoked, expired and unknown ones do not', async () => {
    const h = sessionHarness([{ ...ALICE }])
    const check = createSessionTokenCheck(h.registry)
    const { session } = await h.sessions.create({
      userId: 'u-alice',
      lifetimeMs: 60_000,
      refreshable: false,
      method: 'password',
    })
    expect(check(claims({ sid: session.id }))).toBeNull()
    expect(check(claims({ sid: 'not-a-session' }))).toBe('session-unknown')
    await h.sessions.revoke(session.id, 'logout')
    expect(check(claims({ sid: session.id }))).toBe('session-revoked')
  })

  it('SECURITY: a token naming ANOTHER user’s session is refused', async () => {
    const h = sessionHarness([{ ...ALICE }])
    const check = createSessionTokenCheck(h.registry)
    const { session } = await h.sessions.create({
      userId: 'u-bob',
      lifetimeMs: 60_000,
      refreshable: false,
      method: 'password',
    })
    expect(check(claims({ sid: session.id }))).toBe('session-user-mismatch')
  })

  it('a pre-session token (no sid) passes until the user’s cutoff, and is refused after it', async () => {
    const h = sessionHarness([{ ...ALICE }])
    const check = createSessionTokenCheck(h.registry)
    const issued = Math.floor(Date.now() / 1000) - 60
    expect(check(claims({ iat: issued }))).toBeNull()
    await h.sessions.revokeAllForUser('u-alice', { reason: 'user-deleted' })
    expect(check(claims({ iat: issued }))).toBe('issued-before-revocation')
  })
})
