/**
 * The skill Lambda's `/authorize` — the step of Alexa account linking where the
 * operator says WHICH hub the skill talks to. It is the CamStack page family
 * (same generated tokens as the hub's own sign-in/consent pages, en/it, no
 * script), and it checks the hub BEFORE sending the browser there: a wrong or
 * unreachable hub is an error on this page with a reason code, not a dead end
 * on someone else's host.
 */
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

interface FakeResponse {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
  json(): Promise<unknown>
  readonly headers: { get(name: string): string | null }
}
type FetchFn = (url: string, init?: Record<string, unknown>) => Promise<FakeResponse>
interface LambdaResult {
  statusCode: number
  headers: Record<string, string>
  body?: string
}

const lambda = require('../../lambda-template/index.js') as {
  createHandler(deps: {
    env?: Record<string, string>
    fetch?: FetchFn
  }): (event: unknown) => Promise<LambdaResult>
}
const { STYLE } = require('../../lambda-template/page-style.js') as { STYLE: string }

const HUB = 'https://hub.example.test'
const OAUTH_QS =
  'response_type=code&client_id=skill-id&state=st%3Ctag%3E&scope=alexa%3A%3Askills%3Aaccount_linking&redirect_uri=https%3A%2F%2Flayla.amazon.com%2Fapi%2Fskill%2Flink%2FM123'

function reply(status: number, body: unknown): FakeResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
    headers: { get: () => 'application/json' },
  }
}

const HEALTHY_HUB = reply(200, {
  integrations: [{ integrationId: 'export-alexa', displayName: 'Alexa Smart Home' }],
  complete: true,
})

function run(opts: { query?: string; hubUrl?: string; acceptLanguage?: string; fetch?: FetchFn }) {
  const probes: string[] = []
  const fetch: FetchFn =
    opts.fetch ??
    (async (url) => {
      probes.push(url)
      return HEALTHY_HUB
    })
  const handler = lambda.createHandler({ env: {}, fetch })
  const qs = [
    OAUTH_QS,
    opts.hubUrl === undefined ? '' : `hubUrl=${encodeURIComponent(opts.hubUrl)}`,
  ]
    .filter((p) => p.length > 0)
    .join('&')
  return {
    probes,
    result: handler({
      requestContext: { http: { method: 'GET' } },
      rawPath: '/authorize',
      rawQueryString: opts.query ?? qs,
      headers: opts.acceptLanguage === undefined ? {} : { 'accept-language': opts.acceptLanguage },
    }),
  }
}

describe('/authorize — the hub address step', () => {
  it('renders the CamStack page: generated tokens, a plain form, no script, CSP pinned to the style', async () => {
    const res = await run({}).result
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain(STYLE)
    expect(STYLE).toContain('--color-primary')
    expect(res.body).not.toMatch(/<script/i)
    expect(res.body).toContain('<form')
    expect(res.headers['content-security-policy']).toMatch(/style-src 'sha256-/)
    expect(res.headers['content-security-policy']).toContain("form-action 'self'")
  })

  it('keeps the account-linking parameters as hidden fields, escaped', async () => {
    const res = await run({}).result
    expect(res.body).toContain('name="client_id" value="skill-id"')
    expect(res.body).toContain('value="st&#60;tag&#62;"')
    expect(res.body).not.toContain('st<tag>')
    expect(res.body).not.toContain('name="hubUrl" value')
  })

  it('speaks the operator’s language', async () => {
    const it = await run({ acceptLanguage: 'it-IT,it;q=0.9,en;q=0.8' }).result
    expect(it.body).toContain('<html lang="it">')
    expect(it.body).toMatch(/Collega CamStack ad Alexa/)
    const en = await run({ acceptLanguage: 'de' }).result
    expect(en.body).toContain('<html lang="en">')
  })

  it('refuses an address that is not https, naming the reason on the same page', async () => {
    const { result, probes } = run({ hubUrl: 'http://hub.example.test' })
    const res = await result
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('data-reason="not_https"')
    expect(probes).toEqual([])
  })

  it.each([
    'https://localhost',
    'https://127.0.0.1:8443',
    'https://[::1]',
    'https://192.168.1.20',
  ])('refuses a local address (%s): the skill runs in the cloud and cannot reach it', async (hub) => {
    const { result, probes } = run({ hubUrl: hub })
    expect((await result).body).toContain('data-reason="local_address"')
    expect(probes).toEqual([])
  })

  it('refuses something that is not a URL', async () => {
    expect((await run({ hubUrl: 'my hub' }).result).body).toContain('data-reason="invalid_url"')
  })

  it('an unreachable hub is reported as such, before leaving the page', async () => {
    const res = await run({
      hubUrl: HUB,
      fetch: async () => {
        throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
      },
    }).result
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('data-reason="unreachable"')
  })

  it('a certificate the Lambda does not trust is its own reason', async () => {
    const res = await run({
      hubUrl: HUB,
      fetch: async () => {
        throw Object.assign(new Error('fetch failed'), {
          cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' },
        })
      },
    }).result
    expect(res.body).toContain('data-reason="tls_error"')
  })

  it('a server that is not a CamStack hub, or does not serve Alexa linking, is told apart', async () => {
    const notHub = await run({ hubUrl: HUB, fetch: async () => reply(404, 'nope') }).result
    expect(notHub.body).toContain('data-reason="not_camstack"')
    const noAlexa = await run({
      hubUrl: HUB,
      fetch: async () =>
        reply(200, { integrations: [{ integrationId: 'homeassistant' }], complete: true }),
    }).result
    expect(noAlexa.body).toContain('data-reason="integration_missing"')
  })

  it('a hub still starting its integrations asks the operator to wait', async () => {
    const res = await run({
      hubUrl: HUB,
      fetch: async () => reply(200, { integrations: [], complete: false }),
    }).result
    expect(res.body).toContain('data-reason="hub_starting"')
  })

  it('a good hub is probed (unauthenticated discovery) and the browser is sent to ITS authorize', async () => {
    const { result, probes } = run({ hubUrl: `${HUB}/` })
    const res = await result
    expect(probes).toEqual([`${HUB}/api/oauth2/integrations`])
    expect(res.statusCode).toBe(302)
    const location = new URL(res.headers.location ?? '')
    expect(location.origin).toBe(HUB)
    expect(location.pathname).toBe('/api/oauth2/authorize')
    expect(location.searchParams.get('integration')).toBe('export-alexa')
    expect(location.searchParams.get('client_id')).toBe('skill-id')
    expect(location.searchParams.get('state')).toBe('st<tag>')
    expect(location.searchParams.get('hubUrl')).toBeNull()
  })
})
