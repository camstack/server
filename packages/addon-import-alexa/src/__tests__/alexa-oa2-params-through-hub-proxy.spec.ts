import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { VendorLoginProxy, type IScopedLogger } from '@camstack/types'

/**
 * The device registration needs Amazon to echo the `oa2` extension the first sign-in URL asked
 * for (`openid.ns.oa2`, `openid.oa2.client_id`, `response_type`, `scope`, the PKCE challenge).
 * Every page, form and redirect between the first request and `/ap/maplanding` passes through
 * the hub login proxy, which must hand those values on UNCHANGED. The loopback stand-in below
 * behaves like alexa-cookie2: it emits absolute `http://127.0.0.1:<port>/…` URLs and turns
 * them back into Amazon's before a request leaves it.
 */

const OA2 = {
  'openid.ns.oa2': 'http://www.amazon.it/ap/ext/oauth/2',
  'openid.oa2.client_id': 'device:0123456789abcdef',
  'openid.oa2.response_type': 'code',
  'openid.oa2.scope': 'device_auth_access',
  'openid.oa2.code_challenge': 'Zm9v-_Zm9v',
  'openid.oa2.code_challenge_method': 'S256',
} as const

const logger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
} as unknown as IScopedLogger

interface Seen {
  query: URLSearchParams | null
  form: URLSearchParams | null
}

describe('oa2 values survive the hub login proxy', () => {
  let upstream: Server
  let front: Server
  let proxy: VendorLoginProxy
  let upstreamHost = ''
  let frontPort = 0
  const seen: Seen = { query: null, form: null }
  const attempt = 'attempt-oa2-0001'

  const toAmazon = (value: string): string =>
    value.replace(`http://${upstreamHost}/www.amazon.it/`, 'http://www.amazon.it/')

  beforeEach(async () => {
    seen.query = null
    seen.form = null
    upstream = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const own = `http://${upstreamHost}`
      if (url.pathname === '/www.amazon.it/ap/signin' && req.method === 'GET') {
        seen.query = url.searchParams
        const hidden = Object.entries(OA2)
          .map(
            ([k, v]) =>
              `<input type="hidden" name="${k}" value="${v.replace('http://www.amazon.it/', `${own}/www.amazon.it/`)}">`,
          )
          .join('')
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(
          `<form method="post" action="${own}/www.amazon.it/ap/signin">` +
            `${hidden}<input type="hidden" name="openid.return_to" value="${own}/www.amazon.it/ap/maplanding">` +
            `<input name="password"></form>` +
            `<a href="${own}/www.amazon.it/ap/cvf/request?${new URLSearchParams(OA2).toString()}">mfa</a>`,
        )
      } else if (url.pathname === '/www.amazon.it/ap/signin' && req.method === 'POST') {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          const raw = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
          const fixed = new URLSearchParams()
          for (const [k, v] of raw) fixed.set(k, toAmazon(v))
          seen.form = fixed
          res.writeHead(302, {
            location: `${own}/www.amazon.it/ap/cvf/request?${new URLSearchParams(OA2).toString()}`,
          })
          res.end()
        })
      } else if (url.pathname === '/www.amazon.it/ap/cvf/request') {
        seen.query = url.searchParams
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('ok')
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    upstreamHost = `127.0.0.1:${(upstream.address() as AddressInfo).port}`
    proxy = new VendorLoginProxy({ addonId: 'import-alexa', logger })
    proxy.open<true>({
      attemptId: attempt,
      expiresAtMs: Date.now() + 60_000,
      upstreams: [{ host: upstreamHost, scheme: 'http' }],
      terminal: () => ({ kind: 'continue' }),
      onDone: async () => ({ status: 'success', addonId: 'import-alexa' }),
    })
    front = createServer((req, res) => void proxy.handler(req, res))
    await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve))
    frontPort = (front.address() as AddressInfo).port
  })

  afterEach(() => {
    upstream.close()
    front.close()
  })

  const viaFront = (hubPath: string): string =>
    `http://127.0.0.1:${frontPort}${hubPath.replace('/addon/import-alexa/vendor-login', '')}`

  it('hands hidden form fields and a following redirect on unchanged', async () => {
    const entry = proxy.entryPath(attempt, `http://${upstreamHost}/www.amazon.it/ap/signin`) ?? ''
    const page = await (await fetch(viaFront(entry))).text()

    // What a browser does: collect the form's fields and post them urlencoded.
    const fields = new URLSearchParams()
    for (const m of page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
      fields.set(m[1] ?? '', m[2] ?? '')
    }
    const action = /<form method="post" action="([^"]+)"/.exec(page)?.[1] ?? ''
    const posted = await fetch(viaFront(action), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: fields.toString(),
    })

    for (const [key, value] of Object.entries(OA2)) {
      expect(seen.form?.get(key), `form field ${key}`).toBe(value)
    }
    expect(seen.form?.get('openid.return_to')).toBe('http://www.amazon.it/ap/maplanding')

    const next = posted.headers.get('location') ?? ''
    await fetch(viaFront(next))
    for (const [key, value] of Object.entries(OA2)) {
      expect(seen.query?.get(key), `redirect query ${key}`).toBe(value)
    }
  })

  it('hands query values of a page link on unchanged', async () => {
    const entry = proxy.entryPath(attempt, `http://${upstreamHost}/www.amazon.it/ap/signin`) ?? ''
    const page = await (await fetch(viaFront(entry))).text()
    const link = /<a href="([^"]+)"/.exec(page)?.[1] ?? ''
    await fetch(viaFront(link))
    for (const [key, value] of Object.entries(OA2)) {
      expect(seen.query?.get(key), `link query ${key}`).toBe(value)
    }
  })
})
