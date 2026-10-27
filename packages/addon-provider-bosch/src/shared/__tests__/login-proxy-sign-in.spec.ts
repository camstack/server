import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { VendorLoginProxy, type IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  finishHomeConnectSignIn,
  HOME_CONNECT_REDIRECT_URI,
  publishHomeConnectSignIn,
  type LoginFetch,
  type LoginHttpResponse,
} from '../../home-connect/home-connect-login.js'
import { HOMECOM_REDIRECT_URI } from '../../homecom/homecom-oauth.js'
import { homeConnectFinishResult } from '../../home-connect/home-connect-sign-in-result.js'
import { appSchemeTerminal, createSignInClaims, openSignInProxy } from '../login-proxy-sign-in.js'
import { createSignInAttemptStore } from '../sign-in-attempt.js'

function logger(): IScopedLogger {
  const l: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => l,
    withTags: () => l,
  }
  return l
}

function schemeOf(uri: string): string {
  return uri.slice(0, uri.indexOf('://') + 3)
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

function response(status: number, body: string): LoginHttpResponse {
  return {
    status,
    headers: { get: () => null },
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  }
}

function accessToken(): string {
  return `e30.${Buffer.from(JSON.stringify({ sub: 'acct' })).toString('base64url')}.sig`
}

/** The cloud accepts the code `good-code`; everything else is `invalid_grant`. */
const cloud: LoginFetch = async (url, init) => {
  if (url.endsWith('/security/oauth/token')) {
    const code = new URLSearchParams(init.body ?? '').get('code') ?? ''
    if (code !== 'good-code') return response(400, JSON.stringify({ error: 'invalid_grant' }))
    return response(200, JSON.stringify({ access_token: accessToken(), refresh_token: 'rt' }))
  }
  if (url.includes('/paired-appliances')) return response(200, JSON.stringify({ appliances: [] }))
  throw new Error(`unexpected ${init.method} ${url}`)
}

describe('the hub login proxy, end to end, for a vendor with an app-scheme redirect', () => {
  let vendor: Server
  let front: Server
  let vendorPort = 0
  let frontPort = 0
  let codeToIssue = 'good-code'
  let proxy: VendorLoginProxy

  beforeEach(async () => {
    codeToIssue = 'good-code'
    vendor = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://vendor.invalid')
      const state = url.searchParams.get('state') ?? ''
      if (url.pathname === '/authorize') {
        res.writeHead(200, {
          'content-type': 'text/html',
          'content-security-policy': "default-src 'none'",
        })
        res.end(`<a href="/login2?state=${state}">continue</a>`)
      } else if (url.pathname === '/login2') {
        res.writeHead(302, { location: `http://127.0.0.1:${vendorPort}/cb?state=${state}` })
        res.end()
      } else if (url.pathname === '/cb') {
        res.writeHead(302, {
          location: `${HOME_CONNECT_REDIRECT_URI}?code=${codeToIssue}&state=${state}`,
        })
        res.end()
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    vendorPort = await listen(vendor)
    proxy = new VendorLoginProxy({
      addonId: 'bosch-home-connect',
      prefix: 'login',
      logger: logger(),
    })
    front = createServer((req, res) => void proxy.handler(req, res))
    frontPort = await listen(front)
  })

  afterEach(() => {
    vendor.close()
    front.close()
  })

  /** Walk the proxied pages the way a browser does, stripping the hub mount like the data plane. */
  async function browse(entry: string): Promise<{ landing: string; pages: string[] }> {
    const pages: string[] = []
    let next: string | null = entry
    for (let hop = 0; hop < 8 && next !== null; hop += 1) {
      const path: string = next.replace('/addon/bosch-home-connect/login', '')
      const res = await fetch(`http://127.0.0.1:${frontPort}${path}`, { redirect: 'manual' })
      pages.push(path)
      const location: string | null = res.headers.get('location')
      if (location === null) {
        const html = await res.text()
        const link = /href="([^"]+)"/.exec(html)?.[1]
        next = link ?? null
      } else if (location.startsWith('/sso-complete')) {
        return { landing: location, pages }
      } else {
        next = location
      }
    }
    throw new Error(`never reached the result page: ${pages.join(' -> ')}`)
  }

  function start(): {
    attemptId: string
    entry: string
    claims: ReturnType<typeof createSignInClaims<ReturnType<typeof homeConnectFinishResult>>>
  } {
    const store = createSignInAttemptStore()
    const published = publishHomeConnectSignIn(store, Date.now())
    const claims = createSignInClaims<ReturnType<typeof homeConnectFinishResult>>()
    const fake = new URL(published.authorizeUrl)
    const entry = openSignInProxy({
      proxy,
      claims,
      addonId: 'bosch-home-connect',
      attemptId: published.attemptId,
      authorizeUrl: `http://127.0.0.1:${vendorPort}/authorize${fake.search}`,
      hosts: [`127.0.0.1:${vendorPort}`],
      scheme: 'http',
      appScheme: schemeOf(HOME_CONNECT_REDIRECT_URI),
      finish: async (callback) =>
        homeConnectFinishResult(
          await finishHomeConnectSignIn(
            { attemptId: published.attemptId, callback, nowMs: Date.now() },
            store,
            cloud,
          ),
        ),
      nowMs: () => Date.now(),
    })
    return { attemptId: published.attemptId, entry, claims }
  }

  it('captures the hcauth redirect, runs the exchange, parks the result and lands on the result page', async () => {
    const { attemptId, entry, claims } = start()
    expect(claims.claim(attemptId, Date.now())).toEqual({ state: 'pending' })

    const { landing } = await browse(entry)

    expect(landing).toContain('/sso-complete#')
    expect(landing).toContain('status=success')
    expect(landing).not.toContain('good-code')
    expect(landing).not.toContain('hcauth')
    const claimed = claims.claim(attemptId, Date.now())
    expect(claimed.state).toBe('done')
    if (claimed.state === 'done') expect(claimed.result.token.length).toBeGreaterThan(0)
    expect(claims.claim(attemptId, Date.now())).toEqual({ state: 'pending' })
  })

  it('lands on the result page with a reason when the exchange is rejected, and the form is told why', async () => {
    codeToIssue = 'spent-code'
    const { attemptId, entry, claims } = start()
    const { landing } = await browse(entry)
    expect(landing).toContain('status=error')
    expect(landing).toContain('reason=exchange_failed')
    expect(() => claims.claim(attemptId, Date.now())).toThrow(/already used or has expired/)
  })

  it('refuses a replay of the proxied page after the sign-in finished', async () => {
    const { entry } = start()
    await browse(entry)
    const again = await fetch(
      `http://127.0.0.1:${frontPort}${entry.replace('/addon/bosch-home-connect/login', '')}`,
      { redirect: 'manual' },
    )
    expect(again.headers.get('location')).toContain('reason=invalid_state')
  })
})

