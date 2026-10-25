/**
 * The real client address of an HTTP / WS request.
 *
 * The hub is often published through a Cloudflare tunnel whose connector
 * dials it on LOOPBACK, so the socket peer of every internet request is
 * `127.0.0.1`. Fastify's `trustProxy` is off, so `req.ip` is that peer too.
 * Keyed on it, every rate limiter shared one bucket among all remote users.
 *
 * The forwarding headers (`CF-Connecting-IP`, `X-Forwarded-For`) carry the
 * real client — and are a plain claim from whoever sent them. They are read
 * ONLY when the immediate peer is a proxy the hub trusts:
 *
 *  - loopback, always: the tunnel connector, or a proxy on the same host;
 *  - the CIDRs the operator lists in `auth.trustedProxies` (a reverse proxy on
 *    the LAN, the Home Assistant relay).
 *
 * From any other peer the headers are ignored and the peer IS the client — a
 * LAN host is not a proxy, so it cannot claim another LAN address either.
 *
 * `viaProxy` says the request came through a trusted proxy at all. Anything
 * that must hold only for a request made directly on the LAN (skipping the
 * second factor from a trusted network) refuses `viaProxy` outright, whatever
 * address the headers name.
 */
import { createCidrMatcher, normalizeIp } from '@camstack/system'
import { isIP } from 'node:net'

export interface ClientAddress {
  /** The client as best known: a forwarded address via a trusted proxy, else the peer. */
  readonly ip: string | null
  /** The immediate socket peer. */
  readonly peer: string | null
  /** The peer is a trusted proxy (loopback or `auth.trustedProxies`). */
  readonly viaProxy: boolean
}

export interface ClientAddressConfig {
  /** Extra trusted proxies (CIDR or address), on top of loopback. */
  readonly trustedProxies: readonly string[]
}

interface RequestLike {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
  readonly socket?: { readonly remoteAddress?: string | undefined } | null
}

const LOOPBACK = ['127.0.0.0/8', '::1/128']

function header(req: RequestLike, name: string): string | null {
  const raw = req.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function validIp(value: string): string | null {
  const ip = normalizeIp(value)
  return isIP(ip) === 0 ? null : ip
}

export function resolveClientAddress(req: RequestLike, config: ClientAddressConfig): ClientAddress {
  const rawPeer = req.socket?.remoteAddress
  const peer = typeof rawPeer === 'string' && rawPeer.length > 0 ? validIp(rawPeer) : null
  if (peer === null) return { ip: null, peer: null, viaProxy: false }

  const trusted = createCidrMatcher([...LOOPBACK, ...config.trustedProxies])
  if (!trusted.contains(peer)) return { ip: peer, peer, viaProxy: false }

  // Cloudflare stamps the connecting client itself; prefer it when it parses.
  const cf = header(req, 'cf-connecting-ip')
  const cfIp = cf === null ? null : validIp(cf)
  if (cfIp !== null) return { ip: cfIp, peer, viaProxy: true }

  // X-Forwarded-For: each proxy APPENDS the address it received from, so the
  // right-most entry that is not itself a trusted proxy is the client. The
  // left-most is whatever the client chose to send.
  const xff = header(req, 'x-forwarded-for')
  if (xff !== null) {
    const hops = xff.split(',').map((h) => h.trim())
    for (let i = hops.length - 1; i >= 0; i -= 1) {
      const hop = validIp(hops[i] ?? '')
      if (hop === null) continue
      if (!trusted.contains(hop)) return { ip: hop, peer, viaProxy: true }
    }
  }
  return { ip: peer, peer, viaProxy: true }
}
