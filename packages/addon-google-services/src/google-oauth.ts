/**
 * Google OAuth2 authorization-code + refresh for Calendar API.
 */
import {
  GOOGLE_AUTH_URL,
  GOOGLE_OAUTH_SCOPES,
  GOOGLE_TOKEN_URL,
  type GoogleOauthState,
} from './google-types.js'

export interface GoogleOauthClientConfig {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
}

export interface TokenResponse {
  readonly access_token: string
  readonly expires_in: number
  readonly refresh_token?: string
  readonly scope?: string
  readonly token_type?: string
}

export interface OauthHttp {
  readonly fetch: typeof fetch
}

export function buildAuthorizeUrl(cfg: GoogleOauthClientConfig, state: string): string {
  const u = new URL(GOOGLE_AUTH_URL)
  u.searchParams.set('client_id', cfg.clientId)
  u.searchParams.set('redirect_uri', cfg.redirectUri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', GOOGLE_OAUTH_SCOPES)
  u.searchParams.set('access_type', 'offline')
  u.searchParams.set('prompt', 'consent')
  u.searchParams.set('state', state)
  return u.toString()
}

export async function exchangeCode(
  cfg: GoogleOauthClientConfig,
  code: string,
  http: OauthHttp = { fetch },
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: 'authorization_code',
  })
  const res = await http.fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google token exchange failed (${res.status}): ${text.slice(0, 400)}`)
  }
  return (await res.json()) as TokenResponse
}

export async function refreshAccessToken(
  cfg: Pick<GoogleOauthClientConfig, 'clientId' | 'clientSecret'>,
  refreshToken: string,
  http: OauthHttp = { fetch },
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  const res = await http.fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google token refresh failed (${res.status}): ${text.slice(0, 400)}`)
  }
  return (await res.json()) as TokenResponse
}

/** Apply a token response onto oauth state. Keeps prior refresh when absent. */
export function applyTokenResponse(
  prev: GoogleOauthState,
  tokens: TokenResponse,
  nowMs: number = Date.now(),
): GoogleOauthState {
  return {
    ...prev,
    accessToken: tokens.access_token,
    accessExpiresAt: nowMs + Math.max(0, tokens.expires_in - 60) * 1000,
    refreshToken: tokens.refresh_token ?? prev.refreshToken,
  }
}

export function needsRefresh(state: GoogleOauthState, nowMs: number = Date.now()): boolean {
  if (!state.refreshToken) return false
  if (!state.accessToken) return true
  return state.accessExpiresAt <= nowMs
}

export type GoogleClientProbeResult =
  | { readonly ok: true; readonly latencyMs: number }
  | { readonly ok: false; readonly error: string }

/**
 * Probe Client ID / secret against Google's token endpoint with a throwaway
 * authorization code. `invalid_client` means bad credentials; `invalid_grant`
 * / `redirect_uri_mismatch` mean Google accepted the client (code was fake).
 */
export async function probeGoogleOauthClient(
  cfg: GoogleOauthClientConfig,
  http: OauthHttp = { fetch },
): Promise<GoogleClientProbeResult> {
  const started = Date.now()
  const body = new URLSearchParams({
    code: 'camstack-probe-invalid',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: 'authorization_code',
  })
  let res: Response
  try {
    res = await http.fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const text = await res.text()
  let errorCode = ''
  try {
    const json = JSON.parse(text) as { error?: string }
    if (typeof json.error === 'string') errorCode = json.error
  } catch {
    // non-JSON body
  }
  if (errorCode === 'invalid_client') {
    return { ok: false, error: 'Invalid Client ID or Client secret (Google rejected the client)' }
  }
  if (errorCode === 'unauthorized_client') {
    return {
      ok: false,
      error: 'This OAuth client is not allowed to use the authorization-code grant',
    }
  }
  if (
    errorCode === 'invalid_grant' ||
    errorCode === 'redirect_uri_mismatch' ||
    errorCode === 'invalid_request'
  ) {
    return { ok: true, latencyMs: Math.max(0, Date.now() - started) }
  }
  if (res.ok) {
    return { ok: true, latencyMs: Math.max(0, Date.now() - started) }
  }
  return {
    ok: false,
    error:
      errorCode.length > 0
        ? `Google token probe failed (${errorCode}): ${text.slice(0, 200)}`
        : `Google token probe failed (${res.status}): ${text.slice(0, 200)}`,
  }
}
