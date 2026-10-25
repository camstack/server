/**
 * The one way a tool gets a USABLE credential: `resolveCredentials` picks the
 * token, this module makes sure it is still good.
 *
 *  - A cached `camstack login` session whose access token has expired (or has
 *    < 60 s left) is renewed over HTTP with its refresh token
 *    (`auth.refreshSession`), the rotation is saved, and the caller carries on.
 *    A refusal (or nothing to renew with) is a {@link MissingCredentialsError}
 *    that says to run `camstack login`.
 *  - An explicit `--token` / `--token-file` / `$CAMSTACK_TOKEN` is never
 *    touched: it is what the operator handed over.
 *  - The permission tier is read from the token's CLAIMS; a token with no
 *    readable claims is classified by asking the hub (`whoami`), never by its
 *    prefix.
 *  - A 401 mid-flight refreshes once and retries once ({@link refreshOnUnauthorized}).
 */
import {
  credentialTier,
  jwtClaims,
  jwtExpiryMs,
  MissingCredentialsError,
  resolveCredentials,
  type CredentialInputs,
  type ResolvedCredentials,
} from './credentials.js'
import {
  createHubClient,
  HubHttpError,
  HubRpcError,
  nodeHubTransport,
  type HubTransport,
} from './hub-client.js'
import { resolveHubTls, type HubTlsConfig } from './hub-tls.js'
import { defaultSessionDir, loadSession, saveSession, type SessionFile } from './session-store.js'

/** Renew when the access token has less than this left. */
export const REFRESH_SKEW_MS = 60_000
const REFRESH_TIMEOUT_MS = 15_000
const WHOAMI_TIMEOUT_MS = 5_000

export interface RefreshOptions {
  readonly server: string
  /** The session cache directory; defaults to `~/.camstack`. */
  readonly dir?: string
  readonly transport?: HubTransport
  readonly tls?: HubTlsConfig
  readonly now?: number
}

export interface FreshCredentialInputs extends CredentialInputs {
  readonly dir?: string
  readonly transport?: HubTransport
  readonly tls?: HubTlsConfig
  readonly now?: number
}

interface RefreshedSession {
  readonly token: string
  readonly refreshToken: string
  readonly expiresAt: number
}

function readRefreshed(value: unknown): RefreshedSession | null {
  if (value === null || typeof value !== 'object') return null
  const token: unknown = Reflect.get(value, 'token')
  const refreshToken: unknown = Reflect.get(value, 'refreshToken')
  const expiresAt: unknown = Reflect.get(value, 'expiresAt')
  if (typeof token !== 'string' || typeof refreshToken !== 'string') return null
  if (typeof expiresAt !== 'number') return null
  return { token, refreshToken, expiresAt }
}

function tlsFor(opts: RefreshOptions, dir: string): HubTlsConfig {
  return opts.tls ?? resolveHubTls(opts.server, process.env, dir)
}

/** Exchange the saved refresh token, persist the rotation, return the new session. */
async function renew(session: SessionFile, opts: RefreshOptions): Promise<SessionFile> {
  const dir = opts.dir ?? defaultSessionDir()
  const refreshToken = session.refreshToken
  if (refreshToken === undefined || refreshToken === '') {
    throw new MissingCredentialsError(
      session.server,
      'The session expired and has no refresh token',
    )
  }
  const client = createHubClient({
    baseUrl: session.server,
    token: '',
    tls: tlsFor(opts, dir),
    timeoutMs: REFRESH_TIMEOUT_MS,
    ...(opts.transport ? { transport: opts.transport } : {}),
  })
  let refreshed: RefreshedSession | null
  try {
    refreshed = readRefreshed(await client.call('POST', 'auth.refreshSession', { refreshToken }))
  } catch (err) {
    if (err instanceof HubRpcError || err instanceof HubHttpError) {
      throw new MissingCredentialsError(session.server, 'The hub refused to refresh the session')
    }
    throw err
  }
  if (!refreshed) {
    throw new MissingCredentialsError(session.server, 'The hub refused to refresh the session')
  }
  const next: SessionFile = {
    ...session,
    token: refreshed.token,
    refreshToken: refreshed.refreshToken,
    expiresAt: refreshed.expiresAt,
  }
  saveSession(next, dir)
  return next
}

/** Renew the saved session for `opts.server` now, whatever its expiry says; returns the new token. */
export async function forceRefreshSession(opts: RefreshOptions): Promise<string> {
  const dir = opts.dir ?? defaultSessionDir()
  const session = loadSession(opts.server, dir)
  if (!session) throw new MissingCredentialsError(opts.server)
  return (await renew(session, opts)).token
}

/** The `onUnauthorized` hook of {@link createHubClient}: a 401 renews the session, once. */
export function refreshOnUnauthorized(opts: RefreshOptions): () => Promise<string | undefined> {
  return async () => {
    const dir = opts.dir ?? defaultSessionDir()
    const session = loadSession(opts.server, dir)
    if (!session?.refreshToken) return undefined
    return forceRefreshSession(opts)
  }
}

function needsRefresh(session: SessionFile, now: number): boolean {
  const expiresAt = session.expiresAt ?? jwtExpiryMs(session.token)
  return expiresAt !== undefined && expiresAt - now < REFRESH_SKEW_MS
}

/** Ask the hub who a token with no readable claims is. Any failure means "not admin". */
async function tierFromHub(
  server: string,
  token: string,
  opts: FreshCredentialInputs,
): Promise<'admin' | 'protected'> {
  const transport = opts.transport ?? nodeHubTransport
  try {
    const res = await transport({
      url: `${server.replace(/\/+$/, '')}/api/auth/whoami`,
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: WHOAMI_TIMEOUT_MS,
      maxBytes: 64 * 1024,
      tls: opts.tls ?? resolveHubTls(server, process.env, opts.dir ?? defaultSessionDir()),
    })
    if (res.status < 200 || res.status >= 300) return 'protected'
    const body: unknown = JSON.parse(res.text)
    return body !== null && typeof body === 'object' && Reflect.get(body, 'isAdmin') === true
      ? 'admin'
      : 'protected'
  } catch {
    return 'protected'
  }
}

/**
 * `resolveCredentials`, then: renew an expiring cached session, and settle the
 * tier from claims (or the hub, for a token that carries none).
 */
export async function resolveFreshCredentials(
  inputs: FreshCredentialInputs,
): Promise<ResolvedCredentials> {
  const now = inputs.now ?? Date.now()
  let creds = resolveCredentials(inputs)
  if (creds.source === 'session' && creds.server !== undefined) {
    const dir = inputs.dir ?? defaultSessionDir()
    const stored = loadSession(creds.server, dir)
    if (stored !== null && stored.token === creds.token && needsRefresh(stored, now)) {
      const next = await renew(stored, {
        server: stored.server,
        dir,
        now,
        ...(inputs.transport ? { transport: inputs.transport } : {}),
        ...(inputs.tls ? { tls: inputs.tls } : {}),
      })
      creds = {
        ...creds,
        token: next.token,
        tier: credentialTier(next.token, { sessionIsAdmin: next.isAdmin === true }),
      }
    }
  }
  if (creds.tier === 'protected' && jwtClaims(creds.token) === null && creds.server !== undefined) {
    return { ...creds, tier: await tierFromHub(creds.server, creds.token, inputs) }
  }
  return creds
}
