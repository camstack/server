import { describe, expect, it, vi } from 'vitest'
import { sessionHarness } from '../../../auth/__tests__/session-test-harness.js'
import type { AuthenticatedAgent } from '../../trpc/trpc.context.js'
import { createAuthLimiters } from '../auth-limits.js'
import { createAuthRouter } from '../auth.router.js'

/**
 * Re-authentication (security plan §3.3): linking a sign-in account,
 * disabling TOTP and removing a passkey need a fresh proof — the current
 * password or a passkey — not just a session someone may have stolen.
 */

function setup() {
  const users = [
    { id: 'u-alice', username: 'alice', isAdmin: false, password: 'pw-alice-1' },
    { id: 'u-bob', username: 'bob', isAdmin: false, password: 'pw-bob-12' },
  ]
  const h = sessionHarness(users)
  const disableTotp = vi.fn(async () => ({ success: true as const }))
  Object.assign(h.userManagement, { disableTotp })
  const router = createAuthRouter(h.auth, h.registry as never, null, undefined, undefined, null, {
    sessions: h.backing,
    limiters: createAuthLimiters(),
  })
  const as = (id: string, sessionId?: string) => {
    const user: AuthenticatedAgent = {
      id,
      username: id === 'u-alice' ? 'alice' : 'bob',
      isAdmin: false,
      permissions: { isAdmin: false, allowedProviders: '*', allowedDevices: {} },
      isApiKey: false,
      interactive: true,
      userDelegated: true,
      ...(sessionId !== undefined ? { sessionId } : {}),
    }
    return router.createCaller({ user })
  }
  return { ...h, router, as, disableTotp }
}

describe('re-authentication', () => {
  it('the current password yields a proof; a wrong one is refused', async () => {
    const { as } = setup()
    const proof = await as('u-alice').reauthenticate({ password: 'pw-alice-1' })
    expect(proof.method).toBe('password')
    expect(proof.reauthToken.length).toBeGreaterThan(20)
    await expect(as('u-alice').reauthenticate({ password: 'nope' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })

  it('SECURITY: disabling TOTP without a proof is refused, with one it works', async () => {
    const { as, disableTotp } = setup()
    await expect(as('u-alice').disableOwnTotp()).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(disableTotp).not.toHaveBeenCalled()
    const { reauthToken } = await as('u-alice').reauthenticate({ password: 'pw-alice-1' })
    await as('u-alice').disableOwnTotp({ reauthToken })
    expect(disableTotp).toHaveBeenCalledWith({ userId: 'u-alice' })
  })

  it("SECURITY: another user's proof is refused", async () => {
    const { as } = setup()
    const { reauthToken } = await as('u-bob').reauthenticate({ password: 'pw-bob-12' })
    await expect(as('u-alice').disableOwnTotp({ reauthToken })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('SECURITY: a proof made in ANOTHER session of the same user is refused', async () => {
    const { as, sessions } = setup()
    const a = await sessions.create({
      userId: 'u-alice',
      lifetimeMs: 3_600_000,
      refreshable: false,
      method: 'password',
    })
    const b = await sessions.create({
      userId: 'u-alice',
      lifetimeMs: 3_600_000,
      refreshable: false,
      method: 'password',
    })
    const { reauthToken } = await as('u-alice', a.session.id).reauthenticate({
      password: 'pw-alice-1',
    })
    await expect(as('u-alice', b.session.id).disableOwnTotp({ reauthToken })).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    )
  })

  it('SECURITY: a forged or expired proof is refused, and a session token is no proof', async () => {
    const { as, auth } = setup()
    await expect(as('u-alice').disableOwnTotp({ reauthToken: 'garbage' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    const expired = auth.signReauthToken({ userId: 'u-alice', method: 'password' }, -10)
    await expect(as('u-alice').disableOwnTotp({ reauthToken: expired })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    const challenge = auth.signTotpChallengeToken({
      userId: 'u-alice',
      username: 'alice',
      isAdmin: false,
    })
    await expect(as('u-alice').disableOwnTotp({ reauthToken: challenge })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('SECURITY: removing a passkey and beginning a link need the proof too', async () => {
    const { as } = setup()
    await expect(as('u-alice').removeOwnPasskey({ credentialId: 'c' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
    await expect(
      as('u-alice').beginExternalLink({ provider: 'auth-oidc/x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('a re-auth proof is never a bearer credential', async () => {
    const { auth } = setup()
    const token = auth.signReauthToken({ userId: 'u-alice', method: 'password' })
    expect(Reflect.get(auth.verifyToken(token), 'kind')).toBe('reauth')
  })
})
