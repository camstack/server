import type { WebrtcSessionDebug } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type {
  RawCounters,
  StreamDebugSample,
  WebrtcDebugStats,
} from '../stream-debug/webrtc-debug-stats.js'
import {
  emptySessionRun,
  finalizeSessionRun,
  reduceSessionRun,
  type SessionRunEvent,
  type SessionRunState,
} from '../webrtc-diagnostics/session-run.js'
import { classifySessionVerdict, type VerdictInput } from '../webrtc-diagnostics/session-verdict.js'
import { formatMaybe } from '../webrtc-diagnostics/format.js'

const NULL_RAW: RawCounters = {
  timestamp: null,
  bytesReceived: null,
  packetsReceived: null,
  packetsLost: null,
  framesDecoded: null,
  framesDropped: null,
  freezeCount: null,
  totalFreezesDurationS: null,
  totalDecodeTimeS: null,
  nackCount: null,
  pliCount: null,
}

function stats(
  over: Partial<WebrtcDebugStats> = {},
  raw: Partial<RawCounters> = {},
): WebrtcDebugStats {
  return {
    at: 0,
    hasInboundVideo: true,
    width: null,
    height: null,
    fps: null,
    codec: null,
    codecProfileLevelId: null,
    jitterMs: null,
    packetsReceived: null,
    packetsLost: null,
    lossPercent: null,
    nackCount: null,
    pliCount: null,
    framesDecoded: null,
    framesDropped: null,
    freezeCount: null,
    totalFreezeMs: null,
    avgDecodeMs: null,
    rttMs: null,
    availableIncomingKbps: null,
    localCandidateType: null,
    remoteCandidateType: null,
    candidatePairType: null,
    candidateProtocol: null,
    iceConnectionState: null,
    dtlsState: null,
    window: {
      spanMs: null,
      kbps: null,
      packetsReceived: null,
      packetsLost: null,
      lossPercent: null,
      framesDecoded: null,
      framesDropped: null,
      freezeCount: null,
      freezeMs: null,
      nackCount: null,
      pliCount: null,
      decodeMs: null,
    },
    resolutionLog: [],
    raw: { ...NULL_RAW, ...raw },
    ...over,
  }
}

function server(over: Partial<WebrtcSessionDebug> = {}): WebrtcSessionDebug {
  return {
    sessionId: 's1',
    alive: true,
    observedAt: 0,
    brokerId: '7/rtsp:sub',
    camStreamId: 'rtsp:sub',
    sourceKind: 'native',
    adaptive: false,
    servedTier: 'low',
    ingestNodeId: 'hub',
    ingestIsRemote: false,
    sourceCodec: 'h264',
    negotiatedCodec: 'h264',
    egressLeg: 'copy',
    brokerStatus: 'streaming',
    brokerCodec: 'h264',
    brokerBitrateKbps: 512,
    brokerInputFps: 15,
    brokerUptimeMs: 1000,
    rtpPacketsSent: 900,
    trackMode: 'live',
    lastDecision: null,
    tierFailures: [],
    upgradeCount: null,
    ...over,
  }
}

function sample(
  s: WebrtcDebugStats | null,
  srv: WebrtcSessionDebug | null,
  at = 1000,
): StreamDebugSample {
  return {
    at,
    verdict: 'unknown',
    sessionId: 's1',
    stats: s,
    server: srv,
    serverError: null,
    serverWired: true,
  }
}

function run(events: readonly SessionRunEvent[], policy: 'all' | 'relay' = 'all'): SessionRunState {
  return events.reduce(reduceSessionRun, emptySessionRun(policy))
}

const HUB_LAN_ONLY =
  'v=0\r\na=candidate:1 1 udp 2130706431 192.168.1.21 50000 typ host\r\na=candidate:2 1 udp 2130706175 100.101.102.103 50001 typ host\r\n'

