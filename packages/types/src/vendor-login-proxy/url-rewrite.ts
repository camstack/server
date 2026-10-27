/**
 * Pure rewriting for the vendor login proxy (D955).
 *
 * The browser talks to the hub under `<basePath>/<vendorHost>/<path>`; the vendor
 * is reached on its real host. Everything here maps ONE way or the other and
 * never touches the network, so the rules are testable without a socket.
 *
 * What is rewritten, and what is deliberately left alone:
 *  - a vendor URL that STARTS a value (an attribute, a JSON string, a header)
 *    becomes a proxy path;
 *  - a vendor URL that is the VALUE of a query parameter (`?return_to=https://…`,
 *    or its percent-encoded form) is left alone: the vendor reads it back as the
 *    place to return to, and a proxy path there breaks its own redirect check.
 */

export type LoginProxyScheme = 'https' | 'http'

export interface LoginProxyUpstream {
  /** `host` or `host:port`, lower-case. The only hosts the proxy will ever dial. */
  readonly host: string
  /** `http` is accepted for a loopback host only (a local helper, a test vendor). */
  readonly scheme: LoginProxyScheme
}

/** One attempt's view of the proxy: where it is mounted and which hosts it may reach. */
export interface LoginProxyRoute {
  /** `<forwarded prefix>/addon/<addonId>/<prefix>/<attemptId>` — no trailing slash. */
  readonly basePath: string
  readonly upstreams: readonly LoginProxyUpstream[]
}

export interface ParsedProxyPath {
  readonly attemptId: string
  readonly host: string
  /** Path after the host, always starting with `/`. */
  readonly pathname: string
  /** `?…` or the empty string. */
  readonly search: string
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function hostWithoutPort(host: string): string {
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1)
  const colon = host.indexOf(':')
  return colon === -1 ? host : host.slice(0, colon)
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(hostWithoutPort(host.toLowerCase()))
}

/** An allow-list entry is valid when it is a bare host[:port] and `http` only targets loopback. */
export function isValidUpstream(upstream: LoginProxyUpstream): boolean {
  if (upstream.host.length === 0 || !/^[a-z0-9.[\]:-]+$/.test(upstream.host)) return false
  return upstream.scheme === 'https' || isLoopbackHost(upstream.host)
}

export function findUpstream(route: LoginProxyRoute, host: string): LoginProxyUpstream | undefined {
  const wanted = host.toLowerCase()
  return route.upstreams.find((upstream) => upstream.host === wanted)
}

/** `<basePath>/<host><pathname><search>` — what the browser is sent to. */
export function proxyPathFor(
  route: LoginProxyRoute,
  host: string,
  pathname: string,
  search = '',
): string {
  return `${route.basePath}/${host}${pathname.startsWith('/') ? pathname : `/${pathname}`}${search}`
}

/** Split `/<attemptId>/<host>/<rest…>[?query]` (the data-plane view of a request). */
export function parseProxyPath(rawUrl: string): ParsedProxyPath | null {
  const queryAt = rawUrl.indexOf('?')
  const path = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt)
  const search = queryAt === -1 ? '' : rawUrl.slice(queryAt)
  const match = /^\/([A-Za-z0-9_-]{8,128})\/([^/]+)(\/.*)?$/.exec(path)
  if (match === null) return null
  const attemptId = match[1]
  const host = match[2]
  if (attemptId === undefined || host === undefined) return null
  return { attemptId, host: host.toLowerCase(), pathname: match[3] ?? '/', search }
}

