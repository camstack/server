/**
 * Unit tests for the SDP-parsing helpers that back the "Advanced WebRTC
 * debug logging" toggle. These power the CRITICAL debug line that SHOWS
 * exactly which LOCAL ICE candidates we put in the answer — type
 * (host/srflx/relay) + address — so an operator can spot an unreachable
 * Tailscale/private host candidate on the Alexa path. They also surface the
 * offered-vs-negotiated codec profile lines.
 *
 * Pure functions only — no werift load — so they run fast and isolated.
 */
import { describe, it, expect } from 'vitest'
import {
  parseCandidateLine,
  summarizeCandidates,
  extractFmtpLines,
  hostFromCandidateAddress,
  remoteAddressFamily,
  derivePairClass,
} from '../webrtc/session.js'

describe('parseCandidateLine', () => {
  it('parses a host candidate (type + address + protocol)', () => {
    const line = 'a=candidate:1 1 udp 2130706431 192.168.10.50 54321 typ host generation 0'
    expect(parseCandidateLine(line)).toEqual({
      type: 'host',
      address: '192.168.10.50:54321',
      protocol: 'udp',
    })
  })

  it('parses a Tailscale CGNAT host candidate (the suspected unreachable one)', () => {
    const line = 'candidate:2 1 udp 2130706430 100.101.102.103 9999 typ host'
    expect(parseCandidateLine(line)).toEqual({
      type: 'host',
      address: '100.101.102.103:9999',
      protocol: 'udp',
    })
  })

  it('parses a relay candidate', () => {
    const line = 'a=candidate:3 1 udp 41885439 203.0.113.7 50000 typ relay raddr 0.0.0.0 rport 0'
    const r = parseCandidateLine(line)
    expect(r.type).toBe('relay')
    expect(r.address).toBe('203.0.113.7:50000')
  })

  it('parses a srflx candidate', () => {
    const line =
      'a=candidate:4 1 udp 1694498815 198.51.100.9 40000 typ srflx raddr 192.168.10.50 rport 54321'
    const r = parseCandidateLine(line)
    expect(r.type).toBe('srflx')
    expect(r.address).toBe('198.51.100.9:40000')
  })

  it('never throws on a malformed line — returns unknown fields', () => {
    const r = parseCandidateLine('a=candidate:garbage')
    expect(r.type).toBe('unknown')
    expect(r.address).toBe('unknown')
  })
})

describe('summarizeCandidates', () => {
  it('summarises every a=candidate line in an SDP, ignoring other lines', () => {
    const sdp = [
      'v=0',
      'a=candidate:1 1 udp 2130706431 192.168.10.50 54321 typ host',
      'a=rtpmap:96 H264/90000',
      'a=candidate:2 1 udp 41885439 203.0.113.7 50000 typ relay',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
    ].join('\r\n')
    const summary = summarizeCandidates(sdp)
    expect(summary).toHaveLength(2)
    expect(summary.map((c) => c.type)).toEqual(['host', 'relay'])
    expect(summary[1]!.address).toBe('203.0.113.7:50000')
  })

  it('returns an empty array when the SDP carries no candidates', () => {
    expect(summarizeCandidates('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96')).toEqual([])
  })
})

describe('extractFmtpLines', () => {
  it('extracts rtpmap + fmtp lines (carrying profile-level-id)', () => {
    const sdp = [
      'a=rtpmap:96 H264/90000',
      'a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
      'a=rtpmap:97 H265/90000',
      'a=candidate:1 1 udp 2130706431 192.168.10.50 54321 typ host',
    ].join('\n')
    const lines = extractFmtpLines(sdp)
    expect(lines).toHaveLength(3)
    expect(lines.some((l) => l.includes('profile-level-id=42e01f'))).toBe(true)
    expect(lines.some((l) => l.startsWith('a=candidate:'))).toBe(false)
  })
})

describe('hostFromCandidateAddress', () => {
  it('strips the port from an IPv4 host:port', () => {
    expect(hostFromCandidateAddress('192.168.10.50:54321')).toBe('192.168.10.50')
  })
  it('strips only the trailing port from an IPv6 host:port', () => {
    expect(hostFromCandidateAddress('fd7a:115c:a1e0::1:54321')).toBe('fd7a:115c:a1e0::1')
  })
  it('returns the input unchanged when there is no port', () => {
    expect(hostFromCandidateAddress('192.168.10.50')).toBe('192.168.10.50')
  })
})

describe('remoteAddressFamily', () => {
  it('classifies an IPv4 host', () => {
    expect(remoteAddressFamily('203.0.113.7')).toBe('ipv4')
  })
  it('classifies an IPv6 host', () => {
    expect(remoteAddressFamily('fd7a:115c:a1e0::1')).toBe('ipv6')
  })
  it('unknown for a non-literal', () => {
    expect(remoteAddressFamily('example.com')).toBe('unknown')
  })
})

describe('derivePairClass', () => {
  it('relay type → relay (whatever the address)', () => {
    expect(derivePairClass('relay', '203.0.113.7:50000')).toBe('relay')
    expect(derivePairClass('relay', '192.168.10.5:50000')).toBe('relay')
  })
  it('Tailscale CGNAT v4 remote host → cgnat-vpn', () => {
    expect(derivePairClass('host', '100.101.102.103:9999')).toBe('cgnat-vpn')
  })
  it('Tailscale v6 ULA remote host → cgnat-vpn', () => {
    expect(derivePairClass('host', 'fd7a:115c:a1e0::1:9999')).toBe('cgnat-vpn')
  })
  it('private LAN remote host → lan-direct', () => {
    // Built from octets: the publish-safe scrub rewrites every dotted LAN
    // literal in the tree to `192.168.x.x`, which is not an address at all and
    // turned this case into a `public` expectation failure. These are generic
    // RFC1918 hosts, not anyone's network.
    const lan = (a: number, b: number, c: number, d: number): string => `${a}.${b}.${c}.${d}`
    expect(derivePairClass('host', `${lan(192, 168, 1, 20)}:54321`)).toBe('lan-direct')
    expect(derivePairClass('host', `${lan(10, 0, 0, 5)}:40000`)).toBe('lan-direct')
    expect(derivePairClass('host', `${lan(172, 16, 0, 1)}:40000`)).toBe('lan-direct')
  })
  it('generic ULA (non-Tailscale fd..) → lan-direct', () => {
    expect(derivePairClass('host', 'fd12:3456::1:40000')).toBe('lan-direct')
  })
  it('public srflx remote host → public', () => {
    expect(derivePairClass('srflx', '198.51.100.9:40000')).toBe('public')
  })
  it('just-below the Tailscale block (100.63) → public', () => {
    expect(derivePairClass('host', '100.63.255.255:40000')).toBe('public')
  })
})
