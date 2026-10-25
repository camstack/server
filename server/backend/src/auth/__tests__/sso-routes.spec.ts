import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { HandoffCodeService } from '../../core/auth/handoff-code.service.js'
import { AppConfirmations } from '../app-confirmations.js'
import { DEFAULT_AUTH_NETWORK_POLICY } from '../auth-network-policy.js'
import { createRateLimiter } from '../auth-rate-limit.js'
import { ExternalLinkIntents } from '../external-link-intents.js'
import { NativeLinkCompletions } from '../native-link-completions.js'
import type { SessionMinter } from '../session-mint.js'
import { registerSsoRoutes } from '../sso-routes.js'
import { UsedBridgeIds } from '../used-bridge-ids.js'

/** The route around the finish: it limits, and it always spends the state cookie. */
async function app(max = 30) {
  const fastify = Fastify()
  const minter = {} as SessionMinter
  registerSsoRoutes(fastify, {
    wiring: {
      auth: { verifySsoBridgeToken: () => null, verifyToken: () => ({}) } as never,
      registry: { getSingleton: () => null, isProviderDisabled: () => false } as never,
      moleculer: null,
      minter,
      linkIntents: new ExternalLinkIntents(),
      nativeLinks: new NativeLinkCompletions(),
      usedBridgeIds: new UsedBridgeIds(),
    },
    network: DEFAULT_AUTH_NETWORK_POLICY,
    limiter: createRateLimiter({ windowMs: 60_000, max }),
    browserHandoffCodes: new HandoffCodeService(),
    confirmations: new AppConfirmations(),
    minter,
    logger: { error: () => undefined, warn: () => undefined },
  })
  await fastify.ready()
  return fastify
}

describe('/api/auth/sso/finish route', () => {
  it('clears the SSO state cookie on every answer, even a refusal', async () => {
    const fastify = await app()
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/auth/sso/finish?bridge=forged',
      headers: { cookie: 'camstack_sso_state=abc' },
    })
    expect(res.statusCode).toBe(401)
    expect(String(res.headers['set-cookie'])).toMatch(/^camstack_sso_state=; .*Max-Age=0/)
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    await fastify.close()
  })

  it('limits per REAL client address (tunnelled clients get their own bucket)', async () => {
    const fastify = await app(2)
    const from = (ip: string) =>
      fastify.inject({
        method: 'GET',
        url: '/api/auth/sso/finish?bridge=x',
        remoteAddress: '127.0.0.1',
        headers: { 'cf-connecting-ip': ip },
      })
    await from('203.0.113.1')
    await from('203.0.113.1')
    expect((await from('203.0.113.1')).statusCode).toBe(429)
    expect((await from('198.51.100.1')).statusCode).toBe(401)
    await fastify.close()
  })
})
