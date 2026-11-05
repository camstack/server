/**
 * A scripted Amazon for the sign-in specs: requests are matched on `METHOD host path`, every
 * call is recorded, and an unrouted request answers 404 so a stray call fails loudly. The
 * bodies come from `fixtures/amazon-login/`; every secret in them is a FIXTURE-… literal.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AmazonHttp, AmazonHttpRequest, AmazonHttpResponse } from '../../amazon-auth/http.js'

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'amazon-login',
)

export function fixtureText(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8')
}

export function fixtureJson(name: string): unknown {
  const parsed: unknown = JSON.parse(fixtureText(name))
  return parsed
}

/** Every literal a fixture treats as a secret, so a spec can prove none of them is logged. */
export const FIXTURE_SECRETS: readonly string[] = [
  'FIXTURE-AUTH-CODE',
  'FIXTURE-REFRESH-TOKEN',
  'FIXTURE-ACCESS-TOKEN',
  'FIXTURE-PRIVATE-KEY',
  'FIXTURE-ADP-TOKEN',
  'FIXTURE-REGISTER-SESSION',
  'FIXTURE-EXCHANGED-SESSION',
  'FIXTURE-EXCHANGED-TOKEN',
  'FIXTURE-CSRF',
]

export interface AmazonReply {
  readonly status?: number
  readonly json?: unknown
  readonly text?: string
  readonly location?: string
  readonly setCookies?: readonly string[]
}

export function reply(spec: AmazonReply): AmazonHttpResponse {
  const text = spec.text ?? (spec.json === undefined ? '' : JSON.stringify(spec.json))
  return {
    status: spec.status ?? 200,
    location: spec.location ?? null,
    setCookies: spec.setCookies ?? [],
    text,
    json: spec.json ?? null,
  }
}

export type AmazonRoutes = Readonly<
  Record<string, AmazonReply | ((req: AmazonHttpRequest, call: number) => AmazonReply)>
>

export interface FakeAmazon {
  readonly http: AmazonHttp
  readonly calls: AmazonHttpRequest[]
  readonly callsTo: (key: string) => AmazonHttpRequest[]
}

export function routeKey(req: Pick<AmazonHttpRequest, 'method' | 'host' | 'path'>): string {
  return `${req.method} ${req.host}${req.path}`
}

export function fakeAmazon(routes: AmazonRoutes): FakeAmazon {
  const calls: AmazonHttpRequest[] = []
  const seen = new Map<string, number>()
  const http: AmazonHttp = async (req) => {
    calls.push(req)
    const key = routeKey(req)
    const n = (seen.get(key) ?? 0) + 1
    seen.set(key, n)
    const route = routes[key]
    if (route === undefined) return reply({ status: 404, text: `unrouted ${key}` })
    return reply(typeof route === 'function' ? route(req, n) : route)
  }
  return { http, calls, callsTo: (key) => calls.filter((c) => routeKey(c) === key) }
}

/** The happy path of a full registration refresh on amazon.it. */
export function refreshRoutes(page = 'amazon.it'): AmazonRoutes {
  return {
    [`POST api.${page}/auth/token`]: { json: fixtureJson('auth-token.json') },
    'PUT api.amazonalexa.com/v1/devices/@self/capabilities': { status: 204 },
    [`POST www.${page}/ap/exchangetoken/cookies`]: {
      json: fixtureJson('exchangetoken-cookies.json'),
    },
    [`GET alexa.${page}/api/language`]: { setCookies: [fixtureText('csrf-set-cookie.txt')] },
  }
}
