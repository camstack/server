/**
 * The hub address an OIDC sign-in STARTED at — so it returns there (D791).
 *
 * The browser must come back to the origin it left from: the session cookie,
 * the admin UI's stored token and a popup's `window.opener` all belong to
 * one origin. Before this the `redirect_uri` was the hub's single browser
 * address (`hubBrowserOrigin`), so a sign-in started on the LAN address
 * (`https://192.168.x.x:4443`) finished on the public tunnel.
 *
 * The origin is read from the `/start` request — `X-Forwarded-Host` /
 * `Host`, `X-Forwarded-Proto` — and is NEVER trusted as such: a forged
 * `Host` would otherwise choose where the IdP sends the authorization code.
 * It is used only when it equals, exactly, an origin the hub advertises
 * itself at (the Network page's addresses: detected, custom, the public
 * endpoint, the app-connection set) or the origin of the operator's
 * configured redirect override. Anything else falls back to the default
 * browser address, exactly as before.
 *
 * The mount prefix (`X-Forwarded-Prefix`, the reverse-proxy relay) is kept on
 * the path when well-formed — it can only move the callback within an
 * allowlisted origin, where the hub serves or 404s it and a strict IdP
 * refuses an unregistered one.
 */
import type { HubAddressBook } from '../capabilities/local-network.cap.js'

/** A request's headers as the addon-routes bridge hands them (lower-cased names). */
export type RequestHeaders = Readonly<Record<string, string | undefined>>

/** host[:port] — a DNS name, IPv4 or bracketed IPv6. No userinfo, path or spaces. */
const AUTHORITY_RE = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i

/** Same grammar as the hub's `parseForwardedPrefix` (spa-mount.ts). */
const PREFIX_RE = /^\/[A-Za-z0-9_\-.]+(?:\/[A-Za-z0-9_\-.]+)*$/
const MAX_PREFIX_LENGTH = 512

/** First value of a possibly comma-joined forwarded header (the client-most proxy). */
function firstValue(value: string | undefined): string | null {
  if (value === undefined) return null
  const first = value.split(',')[0]?.trim() ?? ''
  return first.length === 0 ? null : first
}

/** `scheme://host[:port]` normalised by WHATWG URL, or `null` if it is not an http(s) origin. */
export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.username !== '' || url.password !== '') return null
    return url.origin
  } catch {
    return null
  }
}

/** The mount prefix the relay named (no trailing slash), or `''`. Invalid = absent. */
export function requestMountPrefix(headers: RequestHeaders): string {
  const raw = headers['x-forwarded-prefix']
  if (raw === undefined || raw.length === 0 || raw.length > MAX_PREFIX_LENGTH) return ''
  const trimmed = raw.endsWith('/') ? raw.slice(0, -1) : raw
  if (trimmed === '' || !PREFIX_RE.test(trimmed)) return ''
  if (trimmed.split('/').some((segment) => segment === '..' || segment === '.')) return ''
  return trimmed
}

/**
 * The origins the request CLAIMS, most specific first: the proxy's
 * `X-Forwarded-Host` over `Host`; the named `X-Forwarded-Proto`, or https
 * then http when none is named (the hub terminates TLS itself on 4443).
 */
export function claimedRequestOrigins(headers: RequestHeaders): readonly string[] {
  const authority = firstValue(headers['x-forwarded-host']) ?? firstValue(headers['host'])
  if (authority === null || !AUTHORITY_RE.test(authority)) return []
  const proto = firstValue(headers['x-forwarded-proto'])?.toLowerCase() ?? null
  const schemes =
    proto === 'https' || proto === 'http' ? [proto] : proto === null ? ['https', 'http'] : []
  const out: string[] = []
  for (const scheme of schemes) {
    const origin = normalizeOrigin(`${scheme}://${authority}`)
    if (origin !== null) out.push(origin)
  }
  return out
}

/** Every origin the hub advertises itself at, normalised. Never the app link, never loopback. */
export function advertisedHubOrigins(book: HubAddressBook): ReadonlySet<string> {
  const candidates: string[] = []
  for (const row of book.rows) {
    if (row.kind === 'app-link' || row.kind === 'loopback') continue
    candidates.push(row.baseUrl)
  }
  const { publicEndpoint, internal, appConnections } = book.roles
  if (publicEndpoint.resolved !== null) candidates.push(publicEndpoint.resolved)
  if (internal.resolved !== null) candidates.push(internal.resolved)
  candidates.push(...appConnections.resolved)
  // Where the listeners really answer: the https origin of a LAN address is in no
  // row while LAN HTTP is on. An older hub omits the field and behaves as before.
  candidates.push(...(book.listenerOrigins ?? []))
  const out = new Set<string>()
  for (const candidate of candidates) {
    const origin = normalizeOrigin(candidate)
    if (origin !== null) out.add(origin)
  }
  return out
}

/**
 * The origin to send the browser back to: the first claimed origin that is in
 * `allowed`, or `null` (the caller then uses its default address).
 */
export function pickRequestOrigin(
  headers: RequestHeaders,
  allowed: ReadonlySet<string>,
): string | null {
  for (const origin of claimedRequestOrigins(headers)) {
    if (allowed.has(origin)) return origin
  }
  return null
}