const base = (over: Partial<VerdictInput> = {}): VerdictInput => ({
  policy: 'all',
  durationMs: 15_000,
  iceConnected: true,
  iceFinalState: 'connected',
  dtlsConnected: true,
  dtlsFinalState: 'connected',
  hubFlag: 'public-path',
  clientPacketsReceived: 1200,
  framesDecoded: 200,
  serverPacketsSent: 1250,
  pliCount: 0,
  freezeCount: 0,
  lossPercent: 0,
  ...over,
})

describe('classifySessionVerdict', () => {
  it('ICE never connected → transport', () => {
    expect(
      classifySessionVerdict(base({ iceConnected: false, iceFinalState: 'failed' })).layer,
    ).toBe('transport')
  })

  it('relay-only browser + a hub offering only LAN/Tailscale names that cause', () => {
    const v = classifySessionVerdict(
      base({
        policy: 'relay',
        iceConnected: false,
        iceFinalState: 'failed',
        hubFlag: 'private-only',
      }),
    )
    expect(v.layer).toBe('transport')
    expect(v.detail).toMatch(/LAN\/Tailscale/)
  })

  it('ICE up, DTLS never connected → hub-side DTLS', () => {
    expect(
      classifySessionVerdict(base({ dtlsConnected: false, dtlsFinalState: 'connecting' })).layer,
    ).toBe('hub-dtls')
  })

  it('hub sending, client 0 packets → media black-hole', () => {
    expect(classifySessionVerdict(base({ clientPacketsReceived: 0, framesDecoded: 0 })).layer).toBe(
      'media-black-hole',
    )
  })

  it('hub sent nothing and client got nothing → hub not sending', () => {
    expect(
      classifySessionVerdict(
        base({ clientPacketsReceived: 0, framesDecoded: 0, serverPacketsSent: 0 }),
      ).layer,
    ).toBe('hub-not-sending')
  })

  it('client 0 with the hub count UNKNOWN stays unknown — never assumed 0', () => {
    expect(
      classifySessionVerdict(
        base({ clientPacketsReceived: 0, framesDecoded: 0, serverPacketsSent: null }),
      ).layer,
    ).toBe('unknown')
  })

  it('packets but no decoded frame → loss / keyframe size', () => {
    expect(classifySessionVerdict(base({ framesDecoded: 0 })).layer).toBe('loss-keyframe')
  })

  it('frames but a PLI storm → loss / keyframe size', () => {
    expect(classifySessionVerdict(base({ pliCount: 6 })).layer).toBe('loss-keyframe')
  })

  it('frames and freezes → loss / keyframe size', () => {
    expect(classifySessionVerdict(base({ freezeCount: 2 })).layer).toBe('loss-keyframe')
  })

  it('clean run → healthy', () => {
    expect(classifySessionVerdict(base()).layer).toBe('healthy')
  })

  it('client stats missing → unknown, not healthy and not black-hole', () => {
    expect(
      classifySessionVerdict(base({ clientPacketsReceived: null, framesDecoded: null })).layer,
    ).toBe('unknown')
  })
})

