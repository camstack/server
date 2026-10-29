import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { VendorLoginProxy, type IScopedLogger } from '@camstack/types'

interface SeenInit {
  proxyOwnIp?: string
  proxyListenBind?: string
  proxyPort: number
}

const seen: { init: SeenInit | null; hostMismatches: number } = { init: null, hostMismatches: 0 }
/** When false the fake never reports the registration as finished (a hung Amazon step). */
const behaviour = { registers: true, withCode: true }

/**
 * A stand-in for alexa-remote2 + alexa-cookie2: a real HTTP listener on the address the
 * options name, that checks the Host header the way alexa-cookie2 does, emits absolute
 * `http://<proxyOwnIp>:<port>/…` URLs, and ends the login with a 302 to `/cookie-success`
 * while the app registration finishes a moment later (the `cookie` event).
 */
vi.mock('alexa-remote2', () => {
  class FakeAlexaRemote {
    cookie: string | undefined
    cookieData: object | undefined
    #listener: Server | null = null
    #onCookie: (() => void) | null = null
    on(event: string, cb: () => void): this {
      if (event === 'cookie') this.#onCookie = cb
      return this
    }
    init(opts: SeenInit, cb: (err?: Error) => void): void {
      seen.init = { ...opts }
      const own = `${opts.proxyOwnIp}:${opts.proxyPort}`
      const listener = createServer((req, res) => {
        if (req.headers.host !== own) {
          seen.hostMismatches += 1
          res.writeHead(404)
          res.end()
          return
        }
        const url = req.url ?? '/'
        if (url === '/') {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end(`<a href="http://${own}/www.amazon.it/ap/signin">sign in</a>`)
        } else if (url.startsWith('/www.amazon.it/ap/signin')) {
          res.writeHead(302, { location: `http://${own}/cookie-success` })
          res.end()
          if (behaviour.registers) {
            setTimeout(() => {
              this.cookie = 'session-cookie'
              this.cookieData = { localCookie: 'session-cookie' }
              this.#onCookie?.()
            }, 30)
          }
        } else if (url.startsWith('/www.amazon.it/ap/final-step')) {
          // Amazon's final redirect, rewritten by alexa-cookie2 to the loopback address.
          res.writeHead(302, {
            location: `http://${own}/www.amazon.it/ap/maplanding?openid.mode=id_res&openid.return_to=https%3A%2F%2Fwww.amazon.it%2Fap%2Fmaplanding&openid.sig=SECRETSIG&serial=${behaviour.withCode ? '&openid.oa2.authorization_code=SECRETCODE' : ''}`,
          })
          res.end()
          if (behaviour.registers) {
            setTimeout(() => {
              this.cookie = 'session-cookie'
              this.cookieData = { localCookie: 'session-cookie' }
              this.#onCookie?.()
            }, 30)
          }
        } else {
          res.writeHead(404)
          res.end()
        }
      })
      this.#listener = listener
      listener.listen(opts.proxyPort, opts.proxyListenBind, () => {
        cb(new Error(`Please open http://${own}/ with your browser and login`))
      })
    }
    stop(): void {}
    stopProxyServer(cb?: () => void): void {
      const listener = this.#listener
      this.#listener = null
      if (listener === null) {
        cb?.()
        return
      }
      listener.close(() => cb?.())
    }
  }
  return { default: FakeAlexaRemote }
})

import { AlexaProxyLoginManager } from '../alexa-proxy-login-manager.js'

const logger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
} as unknown as IScopedLogger

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

