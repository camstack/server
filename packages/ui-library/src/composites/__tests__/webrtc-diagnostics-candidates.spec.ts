import { describe, expect, it } from 'vitest'
import {
  candidateLinesFromSdp,
  classifyAddressScope,
  parseIceCandidate,
  summarizeHubCandidates,
} from '../webrtc-diagnostics/ice-candidates.js'

const HOST_LAN = 'candidate:1 1 udp 2130706431 192.168.1.21 50000 typ host'
const HOST_TS = 'candidate:2 1 udp 2130706175 100.101.102.103 50001 typ host'
const HOST_TS6 = 'candidate:3 1 udp 2130705919 fd7a:115c:a1e0::1 50002 typ host'
const SRFLX =
  'candidate:4 1 udp 1694498815 203.0.113.7 61000 typ srflx raddr 192.0.2.10 rport 50000'
const RELAY =
  'a=candidate:5 1 udp 16777215 198.51.100.20 3478 typ relay raddr 203.0.113.7 rport 61000'

const answerSdp = (lines: readonly string[]): string =>
  [
    'v=0',
    'o=- 1 1 IN IP4 0.0.0.0',
    's=-',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    ...lines.map((l) => (l.startsWith('a=') ? l : `a=${l}`)),
    'a=end-of-candidates',
    '',
  ].join('\r\n')

describe('parseIceCandidate', () => {
  it('reads type, protocol, address, port and the related base', () => {
    const c = parseIceCandidate(SRFLX)
    expect(c).not.toBeNull()
    expect(c?.type).toBe('srflx')
    expect(c?.protocol).toBe('udp')
    expect(c?.address).toBe('203.0.113.7')
    expect(c?.port).toBe(61000)
    expect(c?.relatedAddress).toBe('192.0.2.10')
    expect(c?.relatedPort).toBe(50000)
    expect(c?.family).toBe('ipv4')
    expect(c?.scope).toBe('public')
  })

  it('accepts the `a=` prefixed SDP form', () => {
    expect(parseIceCandidate(RELAY)?.type).toBe('relay')
  })

  it('is null for a line that is not a candidate, never a zero-filled candidate', () => {
    expect(parseIceCandidate('a=end-of-candidates')).toBeNull()
    expect(parseIceCandidate('')).toBeNull()
  })

  it('keeps an unreadable port null, not 0', () => {
    const c = parseIceCandidate('candidate:9 1 udp 1 192.0.2.10 notaport typ host')
    expect(c?.port).toBeNull()
  })
})

describe('classifyAddressScope', () => {
  it.each([
    ['10.0.0.5', 'lan'],
    ['172.20.1.1', 'lan'],
    ['192.168.1.21', 'lan'],
    ['100.64.0.1', 'tailscale'],
    ['100.127.255.254', 'tailscale'],
    ['fd7a:115c:a1e0::1', 'tailscale'],
    ['fd12:3456::1', 'lan'],
    ['127.0.0.1', 'loopback'],
    ['::1', 'loopback'],
    ['169.254.3.4', 'link-local'],
    ['fe80::1', 'link-local'],
    ['0b5c1f2e-1d2a-4f00-9a3b-0c2d4e5f6a7b.local', 'mdns'],
    ['203.0.113.7', 'public'],
    ['2001:db8::7', 'public'],
    ['172.32.0.1', 'public'],
    ['', 'unknown'],
  ])('%s → %s', (address, scope) => {
    expect(classifyAddressScope(address)).toBe(scope)
  })
})

describe('candidateLinesFromSdp', () => {
  it('extracts every a=candidate line and nothing else', () => {
    const lines = candidateLinesFromSdp(answerSdp([HOST_LAN, SRFLX]))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('192.168.1.21 50000 typ host')
  })
})

describe('summarizeHubCandidates', () => {
  it('flags a hub that offers only LAN/Tailscale host candidates', () => {
    const s = summarizeHubCandidates({
      sdpAnswer: answerSdp([HOST_LAN, HOST_TS]),
      trickled: [HOST_TS6],
      trickleDone: true,
    })
    expect(s.flag).toBe('private-only')
    expect(s.hasSrflx).toBe(false)
    expect(s.hasRelay).toBe(false)
    expect(s.countByType.host).toBe(3)
    expect(s.fromSdp).toBe(2)
    expect(s.fromTrickle).toBe(1)
  })

  it('a srflx from the trickle gives the hub a public path', () => {
    const s = summarizeHubCandidates({
      sdpAnswer: answerSdp([HOST_LAN]),
      trickled: [SRFLX],
      trickleDone: true,
    })
    expect(s.flag).toBe('public-path')
    expect(s.hasSrflx).toBe(true)
  })

  it('a relay alone is a public path', () => {
    const s = summarizeHubCandidates({
      sdpAnswer: answerSdp([RELAY]),
      trickled: [],
      trickleDone: null,
    })
    expect(s.flag).toBe('public-path')
    expect(s.hasRelay).toBe(true)
  })

  it('dedupes a candidate seen in both the SDP and the trickle', () => {
    const s = summarizeHubCandidates({
      sdpAnswer: answerSdp([HOST_LAN]),
      trickled: [HOST_LAN],
      trickleDone: true,
    })
    expect(s.candidates).toHaveLength(1)
  })

  it('no answer at all is unknown, not "no candidates"', () => {
    const s = summarizeHubCandidates({ sdpAnswer: null, trickled: [], trickleDone: null })
    expect(s.flag).toBe('unknown')
  })

  it('an answer with zero candidates is "none"', () => {
    const s = summarizeHubCandidates({ sdpAnswer: answerSdp([]), trickled: [], trickleDone: true })
    expect(s.flag).toBe('none')
  })
})
