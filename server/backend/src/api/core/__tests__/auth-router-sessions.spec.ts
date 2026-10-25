import { describe, expect, it } from 'vitest'
import { sessionHarness } from '../../../auth/__tests__/session-test-harness.js'
import { HandoffCodeService, pkceChallenge } from '../../../core/auth/handoff-code.service.js'
import type { AuthenticatedAgent, TrpcContext } from '../../trpc/trpc.context.js'
import { createAuthLimiters } from '../auth-limits.js'
import { createAuthRouter } from '../auth.router.js'

/**
 * Server-side sessions (security plan §5.1): short access tokens refreshed by
 * a rotating refresh token, logout that revokes on the server, a password
 * change that ends the other sessions — and the legacy (pre-refresh) clients
 * that keep working for one release.
 */

function decodeExp(token: string): number {
  const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString())
  return payload.exp * 1000
}

function setup() {
  const users = [{ id: 'u-alice', username: 'alice', isAdmin: false, password: 'pw-alice-1' }]
  const h = sessionHarness(users)
  const handoffs = new HandoffCodeService()
  const router = createAuthRouter(h.auth, h.registry as never, null, handoffs, undefined, null, {
    sessions: h.backing,
    limiters: createAuthLimiters(),
  })
  const anon = router.createCaller({ user: null })
  /** The principal the tRPC boundary builds from a token, then a caller with it. */
  const as = (token: string) => {
    const payload = h.auth.verifyToken(token)
    const user: AuthenticatedAgent = {
      id: payload.userId ?? '',
      username: payload.username ?? '',
      isAdmin: payload.isAdmin,
      permissions: { isAdmin: payload.isAdmin, allowedProviders: '*', allowedDevices: {} },
      isApiKey: false,
      interactive: true,
      userDelegated: true,
      ...(payload.isAdmin ? { scopes: ['*'] } : {}),
      ...(payload.sid !== undefined ? { sessionId: payload.sid } : {}),
    }
    const ctx: TrpcContext = { user }
    return router.createCaller(ctx)
  }
  return { ...h, router, anon, as, handoffs, users }
}

