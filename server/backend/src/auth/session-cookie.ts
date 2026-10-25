/** Browser session cookie carrying the hub JWT. Set by POST /api/auth/session
 *  after a tRPC login; read by the addon-route catch-all for `authenticated`
 *  routes hit by a plain browser navigation. */
export const SESSION_COOKIE = 'camstack_session'

interface CookieSpec {
  readonly name: string
  readonly value: string
  readonly options: {
    httpOnly: boolean
    sameSite: 'lax'
    secure: boolean
    path: string
    maxAge: number
  }
}

export function buildSessionCookie(
  token: string,
  ttlSec: number,
  opts: { readonly secure?: boolean } = {},
): CookieSpec {
  return {
    name: SESSION_COOKIE,
    value: token,
    options: {
      httpOnly: true,
      sameSite: 'lax',
      // Secure cookies are invisible on the LAN HTTP sibling (plain http://).
      // Default stays true so HTTPS callers do not regress.
      secure: opts.secure ?? true,
      path: '/',
      maxAge: ttlSec,
    },
  }
}

export function clearSessionCookie(opts: { readonly secure?: boolean } = {}): CookieSpec {
  return {
    name: SESSION_COOKIE,
    value: '',
    options: { httpOnly: true, sameSite: 'lax', secure: opts.secure ?? true, path: '/', maxAge: 0 },
  }
}

/**
 * Extract the session JWT from a raw `Cookie` request header. Plugin-free
 * (works on both Fastify requests and bare WS upgrade `IncomingMessage`s)
 * so callers don't depend on `@fastify/cookie` decoration order. Returns
 * `null` when the header is absent or carries no `camstack_session` pair.
 */
export function readSessionCookieFromHeader(header: string | undefined): string | null {
  if (!header) return null
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    const name = pair.slice(0, eq).trim()
    if (name !== SESSION_COOKIE) continue
    const raw = pair.slice(eq + 1).trim()
    if (raw === '') return null
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return null
}

/** A browser navigation we can bounce to the login page: a top-level GET
 *  that wants HTML. Anything else (API call, POST, non-HTML) keeps the
 *  401 behavior so programmatic clients get a clean error. */
export function shouldRedirectToLogin(method: string, accept: string | undefined): boolean {
  return method === 'GET' && typeof accept === 'string' && accept.includes('text/html')
}

/**
 * Build the `/login?next=…` URL for an unauthenticated browser request.
 *
 * `mountPrefix` is the path a reverse proxy mounted the admin UI under
 * (`X-Forwarded-Prefix`, already validated — see `api/static/spa-mount.ts`):
 * the login PAGE lives under it, while `next` stays hub-root-relative because
 * the SPA re-mounts it itself (`hubPath`) — so one value serves both the
 * relayed and the direct case.
 */
export function loginRedirectUrl(originalUrl: string, mountPrefix: string | null = null): string {
  return `${mountPrefix ?? ''}/login?next=${encodeURIComponent(originalUrl)}`
}

/** Allowed redirect target for `GET /api/embed-auth`: a same-origin RELATIVE
 *  path to a stream-broker embed page. Defeats open-redirects — the endpoint
 *  sets the session cookie from a Bearer token, so the `next` must be safe to
 *  bounce to. Rejects absolute/protocol-relative URLs, backslashes, and `..`. */
export function isEmbedRedirectTarget(next: string): boolean {
  if (!next.startsWith('/addon/stream-broker/embed/')) return false
  if (next.includes('\\') || next.includes('://') || next.includes('..')) return false
  return true
}

/**
 * True only for a payload with the v2 SESSION shape: string `userId`,
 * boolean `isAdmin`, and NO `kind` discriminator. Challenge/bridge tokens
 * (`kind: 'totp-challenge' | 'sso-bridge'`) verify under the same hub
 * secret but are NOT sessions — accepting one as a session cookie lets a
 * password-only attacker skip the second factor on every cookie-gated
 * surface. Shared by `POST /api/auth/session` and `auth.exchangeSession`.
 */
export function isSessionGradeJwtPayload(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return false
  const p = payload as Record<string, unknown>
  return p.kind === undefined && typeof p.userId === 'string' && typeof p.isAdmin === 'boolean'
}

/**
 * Should the session cookie carry `Secure`, for a request that may have crossed
 * a reverse proxy?
 *
 * The hub decides this from its own leg of the connection, and behind a proxy
 * that leg is the wrong one. Home Assistant's relay reaches the hub over HTTPS
 * while the browser reached Home Assistant over plain HTTP on the LAN, so the
 * hub marked the cookie `Secure` and the browser silently DISCARDED it: the
 * login succeeded, the session existed, and every `<img>` that can only
 * authenticate by cookie came back 401 while the rest of the app — which
 * attaches its bearer token explicitly — worked. That is why the admin UI
 * showed no snapshots inside Home Assistant and everything else looked fine.
 *
 * The relay already SENDS `X-Forwarded-Proto` with the browser's own scheme,
 * next to the prefix header the admin UI's `<base>` depends on. Only this side
 * was missing: the hub read its own socket and never the declaration.
 *
 * Two guards, because `X-Forwarded-Proto` is a client-supplied string:
 *
 *  - it may only ever DOWNGRADE. A request that arrived here over plain HTTP
 *    can never be talked into claiming HTTPS, so the header cannot be used to
 *    make a cookie look safer than its transport.
 *  - it is read ONLY when the request also carries the relay's prefix header,
 *    which is set by the proxy and by nothing else on a direct browser hit. A
 *    direct caller inventing the proto header alone changes nothing.
 */
export function sessionCookieIsSecure(
  requestProtocol: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  forwardedPrefixHeader: string,
): boolean {
  const secureLeg = requestProtocol === 'https'
  if (!secureLeg) return false
  if (headers[forwardedPrefixHeader] === undefined) return true
  const raw = headers['x-forwarded-proto']
  const proto = Array.isArray(raw) ? raw[0] : raw
  if (proto === undefined) return true
  // A comma list means several hops; the FIRST is the browser's own scheme.
  const browserScheme = proto.split(',')[0]?.trim().toLowerCase()
  return browserScheme !== 'http'
}
