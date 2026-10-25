/**
 * cors-policy — which browser origins may READ this hub's responses (D707).
 *
 * The viewer PWA is hosted at {@link VIEWER_PWA_ORIGIN} and talks to each
 * operator's own hub straight from the browser — no proxy, no cloud. Before
 * D707 the hub answered every request with `Access-Control-Allow-Origin: *`,
 * which let ANY web page a user visited read any hub response its script could
 * reach (an unauthenticated probe of a LAN hub, for one). The policy is now an
 * allowlist:
 *
 *  - the hub's OWN origin — the `Origin` whose host is the request's `Host`
 *    (or `X-Forwarded-Host`, which a relay such as the Home Assistant panel
 *    proxy sets to ITS origin). Same-origin calls never needed CORS; this
 *    entry exists for the WebSocket check, where a browser always sends
 *    `Origin` and the native clients send their target's;
 *  - {@link VIEWER_PWA_ORIGIN}, the hosted viewer;
 *  - {@link OPAQUE_ORIGIN} (`null`): the native app's OTA-bundled embed is a
 *    `file://` page inside a WKWebView, whose origin is opaque. Removing it
 *    breaks live view on iOS;
 *  - the operator's extras (`server.corsOrigins` in config.yaml /
 *    `CAMSTACK_CORS_ORIGINS`). The hub's own public address needs no entry:
 *    a browser on it is the `own-host` case above.
 *
 * The answer to an allowed origin REFLECTS it exactly — never `*` — and never
 * carries `Access-Control-Allow-Credentials`. The cross-origin viewer
 * authenticates with a bearer token in `Authorization` (or tRPC
 * `connectionParams` on the socket), which needs no credentials mode; the
 * httpOnly session cookie therefore never rides a cross-origin request, so the
 * cookie-gated surfaces (`auth.exchangeSession`, `/api/embed-auth`, the
 * admin-ui) stay same-origin by construction.
 *
 * Pure: no Fastify, no I/O — `register-cors-policy.ts` is the glue.
 */

/** The hosted viewer PWA (operator decision 2026-10-06). */
export const VIEWER_PWA_ORIGIN = 'https://camstack.zentik.app'

/**
 * The serialisation of an opaque origin. The native app's OTA embed
 * (`assets/embed/camstack-embed.html`, loaded from `file://`) sends it.
 */
export const OPAQUE_ORIGIN = 'null'

/** Every method a hub route answers. */
export const CORS_ALLOWED_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS'

/**
 * Request headers a cross-origin caller may send. `authorization` is the
 * whole point; `range` is recorded-media seeking; the `trpc-*` / `x-trpc-*`
 * names are what `@trpc/client` links may add. NOT `x-camstack-exchange`:
 * the cookie→bearer exchange is a same-origin mechanism and a cross-origin
 * page has no business asking for it.
 */
export const CORS_ALLOWED_HEADERS =
  'authorization, content-type, range, if-range, if-none-match, cache-control, trpc-accept, x-trpc-source, x-trpc-batch-mode'

/**
 * Response headers a cross-origin script may read. The byte-range trio is
 * recorded playback (a seek reads `content-range`); `content-disposition` is
 * export downloads; `retry-after` is the rate limiter; the `x-camstack-*`
 * trio is the clip-still contract (a 204 that says WHY there is no image).
 */
export const CORS_EXPOSED_HEADERS =
  'content-range, accept-ranges, content-length, content-disposition, etag, retry-after, x-camstack-reason, x-camstack-reason-code, x-camstack-disposition'

/** Preflight cache. Chromium caps at 7200 s; Firefox honours up to 86400. */
export const CORS_PREFLIGHT_MAX_AGE_SEC = 7200

/** The facts the verdict reads off a request. */
export interface CorsRequestFacts {
  readonly origin: string | undefined
  readonly host: string | undefined
  readonly forwardedHost: string | undefined
}

export type CorsAllowReason = 'own-host' | 'listed'

export type CorsVerdict =
  /** No `Origin` header: not a CORS request (native fetch, curl, a server). */
  | { readonly kind: 'no-origin' }
  | { readonly kind: 'allowed'; readonly origin: string; readonly reason: CorsAllowReason }
  | { readonly kind: 'denied'; readonly origin: string }

/** The operator's configured list, split into what is usable and what is not. */
export interface ParsedOriginList {
  readonly origins: readonly string[]
  readonly rejected: readonly string[]
}

