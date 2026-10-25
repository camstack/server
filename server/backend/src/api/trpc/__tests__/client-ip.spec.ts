/**
 * Unit tests for the client-IP extraction + LAN/remote classification
 * used by the `webrtcSession.createSession` relay-only override.
 *
 * The classification is the load-bearing decision: a `true` from
 * `isRemoteClientIp` forces TURN-relay-only ICE for that live-view
 * session. A false positive would needlessly relay a LAN viewer
 * (latency); a false negative would leave a remote viewer on the dead
 * direct path (the bug being fixed). The private-range edges are
 * therefore exercised explicitly.
 */
import { describe, it, expect } from 'vitest'
import type { IncomingMessage } from 'node:http'
import {
  extractClientIp,
  extractUserAgent,
  extractCfConnectingIp,
  isRemoteClientIp,
  ipClass,
  classifyClient,
  classifyClientRequest,
  deriveRelayOnly,
} from '../client-ip.js'

function reqWith(opts: {
  xff?: string | string[]
  ip?: string
  remoteAddress?: string
  userAgent?: string | string[]
  cfConnectingIp?: string | string[]
}): IncomingMessage {
  const headers: Record<string, string | string[]> = {}
  if (opts.xff !== undefined) headers['x-forwarded-for'] = opts.xff
  if (opts.userAgent !== undefined) headers['user-agent'] = opts.userAgent
  if (opts.cfConnectingIp !== undefined) headers['cf-connecting-ip'] = opts.cfConnectingIp
  const req = {
    headers,
    socket: { remoteAddress: opts.remoteAddress },
  } as unknown as IncomingMessage
  if (opts.ip !== undefined) {
    Object.defineProperty(req, 'ip', { value: opts.ip, enumerable: true })
  }
  return req
}

describe('extractClientIp', () => {
  it('returns null for an absent request (mesh-originated call)', () => {
    expect(extractClientIp(undefined)).toBeNull()
  })

  it('prefers the first X-Forwarded-For hop over socket/ip', () => {
    const req = reqWith({ xff: '203.0.113.7, 10.0.0.1', ip: '10.0.0.1', remoteAddress: '10.0.0.1' })
    expect(extractClientIp(req)).toBe('203.0.113.7')
  })

  it('handles X-Forwarded-For as an array', () => {
    const req = reqWith({ xff: ['198.51.100.4, 10.0.0.1'] })
    expect(extractClientIp(req)).toBe('198.51.100.4')
  })

  it('falls back to req.ip when no XFF', () => {
    const req = reqWith({ ip: '192.168.10.50', remoteAddress: '192.168.10.50' })
    expect(extractClientIp(req)).toBe('192.168.10.50')
  })

  it('falls back to socket.remoteAddress when no XFF or ip', () => {
    const req = reqWith({ remoteAddress: '127.0.0.1' })
    expect(extractClientIp(req)).toBe('127.0.0.1')
  })

  it('strips IPv4-mapped IPv6 prefix', () => {
    const req = reqWith({ remoteAddress: '::ffff:192.168.10.5' })
    expect(extractClientIp(req)).toBe('192.168.10.5')
  })

  it('strips IPv6 zone id', () => {
    const req = reqWith({ remoteAddress: 'fe80::1%en0' })
    expect(extractClientIp(req)).toBe('fe80::1')
  })
})

describe('extractUserAgent', () => {
  it('returns null for an absent request (mesh-originated call)', () => {
    expect(extractUserAgent(undefined)).toBeNull()
  })

  it('returns null when the header is missing', () => {
    expect(extractUserAgent(reqWith({}))).toBeNull()
  })

  it('reads the user-agent header', () => {
    const req = reqWith({ userAgent: 'Mozilla/5.0 (Macintosh) Chrome/120' })
    expect(extractUserAgent(req)).toBe('Mozilla/5.0 (Macintosh) Chrome/120')
  })

  it('reads the first entry when the header is an array', () => {
    const req = reqWith({ userAgent: ['Mozilla/5.0 (X11) Firefox/121', 'ignored'] })
    expect(extractUserAgent(req)).toBe('Mozilla/5.0 (X11) Firefox/121')
  })

  it('returns null for an empty header value', () => {
    expect(extractUserAgent(reqWith({ userAgent: '' }))).toBeNull()
  })
})