describe('session run → report', () => {
  it('an empty run reports every measurement as null (unknown), never 0', () => {
    const r = finalizeSessionRun(emptySessionRun('all'), 15_000)
    expect(r.timeline.iceConnectedMs).toBeNull()
    expect(r.timeline.dtlsConnectedMs).toBeNull()
    expect(r.timeline.firstFrameMs).toBeNull()
    expect(r.media.clientPacketsReceived).toBeNull()
    expect(r.media.clientBytesReceived).toBeNull()
    expect(r.media.framesDecoded).toBeNull()
    expect(r.media.serverPacketsSent).toBeNull()
    expect(r.media.pliCount).toBeNull()
    expect(r.media.nackCount).toBeNull()
    expect(r.media.freezeCount).toBeNull()
    expect(r.path.rttMs).toBeNull()
    expect(r.hub.flag).toBe('unknown')
    expect(r.verdict.layer).toBe('transport')
  })

  it('records the timeline from the first transition into connected', () => {
    const r = finalizeSessionRun(
      run([
        { kind: 'ice-state', at: 300, state: 'checking' },
        { kind: 'ice-state', at: 420, state: 'connected' },
        { kind: 'dtls-state', at: 510, state: 'connected' },
        { kind: 'first-frame', at: 900 },
        { kind: 'ice-state', at: 5000, state: 'disconnected' },
        { kind: 'ice-state', at: 5200, state: 'connected' },
      ]),
      15_000,
    )
    expect(r.timeline.iceConnectedMs).toBe(420)
    expect(r.timeline.dtlsConnectedMs).toBe(510)
    expect(r.timeline.firstFrameMs).toBe(900)
    expect(r.timeline.iceFinalState).toBe('connected')
  })

  it('falls back to the peer connection state when no DTLS transport event arrived', () => {
    const r = finalizeSessionRun(
      run([
        { kind: 'ice-state', at: 100, state: 'connected' },
        { kind: 'peer-state', at: 180, state: 'connected' },
      ]),
      15_000,
    )
    expect(r.timeline.dtlsConnectedMs).toBe(180)
  })

  it('takes media totals from the LAST sample and the server max of rtpPacketsSent', () => {
    const r = finalizeSessionRun(
      run([
        { kind: 'ice-state', at: 100, state: 'connected' },
        { kind: 'dtls-state', at: 150, state: 'connected' },
        {
          kind: 'sample',
          at: 1000,
          sample: sample(
            stats({ packetsReceived: 10, framesDecoded: 1 }),
            server({ rtpPacketsSent: 50 }),
          ),
        },
        {
          kind: 'sample',
          at: 2000,
          sample: sample(
            stats(
              {
                packetsReceived: 400,
                framesDecoded: 30,
                pliCount: 1,
                nackCount: 3,
                freezeCount: 0,
                candidatePairType: 'srflx/host',
                candidateProtocol: 'udp',
                rttMs: 23,
              },
              { bytesReceived: 512_000 },
            ),
            server({ rtpPacketsSent: 420 }),
          ),
        },
        // A later poll that FAILED (null server) must not erase the measured count.
        { kind: 'sample', at: 3000, sample: sample(null, null) },
      ]),
      15_000,
    )
    expect(r.media.clientPacketsReceived).toBe(400)
    expect(r.media.clientBytesReceived).toBe(512_000)
    expect(r.media.framesDecoded).toBe(30)
    expect(r.media.serverPacketsSent).toBe(420)
    expect(r.path.pairType).toBe('srflx/host')
    expect(r.path.rttMs).toBe(23)
    expect(r.verdict.layer).toBe('healthy')
  })

  it('parses the hub candidates from the answer SDP plus the trickle', () => {
    const r = finalizeSessionRun(
      run([
        { kind: 'offer-answered', at: 50, sessionId: 's1', sdpAnswer: HUB_LAN_ONLY },
        {
          kind: 'hub-candidates',
          at: 260,
          candidates: ['candidate:3 1 udp 2130705919 fd7a:115c:a1e0::1 50002 typ host'],
          done: true,
        },
      ]),
      15_000,
    )
    expect(r.sessionIds).toEqual(['s1'])
    expect(r.hub.flag).toBe('private-only')
    expect(r.hub.candidates).toHaveLength(3)
  })

  it('counts the local candidate types and keeps the relay protocol', () => {
    const r = finalizeSessionRun(
      run([
        {
          kind: 'local-candidate',
          at: 10,
          candidate: 'candidate:1 1 udp 1 198.51.100.20 3478 typ relay raddr 0.0.0.0 rport 0',
          url: 'turn:turn.example:443?transport=tcp',
          relayProtocol: 'tcp',
        },
      ]),
      15_000,
    )
    expect(r.local.countByType.relay).toBe(1)
    expect(r.local.relayProtocols).toEqual(['tcp'])
  })
})

describe('formatMaybe', () => {
  it('renders null as "unknown" and 0 as 0', () => {
    expect(formatMaybe(null, (n) => `${String(n)} ms`)).toBe('unknown')
    expect(formatMaybe(0, (n) => `${String(n)} ms`)).toBe('0 ms')
  })
})
