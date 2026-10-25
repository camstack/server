import { describe, expect, it } from 'vitest'
import type { GatherResult, ProbedCandidate } from '../webrtc-diagnostics/endpoint-probe.js'
import {
  endpointRowFromProbe,
  flattenIceServers,
  natCheckDestinations,
  srflxObservations,
} from '../webrtc-diagnostics/endpoint-test.js'
import { parseIceCandidate } from '../webrtc-diagnostics/ice-candidates.js'

function probed(
  line: string,
  url: string | null,
  relayProtocol: string | null = null,
): ProbedCandidate {
  const candidate = parseIceCandidate(line)
  if (candidate === null) throw new Error(`not a candidate: ${line}`)
  return { candidate, url, relayProtocol, tMs: 10 }
}

const gather = (candidates: readonly ProbedCandidate[]): GatherResult => ({
  candidates,
  durationMs: 120,
  timedOut: false,
  error: null,
})

const [turnTcp] = flattenIceServers([
  { urls: 'turn:turn.example:443?transport=tcp', username: 'u', credential: 'secret' },
])

describe('flattenIceServers', () => {
  it('one row per URL, scheme and transport read from the URL', () => {
    const rows = flattenIceServers([
      {
        urls: ['stun:stun.example:3478', 'turns:turn.example:5349?transport=tcp'],
        credential: 'x',
      },
      { urls: 'stun:stun.example:3478' },
    ])
    expect(rows.map((r) => [r.scheme, r.transport])).toEqual([
      ['stun', null],
      ['turns', 'tcp'],
    ])
  })
})

describe('endpointRowFromProbe', () => {
  it('reports relayProtocol from the loopback stats first, then the candidate', () => {
    if (turnTcp === undefined) throw new Error('fixture')
    const g = gather([
      probed(
        'candidate:1 1 udp 1 198.51.100.20 50000 typ relay raddr 0.0.0.0 rport 0',
        'turn:turn.example:443?transport=tcp',
        'udp',
      ),
    ])
    const row = endpointRowFromProbe(turnTcp, g, {
      connected: true,
      state: 'connected',
      rttMs: 41,
      relayProtocol: 'tcp',
      durationMs: 900,
      error: null,
    })
    expect(row.relay).toBe(true)
    expect(row.relayProtocol).toBe('tcp')
    expect(row.eventUrl).toBe('turn:turn.example:443?transport=tcp')
    expect(row.relayConnected).toBe(true)
    expect(row.rttMs).toBe(41)
  })

  it('a STUN-only answer leaves every relay fact unknown (null), not false/0', () => {
    if (turnTcp === undefined) throw new Error('fixture')
    const g = gather([
      probed(
        'candidate:2 1 udp 1 203.0.113.7 61000 typ srflx raddr 0.0.0.0 rport 0',
        'stun:s:3478',
      ),
    ])
    const row = endpointRowFromProbe(turnTcp, g, null)
    expect(row.srflx).toBe('203.0.113.7:61000')
    expect(row.relay).toBe(false)
    expect(row.relayProtocol).toBeNull()
    expect(row.relayConnected).toBeNull()
    expect(row.rttMs).toBeNull()
    expect(row.eventUrl).toBe('stun:s:3478')
  })

  it('never carries the credential into the row', () => {
    if (turnTcp === undefined) throw new Error('fixture')
    const row = endpointRowFromProbe(turnTcp, gather([]), null)
    expect(JSON.stringify(row)).not.toContain('secret')
  })
})

describe('natCheckDestinations', () => {
  it('uses the configured STUN servers and tops up to two with public fallbacks', () => {
    const one = flattenIceServers([{ urls: 'stun:stun.cloudflare.com:3478' }])
    expect(natCheckDestinations(one)).toEqual([
      'stun:stun.cloudflare.com:3478',
      'stun:stun.l.google.com:19302',
    ])
  })

  it('two configured destinations need no fallback', () => {
    const two = flattenIceServers([
      { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    ])
    expect(natCheckDestinations(two)).toHaveLength(2)
    expect(natCheckDestinations(two).some((d) => d.includes('google'))).toBe(false)
  })
})

describe('srflxObservations', () => {
  it('keeps only srflx candidates with their base and the event url', () => {
    const obs = srflxObservations(
      gather([
        probed('candidate:1 1 udp 1 192.0.2.10 50000 typ host', null),
        probed(
          'candidate:2 1 udp 1 203.0.113.7 61000 typ srflx raddr 192.0.2.10 rport 50000',
          'stun:a:1',
        ),
      ]),
    )
    expect(obs).toEqual([
      {
        address: '203.0.113.7',
        port: 61000,
        protocol: 'udp',
        relatedAddress: '192.0.2.10',
        relatedPort: 50000,
        url: 'stun:a:1',
      },
    ])
  })
})
