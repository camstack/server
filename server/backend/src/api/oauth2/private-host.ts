/**
 * Is this hostname unreachable from the public internet?
 *
 * Used by `/api/oauth2/authorize` to admit a `redirect_uri` whose host the hub
 * cannot know in advance — a self-hosted Home Assistant at
 * `http://192.168.10.40:8123/auth/external/callback`. Pairing "private host" with
 * "exact path" is what keeps that from being a wildcard prefix: a public host
 * never satisfies it, so the worst an attacker can aim a code at is a machine
 * they already need LAN presence to read.
 *
 * Literal inspection only — deliberately NO DNS resolution. A resolver turns an
 * authorize request into an outbound lookup an attacker controls (SSRF-shaped,
 * and a DNS-rebind race on top: the address that answers at validation time is
 * not the one the browser will use). Names are admitted only by suffix, from a
 * closed list of suffixes that cannot be registered on the public internet.
 */

/** Suffixes that are, by definition, not publicly routable names. */
const PRIVATE_NAME_SUFFIXES = ['.local', '.internal', '.home.arpa', '.ts.net'] as const

/** Names that are exactly the loopback host. */
const LOOPBACK_NAMES = ['localhost', 'localhost.localdomain'] as const

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false
    const n = Number(part)
    if (n > 255) return false
    octets.push(n)
  }
  const [a, b] = octets as [number, number, number, number]
  if (a === 127) return true // loopback
  if (a === 10) return true // RFC1918
  if (a === 192 && b === 168) return true // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
  if (a === 169 && b === 254) return true // link-local
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT / Tailscale 100.64/10
  return false
}

function isPrivateIpv6(host: string): boolean {
  // URL.hostname keeps IPv6 literals in brackets.
  const inner = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (!inner.includes(':')) return false
  const lower = inner.toLowerCase()
  if (lower === '::1' || lower === '::') return true // loopback / unspecified
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true // fe80::/10 link-local
  return false
}

/**
 * True iff `host` (a `URL.hostname`, already lowercased by the URL parser) is
 * private by literal inspection. Never resolves.
 */
export function isPrivateHost(host: string): boolean {
  if (host === '') return false
  if ((LOOPBACK_NAMES as readonly string[]).includes(host)) return true
  if (isPrivateIpv4(host)) return true
  if (isPrivateIpv6(host)) return true
  return PRIVATE_NAME_SUFFIXES.some((suffix) => host.endsWith(suffix))
}