describe('auth sessions', () => {
  it('a refreshing login gets a ~2 h access token, a refresh token and a session id', async () => {
    const { anon } = setup()
    const before = Date.now()
    const result = await anon.login({
      username: 'alice',
      password: 'pw-alice-1',
      refreshable: true,
    })
    expect(result.refreshToken).toMatch(/^csr_/)
    expect(result.sessionId).toBeTruthy()
    const exp = decodeExp(result.token)
    expect(exp - before).toBeGreaterThan(2 * 3600_000 - 5_000)
    expect(exp - before).toBeLessThanOrEqual(2 * 3600_000 + 5_000)
    expect(result.sessionExpiresAt ?? 0).toBeGreaterThan(before + 29 * 86_400_000)
  })

  it('BACKWARD COMPAT: a legacy login (no refreshable) gets a session-long token and no refresh token', async () => {
    const { anon, auth } = setup()
    const result = await anon.login({ username: 'alice', password: 'pw-alice-1' })
    expect(result.refreshToken).toBeUndefined()
    expect(decodeExp(result.token) - Date.now()).toBeGreaterThan(29 * 86_400_000)
    // …but it IS bound to a session, so logout and revocation still apply.
    expect(auth.verifyToken(result.token).sid).toBe(result.sessionId)
  })

  it('refresh rotates the refresh token and keeps the same session', async () => {
    const { anon, auth } = setup()
    const login = await anon.login({ username: 'alice', password: 'pw-alice-1', refreshable: true })
    const refreshed = await anon.refreshSession({ refreshToken: login.refreshToken ?? '' })
    expect(refreshed.sessionId).toBe(login.sessionId)
    expect(refreshed.refreshToken).not.toBe(login.refreshToken)
    expect(auth.verifyToken(refreshed.token).sid).toBe(login.sessionId)
  })

  it('SECURITY: logout revokes on the server — the access token is refused at once, refresh too', async () => {
    const { anon, auth, as } = setup()
    const login = await anon.login({ username: 'alice', password: 'pw-alice-1', refreshable: true })
    await as(login.token).logout()
    expect(() => auth.verifyToken(login.token)).toThrow(/no longer valid/)
    await expect(
      anon.refreshSession({ refreshToken: login.refreshToken ?? '' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('SECURITY: a revoked session is rejected wherever a token is verified (every surface asks verifyToken)', async () => {
    const { anon, auth, sessions } = setup()
    const login = await anon.login({ username: 'alice', password: 'pw-alice-1' })
    await sessions.revoke(login.sessionId ?? '', 'revoked-by-admin')
    expect(() => auth.verifyToken(login.token)).toThrow()
  })

  it('logout everywhere ends every session of the user, and nobody else’s', async () => {
    const { anon, auth, as } = setup()
    const a = await anon.login({ username: 'alice', password: 'pw-alice-1' })
    const b = await anon.login({ username: 'alice', password: 'pw-alice-1', refreshable: true })
    const result = await as(a.token).logout({ everywhere: true })
    expect(result.revoked).toBe(2)
    expect(() => auth.verifyToken(a.token)).toThrow()
    expect(() => auth.verifyToken(b.token)).toThrow()
  })

  it('SECURITY: a password change keeps THIS session and ends the others', async () => {
    const { anon, auth, as } = setup()
    const here = await anon.login({ username: 'alice', password: 'pw-alice-1', refreshable: true })
    const elsewhere = await anon.login({ username: 'alice', password: 'pw-alice-1' })
    await as(here.token).changeOwnPassword({
      currentPassword: 'pw-alice-1',
      newPassword: 'pw-alice-2-long',
    })
    expect(auth.verifyToken(here.token).sid).toBe(here.sessionId)
    expect(() => auth.verifyToken(elsewhere.token)).toThrow()
  })

  it('lists the caller’s sessions and marks the current one; revoking another works', async () => {
    const { anon, auth, as } = setup()
    const here = await anon.login({ username: 'alice', password: 'pw-alice-1', refreshable: true })
    const other = await anon.login({ username: 'alice', password: 'pw-alice-1' })
    const listed = await as(here.token).listOwnSessions()
    expect(listed).toHaveLength(2)
    expect(listed.find((s) => s.current)?.id).toBe(here.sessionId)
    expect(JSON.stringify(listed)).not.toMatch(/csr_|refreshHash/)
    await as(here.token).revokeOwnSession({ id: other.sessionId ?? '' })
    expect(() => auth.verifyToken(other.token)).toThrow()
  })

  it('BACKWARD COMPAT: the legacy viewer renewal (createHandoffCode + redeem) continues the SAME session', async () => {
    const { anon, auth, as } = setup()
    const login = await anon.login({ username: 'alice', password: 'pw-alice-1' })
    const { code } = await as(login.token).createHandoffCode()
    const renewed = await anon.redeemHandoffCode({ code })
    expect(auth.verifyToken(renewed.token).sid).toBe(login.sessionId)
    expect(decodeExp(renewed.token) - Date.now()).toBeGreaterThan(29 * 86_400_000)
  })

  it('a handoff minted to sign ANOTHER client in opens a separate session', async () => {
    const { anon, auth, as } = setup()
    const login = await anon.login({ username: 'alice', password: 'pw-alice-1', refreshable: true })
    const { code } = await as(login.token).createHandoffCode({
      purpose: 'new-session',
      codeChallenge: pkceChallenge('v'.repeat(64)),
      state: 'st-1',
    })
    const app = await anon.redeemHandoffCode({
      code,
      codeVerifier: 'v'.repeat(64),
      state: 'st-1',
      refreshable: true,
    })
    expect(app.sessionId).not.toBe(login.sessionId)
    expect(app.refreshToken).toMatch(/^csr_/)
    await as(login.token).logout()
    expect(auth.verifyToken(app.token).sid).toBe(app.sessionId)
  })

  it('SECURITY: renewing a session that was revoked meanwhile renews nothing', async () => {
    const { anon, as, sessions } = setup()
    const login = await anon.login({ username: 'alice', password: 'pw-alice-1' })
    const { code } = await as(login.token).createHandoffCode()
    await sessions.revoke(login.sessionId ?? '', 'logout')
    await expect(anon.redeemHandoffCode({ code })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('an admin lists and revokes any user’s sessions', async () => {
    const h = setup()
    const login = await h.anon.login({ username: 'alice', password: 'pw-alice-1' })
    const admin = h.router.createCaller({
      user: {
        id: 'root',
        username: 'root',
        isAdmin: true,
        permissions: { isAdmin: true, allowedProviders: '*', allowedDevices: {} },
        isApiKey: false,
        interactive: true,
        userDelegated: true,
        scopes: ['*'],
      },
    })
    expect(await admin.listSessions({ userId: 'u-alice' })).toHaveLength(1)
    expect(await admin.revokeSessions({ userId: 'u-alice' })).toEqual({ revoked: 1 })
    expect(() => h.auth.verifyToken(login.token)).toThrow()
  })

  it('SECURITY: an OPEN WebSocket whose session was revoked is refused on its next call', async () => {
    const h = setup()
    const login = await h.anon.login({ username: 'alice', password: 'pw-alice-1' })
    const payload = h.auth.verifyToken(login.token)
    const user: AuthenticatedAgent = {
      id: payload.userId ?? '',
      username: 'alice',
      isAdmin: false,
      permissions: { isAdmin: false, allowedProviders: '*', allowedDevices: {} },
      isApiKey: false,
      interactive: true,
      userDelegated: true,
      sessionId: login.sessionId ?? '',
    }
    const socket = h.router.createCaller({
      user,
      sessionLive: () =>
        h.auth.checkSession({
          sid: login.sessionId ?? '',
          userId: 'u-alice',
          isAdmin: false,
          allowedProviders: '*',
          allowedDevices: {},
        }) === null,
    })
    await expect(socket.listOwnSessions()).resolves.toHaveLength(1)
    await h.sessions.revoke(login.sessionId ?? '', 'logout')
    await expect(socket.listOwnSessions()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })
})