describe('the Amazon login through the hub login proxy', () => {
  let front: Server
  let frontPort = 0
  let proxy: VendorLoginProxy
  let manager: AlexaProxyLoginManager
  let upstreamPort = 0

  beforeEach(async () => {
    seen.init = null
    seen.hostMismatches = 0
    behaviour.registers = true
    behaviour.withCode = true
    upstreamPort = await freePort()
    proxy = new VendorLoginProxy({ addonId: 'import-alexa', logger })
    front = createServer((req, res) => void proxy.handler(req, res))
    await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve))
    frontPort = (front.address() as AddressInfo).port
    manager = new AlexaProxyLoginManager({
      logger,
      getProxyConfig: () => ({ proxyPort: upstreamPort }),
      getLoginProxy: () => proxy,
    })
  })

  afterEach(async () => {
    await manager.dispose()
    front.close()
  })

  /** Strip the hub mount the way the data plane does. */
  const viaFront = (hubPath: string): string =>
    `http://127.0.0.1:${frontPort}${hubPath.replace('/addon/import-alexa/vendor-login', '')}`

  it('binds alexa-cookie2 to loopback only and hands the browser a hub-relative entry', async () => {
    const started = await manager.start('amazon.it')
    expect(seen.init?.proxyOwnIp).toBe('127.0.0.1')
    expect(seen.init?.proxyListenBind).toBe('127.0.0.1')
    expect(
      started.loginUrl.startsWith(`/addon/import-alexa/vendor-login/${started.sessionId}/`),
    ).toBe(true)
    expect(started.loginUrl).not.toContain('http')
    await vi.waitFor(() => expect(manager.status(started.sessionId)?.phase).toBe('awaiting-login'))
  })

  it('walks the Amazon pages through the hub, captures the cookie and lands on the result page', async () => {
    const started = await manager.start('amazon.it')

    const first = await fetch(viaFront(started.loginUrl), { redirect: 'manual' })
    expect(first.status).toBe(200)
    const html = await first.text()
    const link = /href="([^"]+)"/.exec(html)?.[1] ?? ''
    expect(link.startsWith(`/addon/import-alexa/vendor-login/${started.sessionId}/`)).toBe(true)
    expect(link).not.toContain('http')

    const last = await fetch(viaFront(link), { redirect: 'manual' })
    const landing = last.headers.get('location') ?? ''
    expect(landing).toContain('/sso-complete#')
    expect(landing).toContain('status=success')
    expect(landing).toContain('addon=import-alexa')
    expect(landing).not.toContain('cookie')

    expect(seen.hostMismatches).toBe(0)
    expect(manager.status(started.sessionId)?.phase).toBe('captured')
    expect(manager.takeCaptured(started.sessionId)?.cookie).toBe('session-cookie')
  })

  it("treats Amazon's maplanding redirect as the end of the login and lands on the result page", async () => {
    const started = await manager.start('amazon.it')
    const entry = viaFront(started.loginUrl).replace(/\/$/, '')
    const last = await fetch(`${entry}/www.amazon.it/ap/final-step`, { redirect: 'manual' })
    const landing = last.headers.get('location') ?? ''
    expect(landing).toContain('/sso-complete#')
    expect(landing).toContain('status=success')
    expect(landing).not.toContain('maplanding')
    expect(landing).not.toContain('SECRETSIG')
    expect(landing).not.toContain('SECRETCODE')
    expect(landing).not.toContain('127.0.0.1')
    expect(manager.takeCaptured(started.sessionId)?.cookie).toBe('session-cookie')
  })

  it('ends at once with no_authorization_code when Amazon landed without the oa2 code', async () => {
    behaviour.withCode = false
    behaviour.registers = false
    const started = await manager.start('amazon.it')
    const entry = viaFront(started.loginUrl).replace(/\/$/, '')
    const t0 = Date.now()
    const last = await fetch(`${entry}/www.amazon.it/ap/final-step`, { redirect: 'manual' })
    const landing = last.headers.get('location') ?? ''
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(landing).toContain('status=error')
    expect(landing).toContain('reason=no_authorization_code')
    expect(landing).not.toContain('SECRETSIG')
  })

  it('lands on the result page with a reason when the registration never completes', async () => {
    behaviour.registers = false
    const impatient = new AlexaProxyLoginManager({
      logger,
      getProxyConfig: () => ({ proxyPort: upstreamPort }),
      getLoginProxy: () => proxy,
      captureWaitMs: 150,
    })
    try {
      const started = await impatient.start('amazon.it')
      const first = await fetch(viaFront(started.loginUrl), { redirect: 'manual' })
      const link = /href="([^"]+)"/.exec(await first.text())?.[1] ?? ''
      const landing =
        (await fetch(viaFront(link), { redirect: 'manual' })).headers.get('location') ?? ''
      expect(landing).toContain('status=error')
      expect(landing).toContain('reason=exchange_failed')
    } finally {
      await impatient.dispose()
    }
  })

  it('refuses a replay of the entry after the attempt was cancelled', async () => {
    const started = await manager.start('amazon.it')
    await manager.cancel(started.sessionId)
    const again = await fetch(viaFront(started.loginUrl), { redirect: 'manual' })
    expect(again.headers.get('location') ?? '').toContain('reason=invalid_state')
  })

  it('says so when the hub does not serve the login proxy', async () => {
    const bare = new AlexaProxyLoginManager({
      logger,
      getProxyConfig: () => ({ proxyPort: upstreamPort }),
      getLoginProxy: () => null,
    })
    await expect(bare.start('amazon.it')).rejects.toThrow(/hub login proxy is not available/)
  })
})
