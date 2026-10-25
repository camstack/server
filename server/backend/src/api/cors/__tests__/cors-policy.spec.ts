import { createServer, type Server } from 'node:http'
import { proxyToUpstream } from '@camstack/system'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import {
  judgeCorsOrigin,
  normalizeOrigin,
  OPAQUE_ORIGIN,
  parseConfiguredOrigins,
  VIEWER_PWA_ORIGIN,
} from '../cors-policy.js'
import {
  type CorsPolicy,
  createCorsPolicy,
  refuseForeignWsUpgrade,
  registerCorsPolicy,
} from '../register-cors-policy.js'

const HUB_HOST = 'hub.lan:4443'
const FOREIGN = 'https://evil.example'

interface LoggedWarn {
  readonly message: string
  readonly meta: Record<string, unknown> | undefined
}

function makePolicy(configured: () => unknown = () => []): {
  policy: CorsPolicy
  warns: LoggedWarn[]
} {
  const warns: LoggedWarn[] = []
  const policy = createCorsPolicy({
    configuredOrigins: configured,
    logger: { warn: (message, options) => warns.push({ message, meta: options?.meta }) },
  })
  return { policy, warns }
}

const apps: FastifyInstance[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

async function makeApp(policy: CorsPolicy): Promise<FastifyInstance> {
  const app = Fastify()
  apps.push(app)
  registerCorsPolicy(app, policy)
  app.post('/trpc/auth.login', async () => ({ ok: true }))
  app.get('/trpc/health', async () => ({ ok: true }))
  await app.ready()
  return app
}

function preflight(origin: string, extra: Record<string, string> = {}) {
  return {
    method: 'OPTIONS' as const,
    url: '/trpc/auth.login',
    headers: {
      host: HUB_HOST,
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type',
      ...extra,
    },
  }
}

describe('normalizeOrigin / parseConfiguredOrigins', () => {
  it('canonicalises an origin and refuses anything that names a path', () => {
    expect(normalizeOrigin('HTTPS://Camstack.Zentik.App/')).toBe(VIEWER_PWA_ORIGIN)
    expect(normalizeOrigin('https://a.example:443')).toBe('https://a.example')
    expect(normalizeOrigin('null')).toBe(OPAQUE_ORIGIN)
    expect(normalizeOrigin('https://a.example/app')).toBeNull()
    expect(normalizeOrigin('ftp://a.example')).toBeNull()
    expect(normalizeOrigin('*')).toBeNull()
  })

  it('keeps the usable entries and reports the rest', () => {
    expect(parseConfiguredOrigins(['http://localhost:8081', '*', 'https://x.example/p'])).toEqual({
      origins: ['http://localhost:8081'],
      rejected: ['*', 'https://x.example/p'],
    })
    expect(parseConfiguredOrigins(undefined)).toEqual({ origins: [], rejected: [] })
  })
})

describe('judgeCorsOrigin', () => {
  const listed = new Set([VIEWER_PWA_ORIGIN, OPAQUE_ORIGIN])
  const judge = (origin: string | undefined, forwardedHost?: string) =>
    judgeCorsOrigin({ origin, host: HUB_HOST, forwardedHost }, listed)

  it('no Origin is not a CORS request', () => {
    expect(judge(undefined)).toEqual({ kind: 'no-origin' })
  })

  it('allows the hub’s own origin by Host, and a relay’s by X-Forwarded-Host', () => {
    expect(judge('https://hub.lan:4443')).toMatchObject({ kind: 'allowed', reason: 'own-host' })
    expect(judge('http://hub.lan:4443')).toMatchObject({ kind: 'allowed', reason: 'own-host' })
    expect(judge('https://ha.lan:8123', 'ha.lan:8123')).toMatchObject({ kind: 'allowed' })
    // Same host name, different port: a different origin.
    expect(judge('https://hub.lan:9999')).toMatchObject({ kind: 'denied' })
  })

  it('allows the PWA and the opaque origin, denies the rest', () => {
    expect(judge(VIEWER_PWA_ORIGIN)).toMatchObject({ kind: 'allowed', reason: 'listed' })
    expect(judge('null')).toMatchObject({ kind: 'allowed', reason: 'listed' })
    expect(judge(FOREIGN)).toEqual({ kind: 'denied', origin: FOREIGN })
    expect(judge('https://camstack.zentik.app.evil.example')).toMatchObject({ kind: 'denied' })
  })
})

describe('registerCorsPolicy — HTTP', () => {
  it('answers a preflight from the PWA with an exact-origin grant for Authorization', async () => {
    const app = await makeApp(makePolicy().policy)
    const res = await app.inject(preflight(VIEWER_PWA_ORIGIN))

    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe(VIEWER_PWA_ORIGIN)
    expect(String(res.headers['access-control-allow-headers'])).toContain('authorization')
    expect(String(res.headers['access-control-allow-methods'])).toContain('POST')
    expect(res.headers['access-control-max-age']).toBe('7200')
    expect(String(res.headers['vary'])).toContain('Origin')
    // Bearer auth needs no credentials mode; the cookie never goes cross-origin.
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
  })

  it('grants Chromium’s private-network preflight to an allowed origin only', async () => {
    const app = await makeApp(makePolicy().policy)
    const pna = { 'access-control-request-private-network': 'true' }
    const allowed = await app.inject(preflight(VIEWER_PWA_ORIGIN, pna))
    const denied = await app.inject(preflight(FOREIGN, pna))

    expect(allowed.headers['access-control-allow-private-network']).toBe('true')
    expect(denied.headers['access-control-allow-private-network']).toBeUndefined()
  })

  it('gives a denied origin no CORS headers at all, on preflight and on the request', async () => {
    const { policy, warns } = makePolicy()
    const app = await makeApp(policy)
    const pre = await app.inject(preflight(FOREIGN))
    const get = await app.inject({
      method: 'GET',
      url: '/trpc/health',
      headers: { host: HUB_HOST, origin: FOREIGN },
    })

    for (const res of [pre, get]) {
      const corsHeaders = Object.keys(res.headers).filter((h) => h.startsWith('access-control-'))
      expect(corsHeaders).toEqual([])
    }
    expect(get.statusCode).toBe(200)
    // Logged once per origin, not per request.
    expect(warns.filter((w) => w.meta?.['origin'] === FOREIGN)).toHaveLength(1)
  })

  it('reflects the exact origin (never *) on a bearer-authenticated request', async () => {
    const app = await makeApp(makePolicy().policy)
    const res = await app.inject({
      method: 'POST',
      url: '/trpc/auth.login',
      headers: {
        host: HUB_HOST,
        origin: VIEWER_PWA_ORIGIN,
        authorization: 'Bearer abc',
        'content-type': 'application/json',
      },
      payload: '{}',
    })

    expect(res.statusCode).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe(VIEWER_PWA_ORIGIN)
    expect(res.headers['access-control-allow-origin']).not.toBe('*')
    expect(String(res.headers['access-control-expose-headers'])).toContain('content-range')
    expect(String(res.headers['vary'])).toContain('Origin')
  })

  it('a native caller (no Origin) gets no CORS headers and is served', async () => {
    const app = await makeApp(makePolicy().policy)
    const res = await app.inject({
      method: 'GET',
      url: '/trpc/health',
      headers: { host: HUB_HOST },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('applies the operator’s configured origins, and a changed list without a restart', async () => {
    let configured: unknown = ['http://localhost:8081']
    const app = await makeApp(makePolicy(() => configured).policy)
    const ask = () =>
      app.inject({
        method: 'GET',
        url: '/trpc/health',
        headers: { host: HUB_HOST, origin: 'http://localhost:8081' },
      })

    expect((await ask()).headers['access-control-allow-origin']).toBe('http://localhost:8081')
    configured = []
    expect((await ask()).headers['access-control-allow-origin']).toBeUndefined()
  })
})

describe('registerCorsPolicy — hijacked byte-range media', () => {
  it('a 206 through the data-plane proxy carries the exact origin and exposes Content-Range', async () => {
    const upstream = createServer((req, res) => {
      expect(req.headers.range).toBe('bytes=0-3')
      res
        .writeHead(206, {
          'content-type': 'video/mp4',
          'content-range': 'bytes 0-3/100',
          'accept-ranges': 'bytes',
          'content-length': '4',
          // A data-plane server's own blanket policy must not leak out.
          'access-control-allow-origin': '*',
        })
        .end('abcd')
    })
    servers.push(upstream)
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (address === null || typeof address === 'string') throw new Error('no port')

    const app = Fastify()
    apps.push(app)
    registerCorsPolicy(app, makePolicy().policy)
    app.get('/addon/recording/media/*', async (request, reply) => {
      reply.hijack()
      proxyToUpstream({
        baseUrl: `http://127.0.0.1:${address.port}`,
        secret: 's',
        upstreamPath: '/seg.mp4',
        clientReq: request.raw,
        clientRes: reply.raw,
      })
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const hubAddress = app.server.address()
    if (hubAddress === null || typeof hubAddress === 'string') throw new Error('no port')

    const allowed = await fetch(`http://127.0.0.1:${hubAddress.port}/addon/recording/media/x`, {
      headers: { origin: VIEWER_PWA_ORIGIN, range: 'bytes=0-3', authorization: 'Bearer t' },
    })
    expect(allowed.status).toBe(206)
    expect(await allowed.text()).toBe('abcd')
    expect(allowed.headers.get('content-range')).toBe('bytes 0-3/100')
    expect(allowed.headers.get('access-control-allow-origin')).toBe(VIEWER_PWA_ORIGIN)
    expect(allowed.headers.get('access-control-expose-headers')).toContain('content-range')
    expect(allowed.headers.get('access-control-expose-headers')).toContain('accept-ranges')

    const denied = await fetch(`http://127.0.0.1:${hubAddress.port}/addon/recording/media/x`, {
      headers: { origin: FOREIGN, range: 'bytes=0-3' },
    })
    expect(denied.status).toBe(206)
    await denied.arrayBuffer()
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('refuseForeignWsUpgrade', () => {
  async function wsServer(policy: CorsPolicy): Promise<number> {
    const server = createServer()
    servers.push(server)
    const wss = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => {
      if (refuseForeignWsUpgrade(policy, request.headers, socket)) return
      wss.handleUpgrade(request, socket, head, (ws) => ws.close(1000, 'ok'))
    })
    server.on('close', () => wss.close())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    return address.port
  }

  function connect(port: number, origin: string | undefined): Promise<'open' | number> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}/trpc`,
        origin !== undefined ? { origin } : {},
      )
      ws.on('open', () => {
        ws.close()
        resolve('open')
      })
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
      ws.on('error', reject)
    })
  }

  it('opens for the PWA, the hub itself and a native client; refuses a foreign page', async () => {
    const port = await wsServer(makePolicy().policy)
    expect(await connect(port, VIEWER_PWA_ORIGIN)).toBe('open')
    expect(await connect(port, `http://127.0.0.1:${port}`)).toBe('open')
    expect(await connect(port, undefined)).toBe('open')
    expect(await connect(port, FOREIGN)).toBe(403)
  })
})
