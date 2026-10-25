/**
 * The login / refresh contract the CLI persists and refreshes a session by
 * (D892, D884). Pinned field by field: a client that asked `refreshable: true`
 * gets the refresh token and both expiries from EVERY login leg, and the
 * refresh rotates the refresh token.
 *
 *   auth.login / auth.loginVerifyTotp({ …, refreshable: true }) →
 *     { token, user: { id, username, isAdmin }, requiresTotp: false,
 *       expiresAt, sessionId, sessionExpiresAt, refreshToken }
 *   auth.refreshSession({ refreshToken }) →
 *     { token, refreshToken, expiresAt, sessionId, sessionExpiresAt, user }
 */
import { describe, expect, it } from 'vitest'
import { sessionHarness } from '../../../auth/__tests__/session-test-harness.js'
import { createAuthLimiters } from '../auth-limits.js'
import { createAuthRouter } from '../auth.router.js'

function setup() {
  const h = sessionHarness([
    { id: 'u-alice', username: 'alice', isAdmin: false, password: 'pw-alice-1' },
  ])
  // The second factor this contract's TOTP leg proves.
  Reflect.set(h.userManagement, 'verifyTotp', async () => ({ valid: true }))
  const router = createAuthRouter(h.auth, h.registry as never, null, undefined, undefined, null, {
    sessions: h.backing,
    limiters: createAuthLimiters(),
  })
  return { ...h, anon: router.createCaller({ user: null }) }
}

const SESSION_SHAPE = {
  token: expect.any(String),
  user: { id: 'u-alice', username: 'alice', isAdmin: false },
  expiresAt: expect.any(Number),
  sessionId: expect.any(String),
  sessionExpiresAt: expect.any(Number),
  refreshToken: expect.stringMatching(/^csr_/),
}

describe('the session contract the CLI relies on', () => {
  it('auth.login with refreshable: true returns the refresh token and both expiries', async () => {
    const { anon } = setup()
    const login = await anon.login({ username: 'alice', password: 'pw-alice-1', refreshable: true })
    expect(login).toMatchObject({ ...SESSION_SHAPE, requiresTotp: false })
    expect(login.expiresAt ?? 0).toBeGreaterThan(Date.now())
    expect(login.sessionExpiresAt ?? 0).toBeGreaterThanOrEqual(login.expiresAt ?? 0)
  })

  it('auth.loginVerifyTotp with refreshable: true returns the same shape', async () => {
    const { anon, auth } = setup()
    const challengeToken = auth.signTotpChallengeToken({
      userId: 'u-alice',
      username: 'alice',
      isAdmin: false,
    })
    const login = await anon.loginVerifyTotp({ challengeToken, code: '123456', refreshable: true })
    expect(login).toMatchObject({ ...SESSION_SHAPE, requiresTotp: false })
  })

  it('auth.refreshSession rotates: a new access token AND a new refresh token', async () => {
    const { anon } = setup()
    const login = await anon.login({ username: 'alice', password: 'pw-alice-1', refreshable: true })
    const refreshed = await anon.refreshSession({ refreshToken: login.refreshToken ?? '' })
    expect(refreshed).toMatchObject(SESSION_SHAPE)
    expect(refreshed.refreshToken).not.toBe(login.refreshToken)
    expect(refreshed.sessionId).toBe(login.sessionId)
  })
})
