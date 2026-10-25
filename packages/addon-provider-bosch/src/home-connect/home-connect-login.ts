import { createHash, randomBytes } from 'node:crypto'
import { parseOAuthCallback } from '../shared/oauth-callback.js'
import {
  createSignInAttemptStore,
  loginFailureForAttempt,
  type SignInAttemptStore,
} from '../shared/sign-in-attempt.js'
import {
  HOME_CONNECT_IDDF_URL,
  homeConnectIddfHeaders,
  parseIddfZipBuffer,
} from './home-connect-iddf.js'

/** Public OAuth client ids from the Home Connect app login (hcpy). */
export const HOME_CONNECT_CLIENT_ID =
  '9B75AC9EC512F36C84256AC47D813E2C1DD0D6520DF774B020E1E6E2EB29B1F3'
export const HOME_CONNECT_OAUTH_BASE = 'https://api.home-connect.com/security/oauth/'
const ASSET_BASE = 'https://eu.services.home-connect.com/'
export const HOME_CONNECT_REDIRECT_URI = 'hcauth://auth/prod'
export const HOME_CONNECT_AUTHORIZE_SCOPE =
  'Control DeleteAppliance IdentifyAppliance Images Monitor ReadAccount ReadOrigApi Settings WriteAppliance WriteOrigApi'
const APP_ID = HOME_CONNECT_CLIENT_ID
const OAUTH_BASE = HOME_CONNECT_OAUTH_BASE
const REDIRECT_URI = HOME_CONNECT_REDIRECT_URI
const AUTHORIZE_SCOPE = HOME_CONNECT_AUTHORIZE_SCOPE

export interface HomeConnectListedAppliance {
  readonly haId: string
  readonly name: string
  readonly type: string
  readonly connection: {
    readonly host: string
    readonly psk: string
    readonly mode: 'AES' | 'TLS'
    readonly iv64: string
    readonly deviceDescription: string
  }
}

export interface HomeConnectAccountLogin {
  readonly token: string
  readonly refresh: string
  readonly summary: string
  readonly accountId: string
  readonly appliances: readonly HomeConnectListedAppliance[]
}

export interface LoginHttpResponse {
  readonly status: number
  readonly headers: {
    get(name: string): string | null
    getSetCookie?: () => readonly string[]
  }
  text(): Promise<string>
  arrayBuffer?(): Promise<ArrayBuffer>
}

export type LoginFetch = (
  url: string,
  init: {
    readonly method: string
    readonly headers: Readonly<Record<string, string>>
    readonly body?: string
    readonly redirect: 'manual'
  },
) => Promise<LoginHttpResponse>

class CookieJar {
  readonly #cookies = new Map<string, string>()