/** The vendor URL a proxied request targets, or null when the host would not stay `host`. */
export function upstreamUrlFor(upstream: LoginProxyUpstream, parsed: ParsedProxyPath): URL | null {
  try {
    const url = new URL(`${upstream.scheme}://${upstream.host}${parsed.pathname}${parsed.search}`)
    return url.host.toLowerCase() === upstream.host ? url : null
  } catch {
    return null
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A Location (or any URL value) to a vendor host becomes a proxy path; anything else is unchanged. */
export function rewriteLocation(
  location: string,
  currentUpstream: LoginProxyUpstream,
  route: LoginProxyRoute,
): string {
  let resolved: URL
  try {
    resolved = new URL(location, `${currentUpstream.scheme}://${currentUpstream.host}/`)
  } catch {
    return location
  }
  if (resolved.protocol !== 'https:' && resolved.protocol !== 'http:') return location
  const target = findUpstream(route, resolved.host)
  if (target === undefined) return location
  return `${proxyPathFor(route, target.host, resolved.pathname, resolved.search)}${resolved.hash}`
}

/** Characters that may precede a URL that STARTS a value (never `=`, `?`, `&`, `%3D`). */
const VALUE_START = String.raw`(?<=^|["'(\s>,\[{])`

export type BodyKind = 'html' | 'css' | 'other'

/**
 * Rewrite vendor URLs in a text body: absolute (`https://host/…`), protocol-relative
 * (`//host/…`) and JSON-escaped (`https:\/\/host\/…`) when they start a value; and, in
 * HTML/CSS, root-relative references (`href="/x"`, `url(/x)`) which would otherwise
 * escape the proxy mount and land on the hub.
 */
export function rewriteBody(
  body: string,
  kind: BodyKind,
  currentUpstream: LoginProxyUpstream,
  route: LoginProxyRoute,
): string {
  let out = body
  for (const upstream of route.upstreams) {
    const host = escapeRegex(upstream.host)
    const plain = new RegExp(`${VALUE_START}(?:https?:)?//${host}(?=[/"'?#\\s)\\]},<]|$)`, 'g')
    out = out.replace(plain, `${route.basePath}/${upstream.host}`)
    const escapedBase = `${route.basePath}/${upstream.host}`.replace(/\//g, '\\/')
    const escaped = new RegExp(
      `${VALUE_START}(?:https?:)?\\\\/\\\\/${host}(?=\\\\/|["'?#\\s)\\]},<]|$)`,
      'g',
    )
    out = out.replace(escaped, escapedBase)
  }
  const current = `${route.basePath}/${currentUpstream.host}/`
  // A reference already under the proxy mount (just rewritten above) is not root-relative to the vendor.
  const notMounted = `(?!/)(?!${escapeRegex(route.basePath.slice(1))}/)`
  if (kind === 'html') {
    const attribute = String.raw`(\b(?:href|src|action|formaction|poster|data-href|data-src)\s*=\s*["'])/`
    out = out.replace(new RegExp(`${attribute}${notMounted}`, 'gi'), `$1${current}`)
  }
  if (kind === 'html' || kind === 'css') {
    const cssUrl = String.raw`(url\(\s*["']?)/`
    out = out.replace(new RegExp(`${cssUrl}${notMounted}`, 'gi'), `$1${current}`)
  }
  return out
}

/**
 * A vendor `Set-Cookie` for the browser: no `Domain` (the cookie belongs to the hub
 * origin), `Path` narrowed to this attempt's prefix, `Secure` kept (the hub is HTTPS).
 */
export function rewriteSetCookie(cookie: string, route: LoginProxyRoute): string {
  const parts = cookie.split(';').map((part) => part.trim())
  const kept = parts.filter((part, index) => {
    if (index === 0) return true
    const name = part.split('=')[0]?.trim().toLowerCase() ?? ''
    return name !== 'domain' && name !== 'path'
  })
  kept.push(`Path=${route.basePath}/`)
  return kept.join('; ')
}

/**
 * A browser `Referer` that points into this proxy, turned back into the vendor URL it
 * stands for. A Referer that is not ours is dropped (null): it names the hub.
 */
export function rewriteReferer(referer: string, route: LoginProxyRoute): string | null {
  let url: URL
  try {
    url = new URL(referer, 'http://hub.invalid')
  } catch {
    return null
  }
  if (!url.pathname.startsWith(`${route.basePath}/`)) return null
  const rest = /^\/([^/]+)(\/.*)?$/.exec(url.pathname.slice(route.basePath.length))
  const host = rest?.[1]?.toLowerCase()
  if (host === undefined) return null
  const upstream = findUpstream(route, host)
  if (upstream === undefined) return null
  return `${upstream.scheme}://${upstream.host}${rest?.[2] ?? '/'}${url.search}`
}

/** Cookies the browser holds for the hub itself must never reach a vendor. */
export function filterForwardedCookies(cookieHeader: string): string {
  return cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.toLowerCase().startsWith('camstack_'))
    .join('; ')
}
