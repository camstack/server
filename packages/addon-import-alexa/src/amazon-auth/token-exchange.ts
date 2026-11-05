/**
 * The token and cookie legs of the Amazon sign-in: a refresh token to an access token
 * (`/auth/token`), a refresh token to website cookies (`/ap/exchangetoken/cookies`), the
 * capabilities announcement, and the csrf probe the Alexa web API needs.
 *
 * Adapted from alexa-cookie2 (MIT, Copyright (c) Apollon77 and contributors); see
 * assets/alexa-cookie2.LICENSE.md. No value of a token or cookie is ever logged here.
 */
import { z } from 'zod'
import { APP_VERSION, USER_AGENT } from './constants.js'
import { DEVICE_CAPABILITIES_BODY } from './capabilities.js'
import { mergeSetCookies, parseCookieHeader, serializeCookies } from './cookies.js'
import { AmazonAuthRejectedError, type AmazonHttp, type AmazonHttpResponse } from './http.js'

/** Statuses that mean Amazon no longer honours the refresh token. */
const REJECTED_STATUSES: ReadonlySet<number> = new Set([400, 401, 403])
const MAX_REDIRECTS = 5

/** The paths probed, in order, until one of them sets a `csrf` cookie. */
export const CSRF_PROBE_PATHS: readonly string[] = [
  '/api/language',
  '/spa/index.html',
  '/api/devices-v2/device?cached=false',
  '/templates/oobe/d-device-pick.handlebars',
  '/api/strings',
]

function form(values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
}

function rejected(step: string, status: number): AmazonAuthRejectedError {
  return new AmazonAuthRejectedError(`${step} refused by Amazon (HTTP ${status})`, status)
}

export interface AccessTokenInput {
  readonly amazonPage: string
  readonly refreshToken: string
  readonly loginCookie: string
  readonly deviceAppName: string
  readonly acceptLanguage: string
}

const AccessTokenSchema = z.object({ access_token: z.string().min(1).meta({ secret: true }) })

/** `POST api.<page>/auth/token`: a refresh token to an access token. */
export async function fetchAccessToken(input: AccessTokenInput, http: AmazonHttp): Promise<string> {
  const res = await http({
    method: 'POST',
    host: `api.${input.amazonPage}`,
    path: '/auth/token',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': input.acceptLanguage,
      'Accept-Charset': 'utf-8',
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: input.loginCookie,
      Accept: 'application/json',
      'x-amzn-identity-auth-domain': `api.${input.amazonPage}`,
    },
    body: form({
      app_name: input.deviceAppName,
      app_version: APP_VERSION,
      'di.sdk.version': '6.12.4',
      source_token: input.refreshToken,
      package_name: 'com.amazon.echo',
      'di.hw.version': 'iPhone',
      platform: 'iOS',
      requested_token_type: 'access_token',
      source_token_type: 'refresh_token',
      'di.os.name': 'iOS',
      'di.os.version': '16.6',
      current_version: '6.12.4',
    }),
  })
  const parsed = AccessTokenSchema.safeParse(res.json)
  if (parsed.success) return parsed.data.access_token
  if (REJECTED_STATUSES.has(res.status)) throw rejected('token refresh', res.status)
  throw new Error(`token refresh failed (HTTP ${res.status})`)
}

/** Best effort: Amazon only opens the push channel for a device that announced its capabilities. */
export async function registerCapabilities(
  input: { readonly accessToken: string; readonly acceptLanguage: string },
  http: AmazonHttp,
): Promise<boolean> {
  try {
    const res = await http({
      method: 'PUT',
      host: 'api.amazonalexa.com',
      path: '/v1/devices/@self/capabilities',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': input.acceptLanguage,
        'Accept-Charset': 'utf-8',
        'Content-type': 'application/json; charset=UTF-8',
        authorization: `Bearer ${input.accessToken}`,
      },
      body: DEVICE_CAPABILITIES_BODY,
    })
    return res.status === 200 || res.status === 204
  } catch {
    return false
  }
}

export interface CookieExchangeInput {
  readonly amazonPage: string
  readonly refreshToken: string
  readonly deviceAppName: string
  readonly acceptLanguage: string
}

const CookieExchangeSchema = z.object({
  response: z.object({
    tokens: z.object({
      cookies: z.record(z.string(), z.array(z.object({ Name: z.string(), Value: z.string() }))),
    }),
  }),
})

