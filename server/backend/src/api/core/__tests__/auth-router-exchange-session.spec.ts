/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- mock factories cross typed boundaries */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import { createAuthRouter, EXCHANGE_SESSION_HEADER } from '../auth.router.js'
import { AuthService } from '../../../core/auth/auth.service.js'
import { SESSION_COOKIE } from '../../../auth/session-cookie.js'
import { trpcRouter } from '../../trpc/trpc.middleware.js'
import { staticJwtSigningKey } from '@camstack/system'
import type { TrpcContext } from '../../trpc/trpc.context.js'

/**
 * `auth.exchangeSession` — upgrade the httpOnly session COOKIE into a
 * bearer token (viewer same-origin session reuse, Phase 1).
 *
 * Two layers:
 *   • router-caller tests (fast, exhaustive failure matrix);
 *   • an HTTP-level test over a REAL fastify + tRPC adapter using the
 *     EXACT raw-fetch wire format the viewer web client sends
 *     (POST /trpc/auth.exchangeSession, body `{"json":{}}`, cookie +
 *     CSRF header) — empirically pins the protocol contract.
 */

interface MockUserRecord {
  id: string
  username: string
  isAdmin: boolean
  allowedProviders: string | string[]
  allowedDevices: Record<string, unknown>
  scopes: unknown[]
}

function makeUserRecord(overrides: Partial<MockUserRecord> = {}): MockUserRecord {
  return {
    id: 'u-1',
    username: 'alice',
    isAdmin: false,
    allowedProviders: '*',
    allowedDevices: {},
    scopes: [],
    ...overrides,
  }
}

function makeRegistry(users: MockUserRecord[]): {
  getSingleton: (name: string) => unknown
  getCollection: (name: string) => unknown[]
} {
  return {
    getSingleton: (name: string) =>
      name === 'user-management' ? { listUsers: async () => users } : null,
    getCollection: () => [],
  }
}

function makeConfig(): { get<T>(p: string): T; update(): void } {
  const store: Record<string, unknown> = {}
  return {
    get<T>(path: string): T {
      return store[path] as T
    },
    update(): void {
      /* no-op */
    },
  }
}

/** Build a bare IncomingMessage carrying the given headers — the shape
 *  `TrpcContext.req` accepts without any cast. */
function makeRequest(headers: Record<string, string>): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  for (const [name, value] of Object.entries(headers)) {
    req.headers[name] = value
  }
  return req
}

function signSession(auth: AuthService, record: MockUserRecord): string {
  return auth.signToken({
    userId: record.id,
    username: record.username,
    isAdmin: record.isAdmin,
    allowedProviders: record.allowedProviders === '*' ? '*' : ['x'],
    allowedDevices: {},
    scopes: [],
  })
}

