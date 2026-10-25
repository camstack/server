/**
 * Origin/rpId visibility gate for the shell-native passkey login button.
 *
 * Pure — no browser API dependency (`browserSupportsWebAuthn()` is
 * checked separately by the caller), so it's testable without jsdom
 * simulating the WebAuthn API. WebAuthn requires a domain RP ID: a
 * passkey ceremony can never complete on a raw-IP origin, and the
 * assertion's `rpId` must equal (or be a parent domain of) the page's
 * hostname. Gating here means the login page never shows a button that
 * is guaranteed to fail before the ceremony even starts.
 */

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/

/**
 * `true` when `hostname` is an IPv4 dotted-quad or an IPv6 literal —
 * bracketed (`window.location.hostname`'s form, e.g. `[::1]`) or bare
 * (e.g. `::1`, `fdda:abcd::1`). `localhost` is NOT an IP literal — it's
 * a valid RP ID for local development.
 */
export function isIpLiteral(hostname: string): boolean {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  if (IPV4_RE.test(bare)) return true
  // Hostnames never legitimately contain a colon — any colon-bearing
  // token is an IPv6 literal (full or shorthand form).
  if (bare.includes(':')) return true
  return false
}

/**
 * `true` iff the passkey ceremony can succeed on the current origin:
 * the hostname is not an IP literal, and it either equals the addon's
 * effective `rpId` or is a subdomain of it (`hostname.endsWith('.' + rpId)`).
 * An empty `rpId` (unconfigured) always gates out.
 */
export function passkeyUsableOnOrigin(hostname: string, rpId: string): boolean {
  if (!rpId) return false
  if (isIpLiteral(hostname)) return false
  return hostname === rpId || hostname.endsWith(`.${rpId}`)
}