  absorb(headers: LoginHttpResponse['headers']): void {
    const listed = headers.getSetCookie?.() ?? []
    const lines = listed.length > 0 ? listed : headerList(headers.get('set-cookie'))
    for (const line of lines) {
      const pair = line.split(';')[0] ?? ''
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      this.#cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }

  header(): string {
    return [...this.#cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  get(name: string): string | undefined {
    return this.#cookies.get(name)
  }
}

function headerList(value: string | null): readonly string[] {
  return value ? [value] : []
}

export async function homeConnectLoginFetch(
  url: string,
  init: {
    readonly method: string
    readonly headers: Readonly<Record<string, string>>
    readonly body?: string
    readonly redirect: 'manual'
  },
): Promise<LoginHttpResponse> {
  const response = await fetch(url, {
    method: init.method,
    headers: { ...init.headers },
    body: init.body,
    redirect: 'manual',
  })
  return {
    status: response.status,
    headers: response.headers,
    text: () => response.text(),
    arrayBuffer: () => response.arrayBuffer(),
  }
}

function b64url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

async function exchange(
  fetchImpl: LoginFetch,
  jar: CookieJar,
  url: string,
  method: string,
  extraHeaders: Readonly<Record<string, string>>,
  body?: string,
): Promise<{
  readonly status: number
  readonly location: string | null
  readonly body: string
}> {
  const headers: Record<string, string> = {
    'user-agent': 'hc-login/1.0',
    accept: 'application/json, text/html',
    ...extraHeaders,
  }
  const cookie = jar.header()
  if (cookie.length > 0) headers['cookie'] = cookie
  const csrf = jar.get('X-CSRF-FORM-TOKEN')
  if (csrf) headers['RequestVerificationToken'] = csrf
  const response = await fetchImpl(url, {
    method,
    headers,
    body,
    redirect: 'manual',
  })
  jar.absorb(response.headers)
  return {
    status: response.status,
    location: response.headers.get('location'),
    body: await response.text(),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function tokensFromBody(body: string): {
  readonly token: string
  readonly refresh: string
} {
  const tokenJson: unknown = JSON.parse(body)
  if (!isRecord(tokenJson)) throw new Error('Home Connect sign-in was rejected')
  const token = tokenJson['access_token']
  const refresh = tokenJson['refresh_token']
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Home Connect sign-in was rejected')
  }
  return { token, refresh: typeof refresh === 'string' ? refresh : '' }
}

function isInvalidGrant(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body)
    return isRecord(parsed) && parsed['error'] === 'invalid_grant'
  } catch {
    return false
  }
}

function accountSummary(appliances: readonly HomeConnectListedAppliance[]): string {
  if (appliances.length === 0) return 'Signed in. No appliances on this account yet.'
  const names = appliances.map((app) => app.name).join(', ')
  return `Signed in. ${appliances.length} appliance${appliances.length === 1 ? '' : 's'}: ${names}.`
}

function accountIdFromAccessToken(token: string): string {
  const payload = token.split('.')[1]
  if (!payload) throw new Error('Home Connect sign-in was rejected')
  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8'))
  } catch {
    throw new Error('Home Connect sign-in was rejected')
  }
  if (!isRecord(parsed) || typeof parsed['sub'] !== 'string' || parsed['sub'].length === 0) {
    throw new Error('Home Connect sign-in was rejected')
  }
  return parsed['sub']
}

function listedFromPaired(
  row: Record<string, unknown>,
  encryption: Record<string, unknown>,
): HomeConnectListedAppliance | null {
  if (row['isDemo'] === true) return null
  const haId = stringField(row, 'haId')
  if (!haId) return null
  const brand = (stringField(row, 'brand') ?? 'HomeConnect').toUpperCase()
  const type = stringField(row, 'haType') ?? stringField(row, 'type') ?? 'Appliance'
  const tls = isRecord(encryption['tls']) ? encryption['tls'] : undefined
  const aes = isRecord(encryption['aes']) ? encryption['aes'] : undefined
  const tlsKey = tls ? stringField(tls, 'key') : undefined
  const aesKey = aes ? stringField(aes, 'key') : undefined
  const mode = tlsKey ? 'TLS' : 'AES'
  const psk = tlsKey ?? aesKey
  if (!psk) return null
  const iv = aes ? stringField(aes, 'iv') : undefined
  if (mode === 'AES' && !iv) return null
  const host = mode === 'TLS' ? `${brand}-${type}-${haId}` : haId
  const name = stringField(row, 'vib') ?? `${brand} ${type}`
  return {
    haId,
    name,
    type,
    connection: {
      host,
      psk,
      mode,
      iv64: iv ?? '',
      deviceDescription: JSON.stringify({
        info: { deviceID: haId, deviceType: type, model: `${brand} ${type}` },
      }),
    },
  }
}

async function appliancesForToken(
  token: string,
  fetchImpl: LoginFetch,
  jar: CookieJar,
): Promise<readonly HomeConnectListedAppliance[]> {
  const accountId = accountIdFromAccessToken(token)
  const listed = await exchange(
    fetchImpl,
    jar,
    `${ASSET_BASE}api/account/v2/accounts/${encodeURIComponent(accountId)}/paired-appliances`,
    'GET',
    { authorization: `Bearer ${token}`, accept: 'application/json' },
  )
  if (listed.status >= 400) throw new Error('Home Connect sign-in was rejected')
  let parsed: unknown
  try {
    parsed = JSON.parse(listed.body)
  } catch {
    throw new Error('Home Connect sign-in was rejected')
  }
  if (!isRecord(parsed) || !Array.isArray(parsed['appliances'])) {
    throw new Error('Home Connect sign-in was rejected')
  }
  const out: HomeConnectListedAppliance[] = []
  for (const row of parsed['appliances']) {
    if (!isRecord(row)) continue
    const haId = stringField(row, 'haId')
    if (!haId) continue
    const enc = await exchange(
      fetchImpl,
      jar,
      `${ASSET_BASE}api/appliance/v2/appliances/${encodeURIComponent(haId)}/encryption-information`,
      'GET',
      { authorization: `Bearer ${token}`, accept: 'application/json' },
    )
    if (enc.status >= 400) continue
    let encryption: unknown
    try {
      encryption = JSON.parse(enc.body)
    } catch {
      continue
    }
    if (!isRecord(encryption)) continue
    const appliance = listedFromPaired(row, encryption)
    if (!appliance) continue
    const iddfResponse = await fetchImpl(HOME_CONNECT_IDDF_URL(haId), {
      method: 'GET',
      headers: homeConnectIddfHeaders(token),
      redirect: 'manual',
    })
    if (iddfResponse.status < 400 && iddfResponse.arrayBuffer) {
      const compact = parseIddfZipBuffer(Buffer.from(await iddfResponse.arrayBuffer()), haId)
      if (compact) {
        out.push({
          ...appliance,
          connection: {
            ...appliance.connection,
            deviceDescription: JSON.stringify(compact),
          },
        })
        continue
      }
    }
    out.push(appliance)
  }
  return out
}

/** Load every appliance on the account. A stale access token is refreshed once when a refresh token exists. */
export async function fetchHomeConnectAccount(
  creds: { readonly token: string; readonly refresh?: string },
  fetchImpl: LoginFetch = homeConnectLoginFetch,
): Promise<HomeConnectAccountLogin> {
  const jar = new CookieJar()
  const token = creds.token
  const refresh = creds.refresh ?? ''
  try {
    const appliances = await appliancesForToken(token, fetchImpl, jar)
    return {
      token,
      refresh,
      appliances,
      accountId: homeConnectAccountLabel(token),
      summary: accountSummary(appliances),
    }
  } catch (err: unknown) {
    if (refresh.length === 0) throw err
  }
  const next = await refreshHomeConnectToken(refresh, fetchImpl)
  if (!next.ok) throw new Error('Home Connect sign-in was rejected')
  const appliances = await appliancesForToken(next.token, fetchImpl, jar)
  return {
    token: next.token,
    refresh: next.refresh,
    appliances,
    accountId: homeConnectAccountLabel(next.token),
    summary: accountSummary(appliances),
  }
}

/** The JWT `sub`, or empty when the token has none. Never throws. */
export function homeConnectAccountLabel(token: string): string {
  try {
    return accountIdFromAccessToken(token)
  } catch {
    return ''
  }
}

export type HomeConnectTokenRefreshFailure =
  | 'no-refresh-token'
  | 'rejected'
  | 'unreadable-response'
  | 'network'

export interface HomeConnectTokenRefreshed {
  readonly ok: true
  readonly token: string
  readonly refresh: string
}

export interface HomeConnectTokenRefreshFailed {
  readonly ok: false
  readonly reason: HomeConnectTokenRefreshFailure
  /** HTTP status of the token endpoint; `null` when no response arrived. */
  readonly status: number | null
  readonly error?: string
}

export type HomeConnectTokenRefresh = HomeConnectTokenRefreshed | HomeConnectTokenRefreshFailed

/**
 * Exchange the refresh token for a new access token. Never throws; a failure says why and
 * carries no credential. A response without a new refresh token keeps the one that was used.
 */
export async function refreshHomeConnectToken(
  refresh: string,
  fetchImpl: LoginFetch = homeConnectLoginFetch,
): Promise<HomeConnectTokenRefresh> {
  if (refresh.length === 0) return { ok: false, reason: 'no-refresh-token', status: null }
  let status: number
  let body: string
  try {
    const refreshed = await exchange(
      fetchImpl,
      new CookieJar(),
      `${OAUTH_BASE}token`,
      'POST',
      { 'content-type': 'application/x-www-form-urlencoded' },
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: APP_ID,
      }).toString(),
    )
    status = refreshed.status
    body = refreshed.body
  } catch (err: unknown) {
    return {
      ok: false,
      reason: 'network',
      status: null,
      error: err instanceof Error ? err.message : 'unknown error',
    }
  }
  if (status >= 400) return { ok: false, reason: 'rejected', status }
  try {
    const next = tokensFromBody(body)
    return {
      ok: true,
      token: next.token,
      refresh: next.refresh.length > 0 ? next.refresh : refresh,
    }
  } catch {
    return { ok: false, reason: 'unreadable-response', status }
  }
}