describe('isRemoteClientIp', () => {
  it('null → false (treated as LAN — safe default)', () => {
    expect(isRemoteClientIp(null)).toBe(false)
  })

  // Private / loopback / link-local / Tailscale ranges → LAN (direct path kept)
  const lan = [
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.10.1',
    '127.0.0.1',
    '169.254.1.1',
    // Tailscale CGNAT overlay (100.64.0.0/10) — direct host↔host over the mesh
    '100.64.0.1', // bottom of 100.64/10
    '100.104.179.3', // the hub's own Tailscale IP (confirmed live)
    '100.127.255.255', // top of 100.64/10
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    // Tailscale ULA overlay (fd7a::/16) — subset of fc00::/7
    'fd7a:115c:a1e0::1',
  ]
  for (const ip of lan) {
    it(`LAN: ${ip} → not remote`, () => {
      expect(isRemoteClientIp(ip)).toBe(false)
    })
  }

  // Public ranges → remote (relay-only forced)
  const remote = [
    '203.0.113.7', // TEST-NET-3 (public)
    '8.8.8.8',
    '172.15.0.1', // just below the 172.16/12 private block
    '172.32.0.1', // just above the 172.16/12 private block
    '11.0.0.1', // just above 10/8
    '100.63.255.255', // just below the 100.64/10 Tailscale block (public)
    '100.128.0.1', // just above the 100.64/10 Tailscale block (public)
    '2001:4860:4860::8888', // public IPv6
  ]
  for (const ip of remote) {
    it(`remote: ${ip} → remote`, () => {
      expect(isRemoteClientIp(ip)).toBe(true)
    })
  }

  it('unparseable literal → false (conservative LAN default)', () => {
    expect(isRemoteClientIp('not-an-ip')).toBe(false)
  })
})

describe('extractCfConnectingIp', () => {
  it('returns null for an absent request', () => {
    expect(extractCfConnectingIp(undefined)).toBeNull()
  })

  it('returns null when the header is missing', () => {
    expect(extractCfConnectingIp(reqWith({}))).toBeNull()
  })

  it('reads the CF-Connecting-IP header (normalised)', () => {
    expect(extractCfConnectingIp(reqWith({ cfConnectingIp: '::ffff:203.0.113.9' }))).toBe(
      '203.0.113.9',
    )
  })

  it('reads the first entry when the header is an array', () => {
    expect(extractCfConnectingIp(reqWith({ cfConnectingIp: ['198.51.100.7', 'ignored'] }))).toBe(
      '198.51.100.7',
    )
  })
})

describe('ipClass', () => {
  it('null → lan (safe default)', () => {
    expect(ipClass(null)).toBe('lan')
  })

  it('unparseable → lan (conservative default)', () => {
    expect(ipClass('not-an-ip')).toBe('lan')
  })

  const lan: readonly string[] = [
    '10.0.0.1',
    '172.16.0.1',
    '192.168.10.1',
    '127.0.0.1',
    '169.254.1.1',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
  ]
  for (const ip of lan) {
    it(`lan: ${ip}`, () => expect(ipClass(ip)).toBe('lan'))
  }

  // Tailscale overlay — a client hitting the hub's OWN tailscale address.
  const vpn: readonly string[] = [
    '100.64.0.1', // bottom of 100.64/10 CGNAT
    '100.104.179.3', // the hub's own Tailscale IP (confirmed live)
    '100.127.255.255', // top of 100.64/10 CGNAT
    'fd7a:115c:a1e0::1', // Tailscale v6 ULA (fd7a:115c:a1e0::/48)
    'fd7a:115c:a1e0:ab12:4843:cd96:0:1', // full-length Tailscale v6
  ]
  for (const ip of vpn) {
    it(`vpn: ${ip}`, () => expect(ipClass(ip)).toBe('vpn'))
  }

  const remote: readonly string[] = [
    '203.0.113.7',
    '8.8.8.8',
    '172.15.0.1',
    '172.32.0.1',
    '11.0.0.1',
    '100.63.255.255', // just below 100.64/10
    '100.128.0.1', // just above 100.64/10
    '2001:4860:4860::8888',
  ]
  for (const ip of remote) {
    it(`remote: ${ip}`, () => expect(ipClass(ip)).toBe('remote'))
  }

  // fd7a but NOT the a1e0 subnet is generic ULA (lan), not Tailscale.
  it('fd7a::/16 outside a1e0 subnet → lan (generic ULA, not Tailscale)', () => {
    expect(ipClass('fd7a:115c:9999::1')).toBe('lan')
  })
})

