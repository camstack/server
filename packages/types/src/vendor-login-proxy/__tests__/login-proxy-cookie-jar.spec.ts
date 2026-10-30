import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
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

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

const REJECTED = 'Browser requirements not met'

/**
 * A vendor whose step 2 refuses a flow that arrives without the cookie step 1 set, as a
 * browser-requirements check page does. The client below never stores or sends a cookie:
 * a browser that refused the rewritten cookie.
 */
describe('VendorLoginProxy server-side cookie jar', () => {
  let vendor: Server
  let front: Server
  let vendorPort: number
  let frontPort: number
  let proxy: VendorLoginProxy

  beforeEach(async () => {
    vendor = createServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, {
          location: `http://127.0.0.1:${vendorPort}/check`,
          'set-cookie': [
            'cpim-trans=T1; Domain=127.0.0.1; Path=/; Secure; HttpOnly; SameSite=None',
            '__Host-x=H; Path=/; Secure',
          ],
        })
        res.end()
      } else if (req.url === '/check') {
        const cookie = req.headers.cookie ?? ''
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end(cookie.includes('cpim-trans=T1') ? 'step2 ok' : REJECTED)
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    vendorPort = await listen(vendor)
    proxy = new VendorLoginProxy({
      addonId: 'demo',
      logger: quietLogger(),
      now: () => 1_000,
    })
    front = createServer((req, res) => void proxy.handler(req, res))
    frontPort = await listen(front)
  })

  afterEach(() => {
    vendor.close()
    front.close()
  })

  function open(attemptId: string, serverCookieJar: boolean): void {
    proxy.open({
      attemptId,
      expiresAtMs: 5_000,
      upstreams: [{ host: `127.0.0.1:${vendorPort}`, scheme: 'http' }],
      terminal: () => ({ kind: 'continue' }),
      onDone: async () => ({ status: 'success', addonId: 'demo' }),
      ...(serverCookieJar ? { serverCookieJar } : {}),
    })
  }

  const get = (path: string): Promise<Response> =>
    fetch(`http://127.0.0.1:${frontPort}${path}`, { redirect: 'manual' })

  async function walk(attemptId: string): Promise<{ body: string; browserCookies: string[] }> {
    const first = await get(`/${attemptId}/127.0.0.1:${vendorPort}/start`)
    const next = first.headers.get('location') ?? ''
    expect(next).toContain(`/${attemptId}/127.0.0.1:${vendorPort}/check`)
    const second = await get(next.slice(next.indexOf(`/${attemptId}`)))
    return {
      body: await second.text(),
      browserCookies: first.headers.getSetCookie(),
    }
  }

  it('sends the cookie set on step 1 upstream on step 2 although the browser kept none', async () => {
    open('ATTEMPT-JARJARJAR', true)
    const { body } = await walk('ATTEMPT-JARJARJAR')
    expect(body).toBe('step2 ok')
  })

  it('without the jar the same flow is refused (the discriminating control)', async () => {
    open('ATTEMPT-NOJARJAR1', false)
    const { body } = await walk('ATTEMPT-NOJARJAR1')
    expect(body).toBe(REJECTED)
  })

  it('hands the page a copy a plain-http browser accepts: no Secure, SameSite or __Host- cookie', async () => {
    open('ATTEMPT-COPYCOPY1', true)
    const { browserCookies } = await walk('ATTEMPT-COPYCOPY1')
    expect(browserCookies).toHaveLength(1)
    const [copy] = browserCookies
    expect(copy).toContain('cpim-trans=T1')
    expect(copy).not.toMatch(/secure/i)
    expect(copy).not.toMatch(/samesite/i)
    expect(copy).toContain('Path=/addon/demo/')
  })

  it('keeps the jar per attempt: another attempt does not inherit the cookie', async () => {
    open('ATTEMPT-ONEONEONE', true)
    open('ATTEMPT-TWOTWOTWO', true)
    await get(`/ATTEMPT-ONEONEONE/127.0.0.1:${vendorPort}/start`)
    const other = await get(`/ATTEMPT-TWOTWOTWO/127.0.0.1:${vendorPort}/check`)
    expect(await other.text()).toBe(REJECTED)
  })
})
