import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '../../interfaces/logging.js'
import { VendorLoginProxy } from '../login-proxy.js'

function quietLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface Seen {
  readonly url: string
  readonly headers: IncomingMessage['headers']
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

const LOGIN_HTML = (port: number): string =>
  `<html><body><a id="rel" href="/step2">next</a><a id="abs" href="http://127.0.0.1:${port}/step2">abs</a>` +
  `<a id="q" href="/x?return_to=http://127.0.0.1:${port}/back">q</a></body></html>`

describe('VendorLoginProxy against a fake vendor', () => {
  let vendor: Server
  let front: Server
  let vendorPort: number
  let frontPort: number
  let seen: Seen[]
  let now = 1_000
  let proxy: VendorLoginProxy
  const ATTEMPT = 'ATTEMPT-ABCDEFGH'
  const onDone = vi.fn()
  const terminalSeen: string[] = []

  beforeEach(async () => {
    seen = []
    now = 1_000
    onDone.mockReset()
    terminalSeen.length = 0
    vendor = createServer((req, res) => {
      seen.push({ url: req.url ?? '', headers: req.headers })
      if (req.url === '/login') {
        const body = gzipSync(Buffer.from(LOGIN_HTML(vendorPort)))
        res.writeHead(200, {
          'content-type': 'text/html',
          'content-encoding': 'gzip',
          'content-security-policy': "frame-ancestors 'none'",
          'x-frame-options': 'DENY',
          'strict-transport-security': 'max-age=1',
          'set-cookie': ['sid=abc; Domain=127.0.0.1; Path=/; Secure; HttpOnly'],
        })
        res.end(body)
      } else if (req.url === '/step2') {
        res.writeHead(302, { location: `http://127.0.0.1:${vendorPort}/final` })
        res.end()
      } else if (req.url === '/final') {
        res.writeHead(302, { location: 'hcauth://auth/prod?code=X&state=S' })
        res.end()
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    vendorPort = await listen(vendor)
    proxy = new VendorLoginProxy({
      addonId: 'demo',
      prefix: 'login',
      logger: quietLogger(),
      now: () => now,
    })
    front = createServer((req, res) => void proxy.handler(req, res))
    frontPort = await listen(front)
    proxy.open({
      attemptId: ATTEMPT,
      expiresAtMs: 5_000,
      upstreams: [{ host: `127.0.0.1:${vendorPort}`, scheme: 'http' }],
      terminal: (view) => {
        terminalSeen.push(view.status.toString())
        return view.location !== null && view.location.startsWith('hcauth://')
          ? { kind: 'done', payload: view.location }
          : { kind: 'continue' }
      },
      onDone: async (payload) => {
        onDone(payload)
        return { status: 'success', addonId: 'demo' }
      },
    })
  })

  afterEach(async () => {
    vendor.close()
    front.close()
  })

  const get = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`http://127.0.0.1:${frontPort}${path}`, { redirect: 'manual', headers })

  it('serves the login page decoded and rewritten, with framing headers stripped', async () => {
    const res = await get(`/${ATTEMPT}/127.0.0.1:${vendorPort}/login`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toBeNull()
    expect(res.headers.get('x-frame-options')).toBeNull()
    expect(res.headers.get('strict-transport-security')).toBeNull()
    expect(res.headers.get('set-cookie')).toContain(`Path=/addon/demo/login/${ATTEMPT}/`)
    expect(res.headers.get('set-cookie')).not.toContain('Domain')
    expect(res.headers.get('set-cookie')).toContain('Secure')
    const html = await res.text()
    const base = `/addon/demo/login/${ATTEMPT}/127.0.0.1:${vendorPort}`
    expect(html).toContain(`id="rel" href="${base}/step2"`)
    expect(html).toContain(`id="abs" href="${base}/step2"`)
    expect(html).toContain(`return_to=http://127.0.0.1:${vendorPort}/back`)
  })

  it('does not forward the hub credentials and rewrites Origin/Referer to the vendor', async () => {
    await get(`/${ATTEMPT}/127.0.0.1:${vendorPort}/login`, {
      cookie: 'camstack_session=HUBSECRET; sid=abc',
      authorization: 'Bearer HUBTOKEN',
      origin: 'https://hub.lan',
      referer: `https://hub.lan/addon/demo/login/${ATTEMPT}/127.0.0.1:${vendorPort}/prev`,
    })
    const headers = seen[0]?.headers
    expect(headers?.cookie).toBe('sid=abc')
    expect(headers?.authorization).toBeUndefined()
    expect(headers?.origin).toBe(`http://127.0.0.1:${vendorPort}`)
    expect(headers?.referer).toBe(`http://127.0.0.1:${vendorPort}/prev`)
  })

  it('follows the vendor redirects inside the proxy until the terminal fires, then lands on the result page', async () => {
    const step = await get(`/${ATTEMPT}/127.0.0.1:${vendorPort}/step2`)
    expect(step.status).toBe(302)
    const next = step.headers.get('location')
    expect(next).toBe(`/addon/demo/login/${ATTEMPT}/127.0.0.1:${vendorPort}/final`)
    expect(onDone).not.toHaveBeenCalled()

    // The hub strips `/addon/demo/login` before the data-plane handler sees the URL.
    const done = await get((next ?? '').replace('/addon/demo/login', ''))
    expect(done.status).toBe(302)
    const landing = done.headers.get('location') ?? ''
    expect(landing.startsWith('/sso-complete#')).toBe(true)
    expect(landing).toContain('status=success')
    expect(landing).not.toContain('code=X')
    expect(landing).not.toContain('hcauth')
    expect(onDone).toHaveBeenCalledWith('hcauth://auth/prod?code=X&state=S')
  })

  it('refuses a replay: the attempt is consumed when the terminal fires', async () => {
    await get(`/${ATTEMPT}/127.0.0.1:${vendorPort}/final`)
    const replay = await get(`/${ATTEMPT}/127.0.0.1:${vendorPort}/final`)
    expect(replay.status).toBe(302)
    expect(replay.headers.get('location')).toContain('status=error')
    expect(replay.headers.get('location')).toContain('reason=invalid_state')
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(seen).toHaveLength(1)
  })

  it('refuses an expired attempt without dialling the vendor', async () => {
    now = 9_999
    const res = await get(`/${ATTEMPT}/127.0.0.1:${vendorPort}/login`)
    expect(res.headers.get('location')).toContain('reason=invalid_state')
    expect(seen).toHaveLength(0)
  })

  it('refuses a host that is not in the allow-list (no open proxy)', async () => {
    const res = await get(`/${ATTEMPT}/169.254.169.254/latest/meta-data`)
    expect(res.status).toBe(404)
    expect(seen).toHaveLength(0)
  })

  it('refuses an attempt that names a non-loopback http upstream', () => {
    expect(() =>
      proxy.open({
        attemptId: 'ANOTHER-ATTEMPT',
        expiresAtMs: 5_000,
        upstreams: [{ host: 'vendor.example', scheme: 'http' }],
        terminal: () => ({ kind: 'continue' }),
        onDone: async () => ({ status: 'error' }),
      }),
    ).toThrow(/not allowed/)
  })

  it('never logs the captured URL or a cookie', async () => {
    const logger = quietLogger()
    const quiet = new VendorLoginProxy({ addonId: 'demo', prefix: 'login', logger, now: () => now })
    quiet.open({
      attemptId: 'QUIET-ATTEMPT-1',
      expiresAtMs: 5_000,
      upstreams: [{ host: `127.0.0.1:${vendorPort}`, scheme: 'http' }],
      terminal: (view) =>
        view.location?.startsWith('hcauth://')
          ? { kind: 'done', payload: view.location }
          : { kind: 'continue' },
      onDone: async () => ({ status: 'success' }),
    })
    const other = createServer((req, res) => void quiet.handler(req, res))
    const port = await listen(other)
    await fetch(`http://127.0.0.1:${port}/QUIET-ATTEMPT-1/127.0.0.1:${vendorPort}/final`, {
      redirect: 'manual',
      headers: { cookie: 'sid=SECRETCOOKIE' },
    })
    other.close()
    const logged = JSON.stringify(
      [logger.debug, logger.info, logger.warn].flatMap((fn) => vi.mocked(fn).mock.calls),
    )
    expect(logged).not.toContain('code=X')
    expect(logged).not.toContain('SECRETCOOKIE')
    expect(logged).not.toContain('QUIET-ATTEMPT-1')
  })
})
