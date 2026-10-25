/**
 * The ONE place a device-admin-link URL is built.
 *
 * Every provider of `device-admin-link` calls {@link buildDeviceAdminUrl}. No
 * provider concatenates a URL itself, and `scripts/check-admin-link-builder-
 * is-the-only-url-source.ts` is what makes that true rather than hoped for.
 *
 * ## Why a builder at all, for a string that looks like `http://` + host
 *
 * Because the one thing that must never happen to this string is easy to do by
 * accident. Every provider that knows a device's host knows its PASSWORD too —
 * they sit next to each other in the same device config (`{ host, port,
 * username, password }` on Hikvision, Reolink, Amcrest, ONVIF alike). A
 * convenience that "pre-fills the login" is one template literal away, and
 * `http://admin:hunter2@192.168.60.139/` is a working URL that browsers accept,
 * that lands in the DOM, in a right-click → copy, in a screenshot, and in any
 * log line that prints what was opened. `scripts/check-no-credential-urls-in-
 * fixtures.ts` already exists because this repo shipped exactly that leak on
 * the RTSP surfaces.
 *
 * So the builder takes host/port/scheme/path as SEPARATE arguments — there is
 * no parameter a credential could be passed in — and then re-checks the result
 * it produced. A camera's admin page asks for its own login; that is correct,
 * and pre-filling it is not ours to do.
 */

/** Scheme of a device admin page. Only these two; nothing else is a web page. */
export type DeviceAdminScheme = 'http' | 'https'

/** Everything needed to address a management page, with no room for a secret. */
export interface DeviceAdminUrlParts {
  /** Hostname or IP. Never a URL, never `user@host`. */
  readonly host: string
  /**
   * TCP port of the WEB interface. `null` means "the scheme default" and the
   * port is omitted from the URL.
   *
   * Not the vendor's control port. Reolink's device config carries `port: 9000`
   * — the Baichuan media port — and `http://<reolink>:9000/` answers nothing
   * (verified against 192.168.60.226 on 2026-09-22: `:9000` refuses the
   * connection, `:80` returns 200 text/html). A provider that reads a port
   * field without knowing what that port IS produces a button that opens a
   * browser error.
   */
  readonly port: number | null
  readonly scheme: DeviceAdminScheme
  /** Absolute path, starting with `/`. `'/'` for the site root. */
  readonly path: string
  /**
   * Query parameters, already decided by the caller. Values are encoded here.
   * A key named like a credential is REFUSED — see {@link CREDENTIAL_QUERY_KEYS}.
   */
  readonly query?: Readonly<Record<string, string>>
}

/**
 * Query keys that may never appear on an admin link. A credential smuggled as
 * `?password=` is the same leak as userinfo, in a form the userinfo check
 * cannot see: it survives copy-paste, referrer headers and proxy logs
 * identically.
 */
const CREDENTIAL_QUERY_KEYS: readonly string[] = [
  'password',
  'passwd',
  'pwd',
  'pass',
  'user',
  'username',
  'usr',
  'login',
  'token',
  'access_token',
  'auth',
  'authorization',
  'apikey',
  'api_key',
  'secret',
  'credential',
  'credentials',
  'session',
  'sessionid',
  'key',
]

/**
 * The same userinfo shape `scripts/check-no-credential-urls-in-fixtures.ts`
 * scans recorded fixtures for, applied to what we are about to EMIT. Kept
 * structurally identical on purpose: a URL this function returns is a URL that
 * guard would pass.
 */
const CREDENTIAL_URL = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@'"]+:[^/\s:@'"]+@/i

/** A host that is safe to place in an authority component verbatim. */
const PLAIN_HOST = /^[a-zA-Z0-9._-]+$/
/** A bracketed IPv6 literal, the only other authority form we emit. */
const IPV6_HOST = /^\[[0-9a-fA-F:.]+\]$/

/** Why a link could not be built. Named, because a silent `null` is a defect. */
export type DeviceAdminUrlRefusal =
  | 'empty-host'
  | 'host-not-plain'
  | 'host-carries-userinfo'
  | 'port-out-of-range'
  | 'path-not-absolute'
  | 'credential-query-key'
  | 'userinfo-in-result'

/** Discriminated result — a refusal always carries its reason. */
export type DeviceAdminUrlResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: DeviceAdminUrlRefusal }

function defaultPortFor(scheme: DeviceAdminScheme): number {
  return scheme === 'https' ? 443 : 80
}

/**
 * Build the admin-page URL, or refuse by name.
 *
 * The refusal is never thrown: a provider answering "no page for this device"
 * is an ordinary answer (`getAdminLink` → `null`), and a throw here would turn
 * a missing host on one device into a failed query for the whole surface.
 */
export function buildDeviceAdminUrl(parts: DeviceAdminUrlParts): DeviceAdminUrlResult {
  const host = parts.host.trim()
  if (host.length === 0) return { ok: false, reason: 'empty-host' }
  if (host.includes('@')) return { ok: false, reason: 'host-carries-userinfo' }
  if (!PLAIN_HOST.test(host) && !IPV6_HOST.test(host)) {
    return { ok: false, reason: 'host-not-plain' }
  }

  if (parts.port !== null) {
    if (!Number.isInteger(parts.port) || parts.port < 1 || parts.port > 65535) {
      return { ok: false, reason: 'port-out-of-range' }
    }
  }

  if (!parts.path.startsWith('/')) return { ok: false, reason: 'path-not-absolute' }

  const query = parts.query ?? {}
  for (const key of Object.keys(query)) {
    if (CREDENTIAL_QUERY_KEYS.includes(key.toLowerCase())) {
      return { ok: false, reason: 'credential-query-key' }
    }
  }

  const omitPort = parts.port === null || parts.port === defaultPortFor(parts.scheme)
  const authority = omitPort ? host : `${host}:${String(parts.port)}`

  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) search.append(key, value)
  const suffix = search.size > 0 ? `?${search.toString()}` : ''

  const url = `${parts.scheme}://${authority}${parts.path}${suffix}`

  // Re-check what we produced, not only what we were given. The inputs are
  // validated above; this catches the case the validation did not anticipate.
  if (CREDENTIAL_URL.test(url)) return { ok: false, reason: 'userinfo-in-result' }

  return { ok: true, url }
}

/** Host/port/scheme recovered from an operator-configured base URL. */
export interface DeviceAdminBase {
  readonly ok: true
  readonly host: string
  readonly port: number | null
  readonly scheme: DeviceAdminScheme
  /** Path prefix the base URL carried (`''` when it was just an origin). */
  readonly basePath: string
}

/** Refusal shape for {@link parseAdminBase}. */
export type DeviceAdminBaseResult =
  | DeviceAdminBase
  | { readonly ok: false; readonly reason: DeviceAdminBaseRefusal }

/** Why a configured base URL cannot be used to build a link. */
export type DeviceAdminBaseRefusal =
  | 'empty'
  | 'unparseable'
  | 'scheme-not-http'
  | 'base-carries-userinfo'

export function parseAdminBase(baseUrl: string): DeviceAdminBaseResult {
  const raw = baseUrl.trim()
  if (raw.length === 0) return { ok: false, reason: 'empty' }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, reason: 'unparseable' }
  }

  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'base-carries-userinfo' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'scheme-not-http' }
  }

  const scheme: DeviceAdminScheme = parsed.protocol === 'https:' ? 'https' : 'http'
  const port = parsed.port === '' ? null : Number(parsed.port)
  const basePath = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '')

  return { ok: true, host: parsed.hostname, port, scheme, basePath }
}
