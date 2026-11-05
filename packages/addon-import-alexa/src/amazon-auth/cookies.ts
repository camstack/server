/**
 * Cookie helpers of the Amazon sign-in. Amazon hands out many cookies; only the ones the
 * Alexa app flow needs are kept (the allow-list below), and values are never logged.
 *
 * Adapted from alexa-cookie2 (MIT, Copyright (c) Apollon77 and contributors); see
 * assets/alexa-cookie2.LICENSE.md.
 */

/** The cookie names Amazon's device registration and token exchange accept. */
const AMAZON_COOKIE_NAME =
  /^(session-id|session-id-time|session-token|ubid-.+|lc-.+|x-.+|at-.+|sess-at-.+|frc|map-md|csrf|sid|csm-hit|i18n-prefs|sp-cdn|skin)$/

export function isAmazonCookieName(name: string): boolean {
  return AMAZON_COOKIE_NAME.test(name)
}

/** A `Cookie` header as an ordered name to value map (values kept exactly as sent, so a re-serialised header round-trips). */
export function parseCookieHeader(header: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    if (name.length === 0 || out.has(name)) continue
    out.set(name, part.slice(eq + 1).trim())
  }
  return out
}

export function serializeCookies(cookies: ReadonlyMap<string, string>): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
}

/** Name and raw value of a `Set-Cookie` line, or null for a cookie that carries no value. */
export function parseSetCookie(
  line: string,
): { readonly name: string; readonly value: string } | null {
  const first = line.split(';')[0] ?? ''
  const eq = first.indexOf('=')
  if (eq <= 0) return null
  const name = first.slice(0, eq).trim()
  const value = first.slice(eq + 1).trim()
  if (name.length === 0 || value.length === 0) return null
  if (name === 'ap-fid' && value === '""') return null
  return { name, value }
}

/** `cookie` merged with the `Set-Cookie` lines of a response; a later value replaces an earlier one. */
export function mergeSetCookies(cookie: string, setCookies: readonly string[]): string {
  if (setCookies.length === 0) return cookie
  const cookies = parseCookieHeader(cookie)
  for (const line of setCookies) {
    const parsed = parseSetCookie(line)
    if (parsed !== null) cookies.set(parsed.name, parsed.value)
  }
  return serializeCookies(cookies)
}

/** Only the allow-listed cookies of a `Cookie` header. */
export function sanitizeAmazonCookie(cookie: string): string {
  const kept = new Map<string, string>()
  for (const [name, value] of parseCookieHeader(cookie)) {
    if (isAmazonCookieName(name)) kept.set(name, value)
  }
  return serializeCookies(kept)
}

/** Add `name=value` unless the header already carries that name. */
export function withCookie(cookie: string, name: string, value: string): string {
  const cookies = parseCookieHeader(cookie)
  if (!cookies.has(name)) cookies.set(name, value)
  return serializeCookies(cookies)
}
