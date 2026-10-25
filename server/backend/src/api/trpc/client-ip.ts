/**
 * Client-IP extraction + LAN/remote classification for the tRPC layer.
 *
 * Used by the `webrtcSession.createSession` override to decide whether a
 * live-view session should force TURN-relay-only ICE: a viewer behind
 * CGNAT/4G (a non-LAN source IP) only ever offers a relay candidate, so
 * the broker must offer a genuinely relay-only SDP (the patched werift
 * emits one under `iceTransportPolicy:'relay'`) to get a clean
 * relay↔relay media path. LAN viewers (private/loopback source IP) keep
 * the low-latency direct host/srflx path. The SERVER computes this — the
 * client never sends a relay-only flag.
 */
import type { FastifyRequest } from 'fastify'
import type { IncomingMessage } from 'node:http'

export type ClientRequest = FastifyRequest | IncomingMessage

/**
 * Best-effort extraction of the originating client IP from a tRPC
 * request. Order of preference:
 *   1. `X-Forwarded-For` first hop (when behind a reverse proxy — the
 *      hub is typically fronted by Caddy/nginx/Cloudflare for remote
 *      access, so the socket peer is the proxy, not the viewer).
 *   2. Fastify's `req.ip` (already proxy-aware when `trustProxy` is on).
 *   3. The raw socket remote address.
 *
 * Returns `null` when no address can be determined (e.g. mesh-originated
 * calls that carry no HTTP request) — the caller treats `null` as "not
 * remote" so the LAN/direct path stays the safe default.
 */
export function extractClientIp(req: ClientRequest | undefined): string | null {
  if (!req) return null

  // 1. X-Forwarded-For — comma-separated list, client is the FIRST entry.
  const xff = req.headers['x-forwarded-for']
  const xffValue = Array.isArray(xff) ? xff[0] : xff
  if (typeof xffValue === 'string' && xffValue.length > 0) {
    const first = xffValue.split(',')[0]?.trim()
    if (first) return normalizeIp(first)
  }

  // 2. Fastify's parsed `req.ip` (honours `trustProxy` config).
  if ('ip' in req && typeof req.ip === 'string' && req.ip.length > 0) {
    return normalizeIp(req.ip)
  }

  // 3. Raw socket peer (WS / IncomingMessage path).
  const remote = req.socket?.remoteAddress
  if (typeof remote === 'string' && remote.length > 0) {
    return normalizeIp(remote)
  }

  return null
}

/**
 * Best-effort read of Cloudflare's `CF-Connecting-IP` request header. When
 * the hub is reached through a Cloudflare Tunnel, the local `cloudflared`
 * connector originates the request from LOOPBACK, so the socket peer (and
 * usually `req.ip`) is `127.0.0.1` — a genuinely-remote viewer would
 * otherwise be misclassified LAN. Cloudflare stamps the real client address
 * in `CF-Connecting-IP` on every tunneled request.
 *
 * SECURITY: this header is trivially spoofable by any client that can reach
 * the hub directly (it's just an HTTP header). It is therefore trusted ONLY
 * when the immediate socket peer is loopback/LAN — see `classifyClient`. A
 * direct internet client that forges the header still classifies by its own
 * (remote) peer address. Returns `null` when absent.
 */
export function extractCfConnectingIp(req: ClientRequest | undefined): string | null {
  if (!req) return null
  const raw = req.headers['cf-connecting-ip']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value === 'string' && value.length > 0) return normalizeIp(value.trim())
  return null
}

/**
 * Immediate socket peer address (never the `X-Forwarded-For` / `req.ip`
 * proxy-resolved value). Used only to gate `CF-Connecting-IP` trust: the
 * header is honoured solely when the request physically arrived from a
 * loopback/LAN peer (the local `cloudflared` connector). Returns `null` when
 * no socket is present (mesh-originated calls).
 */
export function extractPeerIp(req: ClientRequest | undefined): string | null {
  if (!req) return null
  const remote = req.socket?.remoteAddress
  if (typeof remote === 'string' && remote.length > 0) return normalizeIp(remote)
  return null
}

/**
 * Best-effort read of the originating client's `User-Agent` header. Both
 * request shapes in the union (`FastifyRequest` and the raw WS-transport
 * `IncomingMessage`) expose `.headers['user-agent']`. Returns `null` when
 * absent (mesh-originated calls carry no HTTP request, and some clients
 * omit the header). Used by the `webrtc-session` mount to tag a browser
 * subscriber's broker attribution with the viewer's UA — the SERVER reads
 * it from the request context; any client-supplied value is ignored.
 */
export function extractUserAgent(req: ClientRequest | undefined): string | null {
  if (!req) return null
  const ua = req.headers['user-agent']
  const value = Array.isArray(ua) ? ua[0] : ua
  if (typeof value === 'string' && value.length > 0) return value
  return null
}

/**
 * Strip an IPv4-mapped IPv6 prefix (`::ffff:192.168.10.5` → `192.168.10.5`)
 * and any zone id (`fe80::1%en0` → `fe80::1`) so the range checks below
 * see a clean address.
 */
function normalizeIp(ip: string): string {
  let out = ip.trim()
  if (out.startsWith('::ffff:')) out = out.slice('::ffff:'.length)
  const pct = out.indexOf('%')
  if (pct !== -1) out = out.slice(0, pct)
  return out
}

