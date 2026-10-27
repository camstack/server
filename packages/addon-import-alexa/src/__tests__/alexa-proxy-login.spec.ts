import { describe, it, expect, vi } from 'vitest'
import type { IScopedLogger } from '@camstack/types'
import { capturedToCookieString } from '../alexa-proxy-login-manager.js'
import { buildAlexaLoginRoutes, type AlexaLoginRouteDeps } from '../alexa-login-routes.js'
import { SECRET_LINE_RE } from '../alexa-proxy-login.js'
import type { AlexaProxyLoginManager } from '../alexa-proxy-login-manager.js'
import type { AlexaProxyLoginStatus } from '../alexa-proxy-login.js'

/** Minimal no-op logger satisfying IScopedLogger for the route handlers. */
const noopLogger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
} as unknown as IScopedLogger

/** A capturing reply mirroring the addon-routes reply surface. */
function makeReply() {
  const state: { status: number; body: unknown } = { status: 0, body: undefined }
  const reply = {
    status(code: number) {
      state.status = code
      return reply
    },
    code(code: number) {
      state.status = code
      return reply
    },
    send(data: unknown) {
      state.body = data
    },
    redirect() {
      /* unused */
    },
    header() {
      return reply
    },
    type() {
      return reply
    },
  }
  return { reply, state }
}

function route(routes: ReturnType<typeof buildAlexaLoginRoutes>, method: string, path: string) {
  const found = routes.find((r) => r.method === method && r.path === path)
  if (found === undefined) throw new Error(`route ${method} ${path} not registered`)
  return found
}

describe('capturedToCookieString', () => {
  it('serializes an object cookieData blob to JSON', () => {
    const out = capturedToCookieString({
      cookieData: { localCookie: 'abc', csrf: '1' },
      cookie: 'x',
    })
    expect(JSON.parse(out)).toEqual({ localCookie: 'abc', csrf: '1' })
  })

  it('passes a string cookieData through unchanged', () => {
    const out = capturedToCookieString({ cookieData: 'raw-cookie; csrf=1', cookie: 'raw-cookie' })
    expect(out).toBe('raw-cookie; csrf=1')
  })
})