/** `POST www.<page>/ap/exchangetoken/cookies`: a refresh token to the website cookies of that page. */
export async function exchangeForCookies(
  input: CookieExchangeInput,
  http: AmazonHttp,
): Promise<string> {
  const res = await http({
    method: 'POST',
    host: `www.${input.amazonPage}`,
    path: '/ap/exchangetoken/cookies',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': input.acceptLanguage,
      'Accept-Charset': 'utf-8',
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: '*/*',
      'x-amzn-identity-auth-domain': `api.${input.amazonPage}`,
    },
    body: form({
      'di.os.name': 'iOS',
      app_version: APP_VERSION,
      domain: `.${input.amazonPage}`,
      source_token: input.refreshToken,
      requested_token_type: 'auth_cookies',
      source_token_type: 'refresh_token',
      'di.hw.version': 'iPhone',
      'di.sdk.version': '6.12.4',
      app_name: input.deviceAppName,
      'di.os.version': '16.6',
    }),
  })
  const parsed = CookieExchangeSchema.safeParse(res.json)
  const cookies = parsed.success
    ? parsed.data.response.tokens.cookies[`.${input.amazonPage}`]
    : undefined
  if (cookies === undefined) {
    if (REJECTED_STATUSES.has(res.status)) throw rejected('cookie exchange', res.status)
    throw new Error(
      `cookie exchange returned no cookies for ${input.amazonPage} (HTTP ${res.status})`,
    )
  }
  const jar = parseCookieHeader(mergeSetCookies('', res.setCookies))
  for (const cookie of cookies) jar.set(cookie.Name, cookie.Value)
  return serializeCookies(jar)
}

/** The account's own domain or one of its subdomains: the only hosts the cookies may reach. */
function isAccountHost(hostname: string, amazonPage: string): boolean {
  return hostname === amazonPage || hostname.endsWith(`.${amazonPage}`)
}

/** A GET that follows redirects and carries the cookies every hop sets. */
async function getWithCookies(
  http: AmazonHttp,
  amazonPage: string,
  start: { readonly host: string; readonly path: string },
  cookie: string,
  headers: Readonly<Record<string, string>>,
): Promise<{ readonly response: AmazonHttpResponse; readonly cookie: string }> {
  let host = start.host
  let path = start.path
  let jar = cookie
  for (let hop = 0; ; hop += 1) {
    const response = await http({
      method: 'GET',
      host,
      path,
      headers: { ...headers, Cookie: jar },
    })
    jar = mergeSetCookies(jar, response.setCookies)
    const isRedirect = response.status >= 300 && response.status < 400 && response.location !== null
    if (!isRedirect || hop >= MAX_REDIRECTS || response.location === null)
      return { response, cookie: jar }
    const next = new URL(response.location, `https://${host}`)
    if (next.protocol !== 'https:' || !isAccountHost(next.hostname, amazonPage)) {
      throw new Error('refusing to follow a redirect outside the Amazon account domain')
    }
    host = next.host
    path = `${next.pathname}${next.search}`
  }
}

/** Probe the Alexa web host until it sets a `csrf` cookie. Throws when none of the paths does. */
export async function probeCsrf(
  input: { readonly amazonPage: string; readonly cookie: string },
  http: AmazonHttp,
): Promise<{ readonly cookie: string; readonly csrf: string }> {
  let cookie = input.cookie
  const origin = `https://alexa.${input.amazonPage}`
  for (const path of CSRF_PROBE_PATHS) {
    const probed = await getWithCookies(
      http,
      input.amazonPage,
      { host: `alexa.${input.amazonPage}`, path },
      cookie,
      {
        DNT: '1',
        'User-Agent': USER_AGENT,
        Referer: `${origin}/spa/index.html`,
        Accept: '*/*',
        Origin: origin,
      },
    )
    cookie = probed.cookie
    const csrf = parseCookieHeader(cookie).get('csrf')
    if (csrf !== undefined && csrf.length > 0) return { cookie, csrf }
  }
  throw new Error(`no csrf cookie from alexa.${input.amazonPage}`)
}

const UserSchema = z.object({ marketPlaceDomainName: z.string().optional() })

/**
 * The marketplace page of the account (`www.amazon.it` becomes `amazon.it`), or `fallback`
 * when Amazon does not say. Best effort: a failure keeps the page the operator signed in on.
 */
export async function lookupMarketplacePage(
  input: { readonly amazonPage: string; readonly cookie: string; readonly acceptLanguage: string },
  http: AmazonHttp,
  fallback: string,
): Promise<string> {
  try {
    const { response } = await getWithCookies(
      http,
      input.amazonPage,
      {
        host: `alexa.${input.amazonPage}`,
        path: `/api/users/me?platform=ios&version=${APP_VERSION}`,
      },
      input.cookie,
      {
        'User-Agent': USER_AGENT,
        'Accept-Language': input.acceptLanguage,
        'Accept-Charset': 'utf-8',
        Accept: 'application/json',
      },
    )
    const name = UserSchema.safeParse(response.json)
    const domain = name.success ? name.data.marketPlaceDomainName : undefined
    const dot = domain?.indexOf('.') ?? -1
    return domain !== undefined && dot !== -1 ? domain.slice(dot + 1) : fallback
  } catch {
    return fallback
  }
}