/** The access token's JWT `exp` in epoch ms; `null` when the token carries none. */
export function homeConnectTokenExpiresAtMs(token: string): number | null {
  const payload = token.split('.')[1]
  if (!payload) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!isRecord(parsed) || typeof parsed['exp'] !== 'number') return null
    return parsed['exp'] * 1000
  } catch {
    return null
  }
}

/** Browser login link, matching Home Connect Local (`redirect_url` + the app scope). */
export function beginHomeConnectSignIn(): {
  readonly authorizeUrl: string
  readonly verifier: string
  readonly state: string
} {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(16))
  const authorize = new URL('authorize', OAUTH_BASE)
  authorize.searchParams.set('redirect_url', REDIRECT_URI)
  authorize.searchParams.set('client_id', APP_ID)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('prompt', 'login')
  authorize.searchParams.set('code_challenge_method', 'S256')
  authorize.searchParams.set('code_challenge', challenge)
  authorize.searchParams.set('state', state)
  authorize.searchParams.set('nonce', b64url(randomBytes(16)))
  authorize.searchParams.set('scope', AUTHORIZE_SCOPE)
  return { authorizeUrl: authorize.toString(), verifier, state }
}

export type HomeConnectLoginFailure =
  | 'empty'
  | 'no-code'
  | 'state-missing'
  | 'state-mismatch'
  | 'denied'
  | 'code-rejected'