/**
 * Three-way classification of a viewer's source address, driving the
 * per-session ICE policy:
 *   - `'lan'`    — private / loopback / link-local (RFC1918, 127/8, fe80::,
 *                  fc00::/7 generic ULA). Low-latency direct host/srflx path.
 *   - `'vpn'`    — Tailscale overlay: 100.64.0.0/10 CGNAT (v4) or
 *                  fd7a:115c:a1e0::/48 ULA (v6). A client that reached the hub
 *                  on the hub's OWN tailscale address arrives on this overlay.
 *                  Both peers sit on the overlay and are mutually reachable, so
 *                  a direct host↔host pair wins ICE with native (non-re-encoded)
 *                  media — forcing a relay would be strictly worse.
 *   - `'remote'` — anything else (public / CGNAT-4G / internet). Can typically
 *                  only offer a relay candidate → wants a relay↔relay path.
 *
 * Tailscale ranges (source: Tailscale docs, "Tailscale IP addresses" —
 * https://tailscale.com/kb/1015/100.x-addresses): IPv4 is the CGNAT block
 * 100.64.0.0/10; IPv6 is the ULA prefix fd7a:115c:a1e0::/48. Generic ULA
 * (any other fc00::/7 address) stays `'lan'`.
 */
export type ClientClass = 'lan' | 'vpn' | 'remote'

/**
 * Classify a single already-normalised IP literal. Null / unparseable →
 * `'lan'` (the safe default that keeps the low-latency direct path).
 */
export function ipClass(ip: string | null): ClientClass {
  if (!ip) return 'lan'
  if (ip.includes(':')) {
    if (isTailscaleIpv6(ip)) return 'vpn'
    if (isPrivateIpv6(ip)) return 'lan'
    return 'remote'
  }
  if (isIpv4(ip)) {
    if (isTailscaleIpv4(ip)) return 'vpn'
    if (isPrivateIpv4(ip)) return 'lan'
    return 'remote'
  }
  // Not a recognisable IP literal — be conservative, treat as LAN.
  return 'lan'
}

/**
 * Classify a viewer from the resolved request signals.
 *
 * `cfConnectingIp` (Cloudflare Tunnel's real-client header) is honoured ONLY
 * when `peerIsLocal` — i.e. the request physically arrived from the local
 * `cloudflared` connector on loopback/LAN. On that path the socket peer is
 * loopback and cannot itself reveal the viewer, so the header is the only
 * trustworthy signal; classify by ITS value. When the peer is NOT local the
 * header is ignored (a direct internet client could forge it) and we classify
 * by the proxy-resolved `clientIp`.
 */
export function classifyClient(args: {
  clientIp: string | null
  cfConnectingIp: string | null
  peerIsLocal: boolean
}): ClientClass {
  if (args.peerIsLocal && args.cfConnectingIp) return ipClass(args.cfConnectingIp)
  return ipClass(args.clientIp)
}

/**
 * Classify a live tRPC request. Returns `null` for a mesh-originated call
 * (no HTTP request) so the caller leaves the session input untouched rather
 * than forcing a policy. Composes `extractClientIp` (proxy-aware), the
 * `CF-Connecting-IP` header, and the immediate socket peer (CF trust gate).
 */
export function classifyClientRequest(req: ClientRequest | undefined): ClientClass | null {
  if (!req) return null
  const clientIp = extractClientIp(req)
  const cfConnectingIp = extractCfConnectingIp(req)
  const peerIp = extractPeerIp(req)
  const peerIsLocal = peerIp !== null && ipClass(peerIp) !== 'remote'
  return classifyClient({ clientIp, cfConnectingIp, peerIsLocal })
}

/**
 * Derive the broker's `relayOnly` ICE override from the client class:
 *   - `remote` → true  (CGNAT/4G/internet peer only offers a relay candidate;
 *                        a forced relay↔relay path avoids werift nominating a
 *                        dead host/hairpin-srflx pair).
 *   - `vpn`    → false (the Tailscale tunnel already carries native media on a
 *                        direct overlay host pair; forcing TURN would be worse).
 *   - `lan`    → false (low-latency direct host/srflx path).
 */
export function deriveRelayOnly(clientClass: ClientClass): boolean {
  return clientClass === 'remote'
}

/**
 * True when the address is a genuinely-remote (internet) viewer — i.e. NOT
 * lan and NOT vpn. Retained for callers that want the boolean; defined in
 * terms of `ipClass` so the classification stays single-sourced. Tailscale
 * (`'vpn'`) is NOT remote (kept on the direct overlay path). Unparseable /
 * null → false (safe LAN default).
 */
export function isRemoteClientIp(ip: string | null): boolean {
  return ipClass(ip) === 'remote'
}

function isIpv4(ip: string): boolean {
  const parts = ip.split('.')
  if (parts.length !== 4) return false
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false
    const n = Number.parseInt(p, 10)
    return n >= 0 && n <= 255
  })
}

/** 100.64.0.0/10 — Tailscale CGNAT overlay (100.64.0.0 – 100.127.255.255). */
function isTailscaleIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10))
  const [a, b] = parts
  if (a === undefined || b === undefined) return false
  return a === 100 && b >= 64 && b <= 127
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10))
  const [a, b] = parts
  if (a === undefined || b === undefined) return false
  if (a === 10) return true // 10.0.0.0/8
  if (a === 127) return true // 127.0.0.0/8 loopback
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local
  return false
}

/**
 * fd7a:115c:a1e0::/48 — Tailscale IPv6 ULA overlay (source: Tailscale docs).
 * A strict subset of fc00::/7; checked BEFORE the generic-ULA test so a
 * tailnet client on the hub's own v6 address classifies `'vpn'`, not `'lan'`.
 */
function isTailscaleIpv6(ip: string): boolean {
  return ip.toLowerCase().startsWith('fd7a:115c:a1e0:')
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::1') return true // loopback
  if (lower === '::') return true // unspecified
  if (lower.startsWith('fe80')) return true // fe80::/10 link-local
  // fc00::/7 unique-local — covers fc.. and fd..
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true
  return false
}
