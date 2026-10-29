import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IScopedLogger } from '../../interfaces/logging.js'
import { FLOW_TRACE_MAX_LINES, flowTraceMeta, hasOa2, paramNames } from '../flow-trace.js'
import { VendorLoginProxy } from '../login-proxy.js'

const SECRETS = ['SECRETQUERY', 'SECRETFORM', 'SECRETCOOKIE', 'SECRETSETCOOKIE', 'SECRETLOC']
const ATTEMPT = 'ATTEMPT-TRACE-0001'

describe('names-only flow trace', () => {
  let vendor: Server
  let front: Server
  let lines: string[]
  let proxy: VendorLoginProxy
  let vendorHost = ''
  let frontPort = 0

  beforeEach(async () => {
    lines = []
    const logger: IScopedLogger = {
      debug: vi.fn(),
      info: vi.fn((message: string, extra?: unknown) => {
        lines.push(`${message} ${JSON.stringify(extra ?? {})}`)
      }),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => logger,
      withTags: () => logger,
    }
    vendor = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.writeHead(302, {
          location: `/next?openid.oa2.response_type=SECRETLOC&other=SECRETLOC`,
          'set-cookie': ['session-id=SECRETSETCOOKIE; Path=/; Secure'],
        })
        res.end()
      })
    })
    await new Promise<void>((r) => vendor.listen(0, '127.0.0.1', r))
    vendorHost = `127.0.0.1:${(vendor.address() as AddressInfo).port}`
    proxy = new VendorLoginProxy({ addonId: 'import-alexa', logger })
    proxy.open<true>({
      attemptId: ATTEMPT,
      expiresAtMs: Date.now() + 60_000,
      upstreams: [{ host: vendorHost, scheme: 'http' }],
      terminal: () => ({ kind: 'continue' }),
      onDone: async () => ({ status: 'success' }),
    })
    front = createServer((req, res) => void proxy.handler(req, res))
    await new Promise<void>((r) => front.listen(0, '127.0.0.1', r))
    frontPort = (front.address() as AddressInfo).port
  })

  afterEach(() => {
    vendor.close()
    front.close()
  })

  const url = (path: string): string =>
    `http://127.0.0.1:${frontPort}/${ATTEMPT}/${vendorHost}${path}`

  it('writes one line per request with names, booleans and counts, and never a value', async () => {
    await fetch(url('/ap/signin?openid.ns.oa2=SECRETQUERY&plain=SECRETQUERY'), {
      redirect: 'manual',
      headers: { cookie: 'a=SECRETCOOKIE; b=SECRETCOOKIE' },
    })
    await fetch(url('/ap/signin'), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: 'openid.oa2.client_id=SECRETFORM&password=SECRETFORM',
    })

    const flow = lines.filter((l) => l.startsWith('vendor login proxy: flow'))
    expect(flow).toHaveLength(2)
    const [get, post] = flow as [string, string]
    expect(get).toContain('"method":"GET"')
    expect(get).toContain('"queryNames":"openid.ns.oa2,plain"')
    expect(get).toContain('"oa2InQuery":true')
    expect(get).toContain('"status":302')
    expect(get).toContain('"setCookieNames":"session-id"')
    expect(get).toContain('"cookiesSent":2')
    expect(get).toContain('"locationQueryNames":"openid.oa2.response_type,other"')
    expect(get).toContain('"oa2InLocation":true')
    expect(post).toContain('"formNames":"openid.oa2.client_id,password"')
    expect(post).toContain('"contentType":"application/x-www-form-urlencoded"')
    expect(post).toContain('"oa2InForm":true')

    for (const line of lines) {
      for (const secret of SECRETS) expect(line).not.toContain(secret)
      expect(line).not.toContain(ATTEMPT)
    }
  })

  it('stops writing after the per-attempt bound', async () => {
    for (let i = 0; i < FLOW_TRACE_MAX_LINES + 5; i += 1) {
      await fetch(url('/p'), { redirect: 'manual' })
    }
    expect(lines.filter((l) => l.startsWith('vendor login proxy: flow'))).toHaveLength(
      FLOW_TRACE_MAX_LINES,
    )
  })
})

describe('flow trace helpers', () => {
  it('lists distinct decoded names and spots the oa2 family', () => {
    expect(paramNames('?a=1&b%2Ec=2&a=3&&d')).toEqual(['a', 'b.c', 'd'])
    expect(hasOa2(['x', 'openid.ns.oa2'])).toBe(true)
    expect(hasOa2(['openid.oa2.scope'])).toBe(true)
    expect(hasOa2(['openid.ns.pape'])).toBe(false)
  })

  it('reports an unparsable Location without echoing it', () => {
    const meta = flowTraceMeta({
      attemptId: 'x',
      method: 'GET',
      upstreamHost: 'h',
      upstreamPath: '/',
      requestSearch: '',
      formBody: null,
      contentType: undefined,
      status: 302,
      location: 'http://[bad',
      setCookies: [],
      cookieHeader: undefined,
    })
    expect(meta['location']).toBe('unparsable')
  })
})