const LOGIN_MESSAGES: Readonly<Record<HomeConnectLoginFailure, string>> = {
  empty: 'Nothing was pasted. Paste the address the browser tried to open after you signed in.',
  'no-code':
    'No sign-in code was found in what you pasted. Copy the whole address that starts with hcauth://, or just the code.',
  'state-missing':
    'The pasted address has no state. Copy the complete address, or create the login link again.',
  'state-mismatch':
    'State mismatch: this address belongs to a different sign-in attempt. Create the login link again and use the address that follows it.',
  denied: 'Home Connect refused the sign-in. Create the login link again and approve the access.',
  'code-rejected':
    'The code was already used or has expired. Create the login link again; a code works once and only for a few minutes.',
}

/** A failure the operator can act on; `reason` is stable, the message is for the form. */
export class HomeConnectLoginError extends Error {
  readonly name = 'HomeConnectLoginError'
  readonly reason: HomeConnectLoginFailure
  constructor(reason: HomeConnectLoginFailure) {
    super(LOGIN_MESSAGES[reason])
    this.reason = reason
  }
}

function callbackParams(
  callback: string,
  expectedState: string,
): { readonly code: string; readonly grantType: string } {
  const parsed = parseOAuthCallback(callback, expectedState)
  if (!parsed.ok) throw new HomeConnectLoginError(parsed.reason)
  return {
    code: parsed.code,
    grantType: parsed.params.get('grant_type') ?? 'authorization_code',
  }
}

/** Exchange the pasted redirect for the account token and each appliance profile. */
export async function completeHomeConnectSignIn(
  input: {
    readonly verifier: string
    readonly callback: string
    readonly state: string
  },
  fetchImpl: LoginFetch = homeConnectLoginFetch,
): Promise<HomeConnectAccountLogin> {
  const { code, grantType } = callbackParams(input.callback, input.state)
  const jar = new CookieJar()
  const token = await exchange(
    fetchImpl,
    jar,
    `${OAUTH_BASE}token`,
    'POST',
    { 'content-type': 'application/x-www-form-urlencoded' },
    new URLSearchParams({
      grant_type: grantType,
      client_id: APP_ID,
      code,
      code_verifier: input.verifier,
      redirect_uri: REDIRECT_URI,
    }).toString(),
  )
  if (token.status >= 400) {
    if (isInvalidGrant(token.body)) throw new HomeConnectLoginError('code-rejected')
    throw new Error('Home Connect sign-in was rejected')
  }
  return fetchHomeConnectAccount(tokensFromBody(token.body), fetchImpl)
}

export interface HomeConnectPublishedSignIn {
  readonly attemptId: string
  readonly authorizeUrl: string
}

/** What the form is allowed to see. The verifier stays in `store`. */
export function publishHomeConnectSignIn(
  store: SignInAttemptStore,
  nowMs: number,
): HomeConnectPublishedSignIn {
  const started = beginHomeConnectSignIn()
  const attemptId = store.put(started.verifier, started.state, nowMs)
  return { attemptId, authorizeUrl: started.authorizeUrl }
}

export async function finishHomeConnectSignIn(
  input: { readonly attemptId: string; readonly callback: string; readonly nowMs: number },
  store: SignInAttemptStore,
  fetchImpl: LoginFetch = homeConnectLoginFetch,
): Promise<HomeConnectAccountLogin> {
  const taken = store.take(input.attemptId, input.nowMs)
  if (!taken.ok) throw new HomeConnectLoginError(loginFailureForAttempt(taken.reason))
  return completeHomeConnectSignIn(
    { verifier: taken.attempt.verifier, callback: input.callback, state: taken.attempt.state },
    fetchImpl,
  )
}

export const homeConnectSignInAttempts = createSignInAttemptStore()