/**
 * The canonical serialisation of an origin (`scheme://host[:port]`, lower
 * case, default port dropped), or `null` when `raw` is not an http(s) origin.
 * `null` (the opaque origin) is accepted verbatim.
 */
export function normalizeOrigin(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === OPAQUE_ORIGIN) return OPAQUE_ORIGIN
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  // An origin has no path, query, fragment or credentials. Accept a bare
  // trailing slash (a common paste), refuse anything that names more.
  if (url.username !== '' || url.password !== '') return null
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    return null
  }
  return url.origin
}

/** Read the configured value (array from YAML, already split from env). */
export function parseConfiguredOrigins(value: unknown): ParsedOriginList {
  if (!Array.isArray(value)) return { origins: [], rejected: [] }
  const origins: string[] = []
  const rejected: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') {
      rejected.push(String(entry))
      continue
    }
    const normalized = normalizeOrigin(entry)
    if (normalized === null) rejected.push(entry)
    else origins.push(normalized)
  }
  return { origins, rejected }
}

/** The built-in entries. */
export function builtInOrigins(): readonly string[] {
  return [VIEWER_PWA_ORIGIN, OPAQUE_ORIGIN]
}

/** The first value of a possibly comma-joined forwarding header, lower case. */
function firstHost(value: string | undefined): string | null {
  if (value === undefined) return null
  const first = value.split(',')[0]?.trim().toLowerCase() ?? ''
  return first.length > 0 ? first : null
}

/** `host[:port]` of an http(s) origin, or null. */
function hostOfOrigin(origin: string): string | null {
  if (origin === OPAQUE_ORIGIN) return null
  try {
    return new URL(origin).host.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Judge one request's `Origin`. `listed` is the full allowlist (built-ins and
 * the operator's extras), already normalised.
 */
export function judgeCorsOrigin(facts: CorsRequestFacts, listed: ReadonlySet<string>): CorsVerdict {
  const raw = facts.origin
  if (raw === undefined || raw.length === 0) return { kind: 'no-origin' }
  const normalized = normalizeOrigin(raw)
  if (normalized === null) return { kind: 'denied', origin: raw }
  if (listed.has(normalized)) return { kind: 'allowed', origin: raw, reason: 'listed' }
  const originHost = hostOfOrigin(normalized)
  if (originHost !== null) {
    const ownHosts = [firstHost(facts.host), firstHost(facts.forwardedHost)]
    if (ownHosts.includes(originHost)) return { kind: 'allowed', origin: raw, reason: 'own-host' }
  }
  return { kind: 'denied', origin: raw }
}

/** What a preflight asked for, beyond the method. */
export interface CorsPreflightFacts {
  /** `Access-Control-Request-Private-Network: true` (Chromium PNA). */
  readonly requestPrivateNetwork: boolean
}

/**
 * The headers an ALLOWED origin gets. `preflight` adds the method/header
 * grants and the cache lifetime. The origin is the exact one the browser
 * sent — reflecting it is what lets the browser hand the response to the
 * page, and `Vary: Origin` (set by the glue on every response) keeps a cache
 * from serving one origin's answer to another.
 */
export function corsResponseHeaders(
  origin: string,
  preflight: CorsPreflightFacts | null,
): Readonly<Record<string, string>> {
  const base: Record<string, string> = {
    'access-control-allow-origin': origin,
    'access-control-expose-headers': CORS_EXPOSED_HEADERS,
  }
  if (preflight === null) return base
  return {
    ...base,
    'access-control-allow-methods': CORS_ALLOWED_METHODS,
    'access-control-allow-headers': CORS_ALLOWED_HEADERS,
    'access-control-max-age': String(CORS_PREFLIGHT_MAX_AGE_SEC),
    // A public origin (the PWA) calling a LAN hub is a "private network"
    // request to Chromium; its preflight must be answered explicitly.
    ...(preflight.requestPrivateNetwork ? { 'access-control-allow-private-network': 'true' } : {}),
  }
}

/** Append `token` to a `Vary` value unless it is already there. */
export function appendVary(existing: string | undefined, token: string): string {
  if (existing === undefined || existing.trim().length === 0) return token
  const parts = existing.split(',').map((p) => p.trim().toLowerCase())
  if (parts.includes('*') || parts.includes(token.toLowerCase())) return existing
  return `${existing}, ${token}`
}
