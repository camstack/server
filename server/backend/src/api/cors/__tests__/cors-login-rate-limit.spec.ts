import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AuthService } from '../../../core/auth/auth.service.js'
import { ConfigService } from '../../../core/config/config.service.js'
import { createAuthRouter } from '../../core/auth.router.js'
import type { TrpcContext } from '../../trpc/trpc.context.js'
import { trpcRouter } from '../../trpc/trpc.middleware.js'
import { VIEWER_PWA_ORIGIN } from '../cors-policy.js'
import { createCorsPolicy, registerCorsPolicy } from '../register-cors-policy.js'
import { staticJwtSigningKey } from '@camstack/system'

/**
 * D707 opens the hub to a cross-origin login page; it must not open a way
 * around the credential limiter. A cross-origin `auth.login` goes through the
 * same rate-limited procedure as a same-origin one — and its 429 is READABLE
 * by the PWA (it carries the grant), so the viewer can say "retry later"
 * instead of reporting a network error.
 */
describe('cross-origin auth.login keeps its rate limit', () => {
  let dir: string
  let fastify: FastifyInstance

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'cors-login-'))
    const auth = new AuthService(
      new ConfigService(path.join(dir, 'config.yaml')),
      undefined,
      staticJwtSigningKey('unit-test-secret'),
    )
    fastify = Fastify()
    registerCorsPolicy(
      fastify,
      createCorsPolicy({
        configuredOrigins: () => [],
        logger: { warn: () => undefined },
      }),
    )
    // No user-management provider: every attempt fails AFTER the limiter, which
    // is the gate under test.
    await fastify.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: {
        router: trpcRouter({ auth: createAuthRouter(auth, null) }),
        createContext: ({ req }: { req: FastifyRequest }): TrpcContext => ({ user: null, req }),
      },
    })
    await fastify.ready()
  })

  afterAll(async () => {
    await fastify.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('the 11th attempt within a minute from the PWA is refused 429, with the CORS grant', async () => {
    const attempt = () =>
      fastify.inject({
        method: 'POST',
        url: '/trpc/auth.login',
        remoteAddress: '203.0.113.7',
        headers: { origin: VIEWER_PWA_ORIGIN, 'content-type': 'application/json' },
        payload: JSON.stringify({ json: { username: 'admin', password: 'wrong' } }),
      })

    const statuses: number[] = []
    for (let i = 0; i < 10; i += 1) statuses.push((await attempt()).statusCode)
    expect(statuses.every((s) => s !== 429)).toBe(true)

    const limited = await attempt()
    expect(limited.statusCode).toBe(429)
    expect(limited.headers['access-control-allow-origin']).toBe(VIEWER_PWA_ORIGIN)
  })
})
