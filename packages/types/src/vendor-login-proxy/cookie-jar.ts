/**
 * Server-side cookie jar of ONE vendor sign-in attempt (D955).
 *
 * A vendor login (an identity provider's cookie/JS check page) refuses a flow that arrives
 * without the cookies it set a step earlier. Relying on the browser to store them under the
 * hub origin loses them whenever the browser refuses the rewritten cookie (a `Secure` cookie
 * on a plain-http hub, a `__Host-` name with a narrowed Path, a `SameSite=None` without
 * `Secure`). The proxy therefore keeps every vendor cookie itself and sends them upstream,
 * whatever the browser did. Values never leave this object except as the upstream `Cookie`
 * header; nothing here logs.
 */
import { hostWithoutPort, isLoopbackHost, type LoginProxyScheme } from './url-rewrite.js'

interface JarCookie {
  readonly name: string
  readonly value: string
  /** `host[:port]` of the response that set it. */
  readonly originHost: string
  /** Lower-case `Domain` attribute without a leading dot, or null (host-only). */
  readonly domain: string | null
  readonly path: string
  readonly secure: boolean
  readonly expiresAtMs: number | null
}

function attributeValue(attrs: readonly string[], name: string): string | undefined {
  const found = attrs.find((a) => a.split('=')[0]?.trim().toLowerCase() === name)
  if (found === undefined) return undefined
  const eq = found.indexOf('=')
  return eq === -1 ? '' : found.slice(eq + 1).trim()
}

function hasFlag(attrs: readonly string[], name: string): boolean {
  return attrs.some((a) => a.toLowerCase() === name)
}

function expiryOf(attrs: readonly string[], nowMs: number): number | null {
  const maxAge = attributeValue(attrs, 'max-age')
  if (maxAge !== undefined && maxAge.length > 0 && Number.isFinite(Number(maxAge))) {
    return nowMs + Number(maxAge) * 1000
  }
  const expires = attributeValue(attrs, 'expires')
  if (expires === undefined) return null
  const at = Date.parse(expires)
  return Number.isFinite(at) ? at : null
}

function defaultPath(requestPath: string): string {
  const last = requestPath.lastIndexOf('/')
  return last <= 0 ? '/' : requestPath.slice(0, last)
}

function pathMatches(cookiePath: string, requestPath: string): boolean {
  if (requestPath === cookiePath) return true
  if (!requestPath.startsWith(cookiePath)) return false
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/'
}

function hostMatches(cookie: JarCookie, host: string): boolean {
  if (cookie.domain === null) return cookie.originHost === host
  const bare = hostWithoutPort(host)
  return bare === cookie.domain || bare.endsWith(`.${cookie.domain}`)
}

export class VendorCookieJar {
  readonly #cookies = new Map<string, JarCookie>()

  /** Store (or delete, when expired) the cookies of one upstream response. */
  store(
    setCookies: readonly string[],
    origin: { readonly host: string; readonly pathname: string },
    nowMs: number,
  ): void {
    for (const raw of setCookies) {
      const [first, ...rest] = raw.split(';').map((part) => part.trim())
      const eq = first?.indexOf('=') ?? -1
      if (first === undefined || eq <= 0) continue
      const name = first.slice(0, eq)
      const attrs = rest
      const domainAttr = attributeValue(attrs, 'domain')
      const domain =
        domainAttr === undefined || domainAttr.length === 0
          ? null
          : domainAttr.replace(/^\./, '').toLowerCase()
      const pathAttr = attributeValue(attrs, 'path')
      const path =
        pathAttr !== undefined && pathAttr.startsWith('/') ? pathAttr : defaultPath(origin.pathname)
      // A Domain the response's own host is not part of is refused, as a browser would.
      const originBare = hostWithoutPort(origin.host)
      if (domain !== null && originBare !== domain && !originBare.endsWith(`.${domain}`)) continue
      const expiresAtMs = expiryOf(attrs, nowMs)
      const key = `${name}|${domain ?? origin.host}|${path}`
      if (expiresAtMs !== null && expiresAtMs <= nowMs) {
        this.#cookies.delete(key)
        continue
      }
      this.#cookies.set(key, {
        name,
        value: first.slice(eq + 1),
        originHost: origin.host,
        domain,
        path,
        secure: hasFlag(attrs, 'secure'),
        expiresAtMs,
      })
    }
  }

  /** The `Cookie` header value for a request to `host` + `pathname`, or null when none applies. */
  headerFor(
    target: {
      readonly host: string
      readonly pathname: string
      readonly scheme: LoginProxyScheme
    },
    nowMs: number,
  ): string | null {
    const secureOk = target.scheme === 'https' || isLoopbackHost(target.host)
    const matching = [...this.#cookies.values()]
      .filter(
        (c) =>
          (c.expiresAtMs === null || c.expiresAtMs > nowMs) &&
          (!c.secure || secureOk) &&
          hostMatches(c, target.host) &&
          pathMatches(c.path, target.pathname),
      )
      .sort((a, b) => b.path.length - a.path.length)
    if (matching.length === 0) return null
    return matching.map((c) => `${c.name}=${c.value}`).join('; ')
  }
}

/** Cookie names carried by a `Cookie` header value. */
export function cookieHeaderNames(header: string): Set<string> {
  return new Set(
    header
      .split(';')
      .map((part) => part.split('=')[0]?.trim() ?? '')
      .filter((name) => name.length > 0),
  )
}

/** `browser` cookies not shadowed by the jar's, then the jar's: the jar is the truth. */
export function mergeCookieHeaders(browser: string, jar: string | null): string {
  if (jar === null) return browser
  const shadowed = cookieHeaderNames(jar)
  const kept = browser
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !shadowed.has(part.split('=')[0]?.trim() ?? ''))
  return [...kept, jar].join('; ')
}