describe('auth.exchangeSession — router caller', () => {
  let auth: AuthService
  let router: ReturnType<typeof createAuthRouter>
  let sessionToken: string

  beforeEach(() => {
    auth = new AuthService(
      makeConfig() as never,
      undefined,
      staticJwtSigningKey('unit-test-secret'),
    )
    router = createAuthRouter(auth, makeRegistry([makeUserRecord()]) as never)
    sessionToken = signSession(auth, makeUserRecord())
  })

  function caller(headers: Record<string, string>) {
    const ctx: TrpcContext = { user: null, req: makeRequest(headers) }
    return router.createCaller(ctx)
  }

  it('valid cookie + CSRF header → a fresh bearer that verifies as the same user', async () => {
    const result = await caller({
      cookie: `${SESSION_COOKIE}=${sessionToken}`,
      [EXCHANGE_SESSION_HEADER]: '1',
    }).exchangeSession({})

    expect(result.user).toEqual({ id: 'u-1', username: 'alice', isAdmin: false })
    const payload = auth.verifyToken(result.token)
    expect(payload.userId).toBe('u-1')
    expect(payload.isAdmin).toBe(false)
    // The bearer is a REAL v2 session (not a challenge/bridge token).
    expect(auth.verifyTotpChallengeToken(result.token)).toBeNull()
    expect(auth.verifySsoBridgeToken(result.token)).toBeNull()
  })

  it('missing CSRF header → FORBIDDEN (cookie alone is not enough)', async () => {
    await expect(
      caller({ cookie: `${SESSION_COOKIE}=${sessionToken}` }).exchangeSession({}),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('no cookie → UNAUTHORIZED', async () => {
    await expect(
      caller({ [EXCHANGE_SESSION_HEADER]: '1' }).exchangeSession({}),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('garbage cookie → UNAUTHORIZED', async () => {
    await expect(
      caller({
        cookie: `${SESSION_COOKIE}=not-a-jwt`,
        [EXCHANGE_SESSION_HEADER]: '1',
      }).exchangeSession({}),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('a 2FA challenge token in the cookie is NOT a session → UNAUTHORIZED', async () => {
    const challenge = auth.signTotpChallengeToken({
      userId: 'u-1',
      username: 'alice',
      isAdmin: true,
    })
    await expect(
      caller({
        cookie: `${SESSION_COOKIE}=${challenge}`,
        [EXCHANGE_SESSION_HEADER]: '1',
      }).exchangeSession({}),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('user deleted after the cookie was minted → UNAUTHORIZED', async () => {
    const emptyRouter = createAuthRouter(auth, makeRegistry([]) as never)
    const ctx: TrpcContext = {
      user: null,
      req: makeRequest({
        cookie: `${SESSION_COOKIE}=${sessionToken}`,
        [EXCHANGE_SESSION_HEADER]: '1',
      }),
    }
    await expect(emptyRouter.createCaller(ctx).exchangeSession({})).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })

  it('no request on the context (mesh-originated call) → UNAUTHORIZED path, never a crash', async () => {
    const ctx: TrpcContext = { user: null }
    await expect(router.createCaller(ctx).exchangeSession({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })
})

describe('auth.exchangeSession — HTTP wire contract (raw fetch shape)', () => {
  let fastify: FastifyInstance
  let auth: AuthService
  let sessionToken: string

  beforeEach(async () => {
    auth = new AuthService(
      makeConfig() as never,
      undefined,
      staticJwtSigningKey('unit-test-secret'),
    )
    sessionToken = signSession(auth, makeUserRecord())
    const authRouter = createAuthRouter(auth, makeRegistry([makeUserRecord()]) as never)
    fastify = Fastify()
    await fastify.register(fastifyTRPCPlugin, {
      prefix: '/trpc',
      trpcOptions: {
        router: trpcRouter({ auth: authRouter }),
        createContext: ({ req }: { req: FastifyRequest }): TrpcContext => ({ user: null, req }),
      },
    })
    await fastify.ready()
  })

  afterEach(async () => {
    await fastify.close()
  })

  it('POST /trpc/auth.exchangeSession with cookie + header → 200 + bearer (superjson envelope)', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/trpc/auth.exchangeSession',
      headers: {
        'content-type': 'application/json',
        cookie: `${SESSION_COOKIE}=${sessionToken}`,
        [EXCHANGE_SESSION_HEADER]: '1',
      },
      payload: '{"json":{}}',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      result: { data: { json: { token: string; user: { id: string } } } }
    }
    const data = body.result.data.json
    expect(data.user.id).toBe('u-1')
    expect(auth.verifyToken(data.token).userId).toBe('u-1')
  })

  it('missing CSRF header → HTTP 403', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/trpc/auth.exchangeSession',
      headers: {
        'content-type': 'application/json',
        cookie: `${SESSION_COOKIE}=${sessionToken}`,
      },
      payload: '{"json":{}}',
    })
    expect(res.statusCode).toBe(403)
  })

  it('no cookie → HTTP 401', async () => {
    const res = await fastify.inject({
      method: 'POST',
      url: '/trpc/auth.exchangeSession',
      headers: {
        'content-type': 'application/json',
        [EXCHANGE_SESSION_HEADER]: '1',
      },
      payload: '{"json":{}}',
    })
    expect(res.statusCode).toBe(401)
  })
})
