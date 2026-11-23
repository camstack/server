import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { NativeLinkCompletions } from '../native-link-completions.js'
import { createAuthLimiters } from '../../api/core/auth-limits.js'
import { createAuthRouter } from '../../api/core/auth.router.js'
import type { AuthenticatedAgent } from '../../api/trpc/trpc.context.js'
import { HandoffCodeService } from '../../core/auth/handoff-code.service.js'
import { AppConfirmations } from '../app-confirmations.js'
import { DEFAULT_AUTH_NETWORK_POLICY } from '../auth-network-policy.js'
import { createRateLimiter } from '../auth-rate-limit.js'
import { ExternalLinkIntents } from '../external-link-intents.js'
import { createSessionMinter } from '../session-mint.js'
import { registerSsoRoutes } from '../sso-routes.js'
import { UsedBridgeIds } from '../used-bridge-ids.js'
import { sessionHarness } from './session-test-harness.js'

/**
 * D1094 through the REAL route: the session a browser handoff opens is tied to
 * the session that minted the code, so signing the parent out ends it too.
 */
async function setup() {
  const h = sessionHarness([{ id: 'u-alice', username: 'alice', isAdmin: false, password: 'pw' }])
  const browserHandoffs = new HandoffCodeService()
  const minter = createSessionMinter({
    signer: h.auth,
    directory: () => h.userManagement,
    sessions: () => h.backing(),
  })
  const router = createAuthRouter(
    h.auth,
    h.registry as never,
    null,
    new HandoffCodeService(),
    undefined,
    {
      completions: new NativeLinkCompletions(),
      browserHandoffs,
      link: async () => 'linked' as const,
    },
    { sessions: h.backing, limiters: createAuthLimiters() },
  )
  const fastify = Fastify()
  registerSsoRoutes(fastify, {
    wiring: {
      auth: h.auth,
      registry: h.registry,
      moleculer: null,
      minter,
      linkIntents: new ExternalLinkIntents(),
      nativeLinks: new NativeLinkCompletions(),
      usedBridgeIds: new UsedBridgeIds(),
    } as never,
    network: DEFAULT_AUTH_NETWORK_POLICY,
    limiter: createRateLimiter({ windowMs: 60_000, max: 30 }),
    browserHandoffCodes: browserHandoffs,
    confirmations: new AppConfirmations(),
    minter,
    logger: { error: () => undefined, warn: () => undefined },
  })
  await fastify.ready()
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
      ...(payload.sid !== undefined ? { sessionId: payload.sid } : {}),
    }
    return router.createCaller({ user })
  }
  return { h, fastify, browserHandoffs, anon, as }
}

describe('/api/auth/browser-handoff — the child session follows its parent (D1094)', () => {
  it('SECURITY: logging the parent out revokes the session the redeemed code opened', async () => {
    const { h, fastify, browserHandoffs, anon, as } = await setup()
    const parent = await anon.login({ username: 'alice', password: 'pw', refreshable: true })
    const { code } = browserHandoffs.create('u-alice', {
      purpose: 'new-session',
      sessionId: parent.sessionId ?? '',
    })
    const res = await fastify.inject({
      method: 'GET',
      url: `/api/auth/browser-handoff?code=${encodeURIComponent(code)}&destination=admin`,
    })
    expect(res.statusCode).toBe(302)
    expect(h.sessions.listActive()).toHaveLength(2)

    await as(parent.token).logout()

    expect(h.sessions.listActive()).toHaveLength(0)
    await fastify.close()
  })
})