describe('classifyClient', () => {
  it('plain LAN peer, no CF header → lan', () => {
    expect(
      classifyClient({ clientIp: '192.168.10.5', cfConnectingIp: null, peerIsLocal: true }),
    ).toBe('lan')
  })

  it('plain public client, no CF header → remote', () => {
    expect(classifyClient({ clientIp: '8.8.8.8', cfConnectingIp: null, peerIsLocal: false })).toBe(
      'remote',
    )
  })

  it('tailscale client → vpn', () => {
    expect(
      classifyClient({ clientIp: '100.104.179.3', cfConnectingIp: null, peerIsLocal: false }),
    ).toBe('vpn')
  })

  it('CF tunnel: loopback peer + CF-Connecting-IP public → remote (header trusted)', () => {
    expect(
      classifyClient({ clientIp: '127.0.0.1', cfConnectingIp: '203.0.113.9', peerIsLocal: true }),
    ).toBe('remote')
  })

  it('CF header IGNORED when the immediate peer is NOT local (anti-spoof)', () => {
    // A direct internet client forging CF-Connecting-IP=LAN must NOT be
    // downgraded to lan — the peer is remote, so classify by the peer.
    expect(
      classifyClient({ clientIp: '8.8.8.8', cfConnectingIp: '192.168.10.1', peerIsLocal: false }),
    ).toBe('remote')
  })

  it('CF header trusted only on local path even when its value is LAN', () => {
    // cloudflared on loopback forwarding a genuinely-LAN client (rare) →
    // honour the header → lan.
    expect(
      classifyClient({ clientIp: '127.0.0.1', cfConnectingIp: '192.168.10.4', peerIsLocal: true }),
    ).toBe('lan')
  })
})

describe('classifyClientRequest', () => {
  it('undefined request → null (mesh-originated, leave input untouched)', () => {
    expect(classifyClientRequest(undefined)).toBeNull()
  })

  it('LAN socket peer → lan', () => {
    expect(classifyClientRequest(reqWith({ remoteAddress: '192.168.10.9' }))).toBe('lan')
  })

  it('public XFF hop → remote', () => {
    expect(
      classifyClientRequest(reqWith({ xff: '203.0.113.7, 10.0.0.1', remoteAddress: '10.0.0.1' })),
    ).toBe('remote')
  })

  it('tailscale req.ip → vpn', () => {
    expect(
      classifyClientRequest(reqWith({ ip: '100.104.179.3', remoteAddress: '100.104.179.3' })),
    ).toBe('vpn')
  })

  it('cloudflare tunnel (loopback peer + CF-Connecting-IP) → remote', () => {
    const req = reqWith({ remoteAddress: '127.0.0.1', cfConnectingIp: '203.0.113.9' })
    expect(classifyClientRequest(req)).toBe('remote')
  })
})

describe('deriveRelayOnly', () => {
  it('remote → true (CGNAT/4G/internet viewer needs a relay↔relay path)', () => {
    expect(deriveRelayOnly('remote')).toBe(true)
  })
  it('vpn → false (tunnel carries native media; forcing TURN would be worse)', () => {
    expect(deriveRelayOnly('vpn')).toBe(false)
  })
  it('lan → false (low-latency direct host/srflx path)', () => {
    expect(deriveRelayOnly('lan')).toBe(false)
  })
})