describe('alexa login routes', () => {
  function mkDeps(overrides: Partial<AlexaLoginRouteDeps> = {}): AlexaLoginRouteDeps {
    const manager = {
      start: vi.fn(async () => ({
        sessionId: 's1',
        loginUrl: 'http://10.0.0.9:3456/',
        amazonDomain: 'amazon.it',
      })),
      status: vi.fn(
        (): AlexaProxyLoginStatus => ({
          sessionId: 's1',
          phase: 'awaiting-login',
          loginUrl: 'http://10.0.0.9:3456/',
          amazonDomain: 'amazon.it',
          error: null,
          startedAt: 1,
          capturedAt: null,
        }),
      ),
      takeCaptured: vi.fn(() => ({ cookieData: { localCookie: 'c' }, cookie: 'c' })),
      cancel: vi.fn(async () => undefined),
    } as unknown as AlexaProxyLoginManager
    return {
      logger: noopLogger,
      proxyLogin: manager,
      commitCookie: vi.fn(async () => ({ brokerId: 'alexa_001' })),
      ...overrides,
    }
  }

  it('login/start returns a sessionId + loginUrl', async () => {
    const deps = mkDeps()
    const routes = buildAlexaLoginRoutes(deps)
    const { reply, state } = makeReply()
    await route(routes, 'POST', '/login/start').handler(
      { params: {}, query: {}, body: { amazonDomain: 'amazon.it' }, headers: {} },
      reply,
    )
    expect(state.status).toBe(200)
    expect(state.body).toMatchObject({ sessionId: 's1', loginUrl: 'http://10.0.0.9:3456/' })
  })

  it('login/start is admin-scoped and accepts a default domain', async () => {
    const routes = buildAlexaLoginRoutes(mkDeps())
    expect(route(routes, 'POST', '/login/start').access).toBe('admin')
    const { reply, state } = makeReply()
    await route(routes, 'POST', '/login/start').handler(
      { params: {}, query: {}, body: {}, headers: {} },
      reply,
    )
    expect(state.status).toBe(200)
  })

  it('login/status returns the (secret-free) status snapshot', async () => {
    const routes = buildAlexaLoginRoutes(mkDeps())
    const { reply, state } = makeReply()
    await route(routes, 'GET', '/login/status').handler(
      { params: {}, query: { sessionId: 's1' }, body: undefined, headers: {} },
      reply,
    )
    expect(state.status).toBe(200)
    expect(state.body).toMatchObject({ phase: 'awaiting-login', amazonDomain: 'amazon.it' })
    // The status must never carry the cookie material.
    expect(JSON.stringify(state.body)).not.toContain('cookieData')
  })

  it('login/status 404s an unknown session', async () => {
    const deps = mkDeps()
    ;(deps.proxyLogin.status as ReturnType<typeof vi.fn>).mockReturnValueOnce(null)
    const routes = buildAlexaLoginRoutes(deps)
    const { reply, state } = makeReply()
    await route(routes, 'GET', '/login/status').handler(
      { params: {}, query: { sessionId: 'nope' }, body: undefined, headers: {} },
      reply,
    )
    expect(state.status).toBe(404)
  })

  it('login/commit persists the captured cookie onto a broker', async () => {
    const deps = mkDeps()
    const routes = buildAlexaLoginRoutes(deps)
    const { reply, state } = makeReply()
    await route(routes, 'POST', '/login/commit').handler(
      { params: {}, query: {}, body: { sessionId: 's1', name: 'Home' }, headers: {} },
      reply,
    )
    expect(state.status).toBe(200)
    expect(state.body).toEqual({ brokerId: 'alexa_001' })
    expect(deps.commitCookie).toHaveBeenCalledWith(
      expect.objectContaining({ amazonDomain: 'amazon.it', name: 'Home' }),
    )
  })

  it('login/commit 409s when nothing was captured yet', async () => {
    const deps = mkDeps()
    ;(deps.proxyLogin.takeCaptured as ReturnType<typeof vi.fn>).mockReturnValueOnce(null)
    const routes = buildAlexaLoginRoutes(deps)
    const { reply, state } = makeReply()
    await route(routes, 'POST', '/login/commit').handler(
      { params: {}, query: {}, body: { sessionId: 's1' }, headers: {} },
      reply,
    )
    expect(state.status).toBe(409)
    expect(deps.commitCookie).not.toHaveBeenCalled()
  })

  it('login/cancel always reports ok', async () => {
    const deps = mkDeps()
    const routes = buildAlexaLoginRoutes(deps)
    const { reply, state } = makeReply()
    await route(routes, 'POST', '/login/cancel').handler(
      { params: {}, query: {}, body: { sessionId: 's1' }, headers: {} },
      reply,
    )
    expect(state.status).toBe(200)
    expect(state.body).toEqual({ ok: true })
    expect(deps.proxyLogin.cancel).toHaveBeenCalledWith('s1')
  })

  it('login/start rejects a non-amazon domain with 400', async () => {
    const deps = mkDeps()
    const routes = buildAlexaLoginRoutes(deps)
    const { reply, state } = makeReply()
    await route(routes, 'POST', '/login/start').handler(
      { params: {}, query: {}, body: { amazonDomain: 'evil.com' }, headers: {} },
      reply,
    )
    expect(state.status).toBe(400)
    expect(deps.proxyLogin.start).not.toHaveBeenCalled()
  })
})

describe('SECRET_LINE_RE (cookie/csrf log-redaction filter)', () => {
  it('matches lines containing cookie material', () => {
    expect(SECRET_LINE_RE.test('Alexa-Cookie: Update Cookie session-id=abc123')).toBe(true)
    expect(SECRET_LINE_RE.test('Set-Cookie: ubid-acbde=123; Path=/')).toBe(true)
    expect(SECRET_LINE_RE.test('Result: csrf=aabb1122, Cookie=session=xyz')).toBe(true)
    expect(SECRET_LINE_RE.test('bearer token received')).toBe(true)
  })

  it('does NOT match innocuous proxy log lines', () => {
    expect(SECRET_LINE_RE.test('Proxy server listening on port 3456')).toBe(false)
    expect(SECRET_LINE_RE.test('Please open http://10.0.0.9:3456/ and login')).toBe(false)
    expect(SECRET_LINE_RE.test('Request: GET /api/bootstrap')).toBe(false)
    expect(SECRET_LINE_RE.test('Response status 200 OK')).toBe(false)
  })
})