describe('appSchemeTerminal', () => {
  const view = (location: string | null, bodyText: string | null = null) => ({
    status: 302,
    url: 'https://x.test/',
    location,
    setCookies: [],
    bodyText,
  })
  it('recognises both Bosch app schemes in a Location', () => {
    for (const uri of [HOME_CONNECT_REDIRECT_URI, HOMECOM_REDIRECT_URI]) {
      const verdict = appSchemeTerminal(schemeOf(uri))(view(`${uri}?code=c&state=s`))
      expect(verdict).toEqual({ kind: 'done', payload: `${uri}?code=c&state=s` })
    }
  })
  it('does not fire on a Location for the other scheme or an https page', () => {
    expect(
      appSchemeTerminal(schemeOf(HOMECOM_REDIRECT_URI))(view(`${HOME_CONNECT_REDIRECT_URI}?code=c`))
        .kind,
    ).toBe('continue')
    expect(
      appSchemeTerminal(schemeOf(HOME_CONNECT_REDIRECT_URI))(view('https://x.test/a')).kind,
    ).toBe('continue')
  })
  it('finds the address in a page that navigates by script, unescaping &amp;', () => {
    const body = '<meta http-equiv="refresh" content="0;url=hcauth://auth/prod?code=c&amp;state=s">'
    expect(appSchemeTerminal('hcauth://')(view(null, body))).toEqual({
      kind: 'done',
      payload: 'hcauth://auth/prod?code=c&state=s',
    })
  })
})
