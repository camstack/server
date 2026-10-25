import { describe, expect, it } from 'vitest'
import { readErrorI18n } from '@camstack/types'
import { sessionHarness } from '../../../auth/__tests__/session-test-harness.js'
import { HandoffCodeService } from '../../../core/auth/handoff-code.service.js'
import type { AuthenticatedAgent, TrpcContext } from '../../trpc/trpc.context.js'
import { createAuthLimiters } from '../auth-limits.js'
import { createAuthRouter } from '../auth.router.js'

/**
 * The first-run flow (D728 / D797): the seeded `admin` / `changeme` signs in,
 * is forced to rotate, and must come out of it SIGNED IN with the new password
 * — the rotation is the caller's own change (`changeOwnPassword`), which keeps
 * this session. The forced page once used the admin reset, which ended the
 * caller's own session under the request ("Unknown error"), and a re-login
 * then landed back on the rotation page.
 */

const SEED_PASSWORD = 'changeme'
const NEW_PASSWORD = 'n3w-admin-pw'

function setup() {
  const users = [{ id: 'u-admin', username: 'admin', isAdmin: true, password: SEED_PASSWORD }]
  const h = sessionHarness(users)
  const router = createAuthRouter(
    h.auth,
    h.registry as never,
    null,
    new HandoffCodeService(),
    undefined,
    null,
    { sessions: h.backing, limiters: createAuthLimiters() },
  )
  const anon = router.createCaller({ user: null })
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
  return { ...h, anon, as }
}

describe('first-run password rotation', () => {
  it('seed login → own change → still signed in → the new password signs in, the seed does not', async () => {
    const { anon, as, auth } = setup()
    const first = await anon.login({
      username: 'admin',
      password: SEED_PASSWORD,
      refreshable: true,
    })

    await expect(
      as(first.token).changeOwnPassword({
        currentPassword: SEED_PASSWORD,
        newPassword: NEW_PASSWORD,
      }),
    ).resolves.toEqual({ success: true })

    // The session that made the change survives it: no sign-out under the request.
    expect(auth.verifyToken(first.token).sid).toBe(first.sessionId)
    await expect(
      anon.refreshSession({ refreshToken: first.refreshToken ?? '' }),
    ).resolves.toMatchObject({ sessionId: first.sessionId })

    const again = await anon.login({ username: 'admin', password: NEW_PASSWORD, refreshable: true })
    expect(again.token).toBeTruthy()
    await expect(anon.login({ username: 'admin', password: SEED_PASSWORD })).rejects.toThrow()
  })

  it('a wrong current password is refused with its stable code, and nothing changes', async () => {
    const { anon, as } = setup()
    const first = await anon.login({ username: 'admin', password: SEED_PASSWORD })
    const refusal: unknown = await as(first.token)
      .changeOwnPassword({ currentPassword: 'not-the-seed', newPassword: NEW_PASSWORD })
      .then(
        () => null,
        (err: unknown) => err,
      )
    expect(readErrorI18n(refusal)?.code).toBe('auth.password-incorrect')
    await expect(anon.login({ username: 'admin', password: SEED_PASSWORD })).resolves.toMatchObject(
      { sessionId: expect.any(String) },
    )
  })
})
