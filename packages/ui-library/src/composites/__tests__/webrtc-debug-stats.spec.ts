import { describe, expect, it } from 'vitest'
import {
  deriveWebrtcDebugStats,
  freezeVerdict,
  type WebrtcDebugStats,
} from '../stream-debug/webrtc-debug-stats.js'

/**
 * A minimal stand-in for `RTCStatsReport`: the derivation only ever calls
 * `forEach`, so a Map is a faithful double (that is exactly what the browser
 * hands back).
 */
function reportOf(stats: readonly Record<string, unknown>[]): RTCStatsReport {
  const map = new Map<string, Record<string, unknown>>()
  for (const s of stats) map.set(String(s['id']), s)
  return map as unknown as RTCStatsReport
}

const inbound = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'IT01V',
  type: 'inbound-rtp',
  kind: 'video',
  timestamp: 1_000,
  codecId: 'COD1',
  bytesReceived: 100_000,
  packetsReceived: 1_000,
  packetsLost: 10,
  jitter: 0.012,
  framesPerSecond: 15,
  frameWidth: 1920,
  frameHeight: 1080,
  framesDecoded: 500,
  framesDropped: 3,
  freezeCount: 2,
  totalFreezesDuration: 1.5,
  totalDecodeTime: 2.5,
  nackCount: 7,
  pliCount: 4,
  ...over,
})

const codec = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'COD1',
  type: 'codec',
  mimeType: 'video/H264',
  sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  clockRate: 90_000,
  ...over,
})

const pair = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'CP1',
  type: 'candidate-pair',
  state: 'succeeded',
  nominated: true,
  currentRoundTripTime: 0.024,
  availableOutgoingBitrate: 3_000_000,
  localCandidateId: 'LC1',
  remoteCandidateId: 'RC1',
  ...over,
})

const local = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'LC1',
  type: 'local-candidate',
  candidateType: 'srflx',
  protocol: 'udp',
  ...over,
})

const remote = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'RC1',
  type: 'remote-candidate',
  candidateType: 'host',
  protocol: 'udp',
  ...over,
})

const FULL = [inbound(), codec(), pair(), local(), remote()]

describe('deriveWebrtcDebugStats — cumulative fields', () => {
  it('reads the inbound-video counters and the negotiated codec', () => {
    const s = deriveWebrtcDebugStats({
      report: reportOf(FULL),
      prev: null,
      now: 5_000,
      iceConnectionState: 'connected',
      dtlsState: 'connected',
    })
    expect(s.at).toBe(5_000)
    expect(s.width).toBe(1920)
    expect(s.height).toBe(1080)
    expect(s.fps).toBe(15)
    expect(s.codec).toBe('H264')
    expect(s.codecProfileLevelId).toBe('42e01f')
    expect(s.jitterMs).toBeCloseTo(12)
    expect(s.packetsReceived).toBe(1_000)
    expect(s.packetsLost).toBe(10)
    expect(s.lossPercent).toBeCloseTo((10 / 1010) * 100)
    expect(s.nackCount).toBe(7)
    expect(s.pliCount).toBe(4)
    expect(s.framesDecoded).toBe(500)
    expect(s.framesDropped).toBe(3)
    expect(s.freezeCount).toBe(2)
    expect(s.totalFreezeMs).toBe(1_500)
    expect(s.avgDecodeMs).toBeCloseTo((2.5 / 500) * 1000)
    expect(s.rttMs).toBeCloseTo(24)
    expect(s.candidatePairType).toBe('srflx/host')
    expect(s.localCandidateType).toBe('srflx')
    expect(s.remoteCandidateType).toBe('host')
    expect(s.iceConnectionState).toBe('connected')
    expect(s.dtlsState).toBe('connected')
  })

  it('reports a MISSING measurement as null, never 0 (D393)', () => {
    const bare = {
      id: 'IT01V',
      type: 'inbound-rtp',
      kind: 'video',
      timestamp: 1_000,
    }
    const s = deriveWebrtcDebugStats({
      report: reportOf([bare]),
      prev: null,
      now: 1,
      iceConnectionState: null,
      dtlsState: null,
    })
    expect(s.width).toBeNull()
    expect(s.height).toBeNull()
    expect(s.fps).toBeNull()
    expect(s.codec).toBeNull()
    expect(s.jitterMs).toBeNull()
    expect(s.packetsLost).toBeNull()
    expect(s.lossPercent).toBeNull()
    expect(s.nackCount).toBeNull()
    expect(s.pliCount).toBeNull()
    expect(s.framesDecoded).toBeNull()
    expect(s.freezeCount).toBeNull()
    expect(s.totalFreezeMs).toBeNull()
    expect(s.avgDecodeMs).toBeNull()
    expect(s.rttMs).toBeNull()
    expect(s.candidatePairType).toBeNull()
    expect(s.iceConnectionState).toBeNull()
    expect(s.dtlsState).toBeNull()
  })

  it('distinguishes a measured ZERO from an absent one', () => {
    const s = deriveWebrtcDebugStats({
      report: reportOf([inbound({ freezeCount: 0, pliCount: 0, totalFreezesDuration: 0 })]),
      prev: null,
      now: 1,
      iceConnectionState: null,
      dtlsState: null,
    })
    expect(s.freezeCount).toBe(0)
    expect(s.pliCount).toBe(0)
    expect(s.totalFreezeMs).toBe(0)
  })

  it('has no inbound-video report at all → every inbound field is null', () => {
    const s = deriveWebrtcDebugStats({
      report: reportOf([inbound({ kind: 'audio', id: 'IT01A' })]),
      prev: null,
      now: 1,
      iceConnectionState: null,
      dtlsState: null,
    })
    expect(s.framesDecoded).toBeNull()
    expect(s.hasInboundVideo).toBe(false)
  })

  it('ignores a candidate pair that is not the selected one', () => {
    const s = deriveWebrtcDebugStats({
      report: reportOf([
        inbound(),
        pair({ id: 'CP0', nominated: false, state: 'failed', currentRoundTripTime: 0.9 }),
        pair(),
        local(),
        remote(),
      ]),
      prev: null,
      now: 1,
      iceConnectionState: null,
      dtlsState: null,
    })
    expect(s.rttMs).toBeCloseTo(24)
  })
})

describe('deriveWebrtcDebugStats — window deltas', () => {
  const first = (): WebrtcDebugStats =>
    deriveWebrtcDebugStats({
      report: reportOf(FULL),
      prev: null,
      now: 1_000,
      iceConnectionState: 'connected',
      dtlsState: 'connected',
    })

  it('has no window on the FIRST sample — null, not zero', () => {
    const s = first()
    expect(s.window.kbps).toBeNull()
    expect(s.window.packetsLost).toBeNull()
    expect(s.window.framesDecoded).toBeNull()
    expect(s.window.freezeCount).toBeNull()
    expect(s.window.pliCount).toBeNull()
    expect(s.window.nackCount).toBeNull()
    expect(s.window.spanMs).toBeNull()
  })

  it('derives the window from the previous sample', () => {
    const prev = first()
    const s = deriveWebrtcDebugStats({
      report: reportOf([
        inbound({
          timestamp: 3_000,
          bytesReceived: 175_000,
          packetsReceived: 1_600,
          packetsLost: 16,
          framesDecoded: 530,
          freezeCount: 3,
          totalFreezesDuration: 2.5,
          totalDecodeTime: 2.8,
          nackCount: 9,
          pliCount: 5,
        }),
        codec(),
        pair(),
        local(),
        remote(),
      ]),
      prev,
      now: 3_000,
      iceConnectionState: 'connected',
      dtlsState: 'connected',
    })
    expect(s.window.spanMs).toBe(2_000)
    // (175000-100000) bytes * 8 / 2000 ms = 300 kbps
    expect(s.window.kbps).toBe(300)
    expect(s.window.packetsLost).toBe(6)
    expect(s.window.framesDecoded).toBe(30)
    expect(s.window.freezeCount).toBe(1)
    expect(s.window.freezeMs).toBe(1_000)
    expect(s.window.pliCount).toBe(1)
    expect(s.window.nackCount).toBe(2)
    expect(s.window.lossPercent).toBeCloseTo((6 / 606) * 100)
    expect(s.window.decodeMs).toBeCloseTo((0.3 / 30) * 1000)
  })

  it('refuses a window when the RTP timestamp did not advance', () => {
    const prev = first()
    const s = deriveWebrtcDebugStats({
      report: reportOf(FULL),
      prev,
      now: 2_000,
      iceConnectionState: 'connected',
      dtlsState: 'connected',
    })
    expect(s.window.spanMs).toBeNull()
    expect(s.window.kbps).toBeNull()
  })

  it('a FROZEN picture reports 0 decoded frames over the window, not null', () => {
    const prev = first()
    const s = deriveWebrtcDebugStats({
      report: reportOf([
        inbound({ timestamp: 3_000, bytesReceived: 100_000, framesDecoded: 500 }),
        codec(),
        pair(),
        local(),
        remote(),
      ]),
      prev,
      now: 3_000,
      iceConnectionState: 'connected',
      dtlsState: 'connected',
    })
    expect(s.window.framesDecoded).toBe(0)
    expect(s.window.kbps).toBe(0)
  })
})

describe('deriveWebrtcDebugStats — resolution log', () => {
  it('records the first resolution', () => {
    const s = deriveWebrtcDebugStats({
      report: reportOf(FULL),
      prev: null,
      now: 1_000,
      iceConnectionState: null,
      dtlsState: null,
    })
    expect(s.resolutionLog).toEqual([{ width: 1920, height: 1080, at: 1_000 }])
  })

  it('appends only on a CHANGE, keeping the newest last', () => {
    const a = deriveWebrtcDebugStats({
      report: reportOf(FULL),
      prev: null,
      now: 1_000,
      iceConnectionState: null,
      dtlsState: null,
    })
    const b = deriveWebrtcDebugStats({
      report: reportOf([inbound({ timestamp: 2_000 }), codec(), pair(), local(), remote()]),
      prev: a,
      now: 2_000,
      iceConnectionState: null,
      dtlsState: null,
    })
    expect(b.resolutionLog).toHaveLength(1)
    const c = deriveWebrtcDebugStats({
      report: reportOf([
        inbound({ timestamp: 3_000, frameWidth: 640, frameHeight: 360 }),
        codec(),
        pair(),
        local(),
        remote(),
      ]),
      prev: b,
      now: 3_000,
      iceConnectionState: null,
      dtlsState: null,
    })
    expect(c.resolutionLog).toEqual([
      { width: 1920, height: 1080, at: 1_000 },
      { width: 640, height: 360, at: 3_000 },
    ])
  })

  it('an UNKNOWN resolution never enters the log', () => {
    const a = deriveWebrtcDebugStats({
      report: reportOf(FULL),
      prev: null,
      now: 1_000,
      iceConnectionState: null,
      dtlsState: null,
    })
    const b = deriveWebrtcDebugStats({
      report: reportOf([{ id: 'IT01V', type: 'inbound-rtp', kind: 'video', timestamp: 2_000 }]),
      prev: a,
      now: 2_000,
      iceConnectionState: null,
      dtlsState: null,
    })
    expect(b.resolutionLog).toEqual([{ width: 1920, height: 1080, at: 1_000 }])
  })

  it('caps the log so a long session cannot grow it without bound', () => {
    let s = deriveWebrtcDebugStats({
      report: reportOf(FULL),
      prev: null,
      now: 0,
      iceConnectionState: null,
      dtlsState: null,
    })
    for (let i = 1; i <= 20; i += 1) {
      s = deriveWebrtcDebugStats({
        report: reportOf([
          inbound({ timestamp: 1_000 * i, frameWidth: 100 + i, frameHeight: 100 + i }),
          codec(),
          pair(),
          local(),
          remote(),
        ]),
        prev: s,
        now: 1_000 * i,
        iceConnectionState: null,
        dtlsState: null,
      })
    }
    expect(s.resolutionLog.length).toBeLessThanOrEqual(8)
    expect(s.resolutionLog.at(-1)).toEqual({ width: 120, height: 120, at: 20_000 })
  })
})

describe('freezeVerdict — transport stall vs decoder stall', () => {
  const base = (win: Partial<WebrtcDebugStats['window']>, hasInbound = true): WebrtcDebugStats => {
    const first = deriveWebrtcDebugStats({
      report: reportOf(hasInbound ? FULL : []),
      prev: null,
      now: 0,
      iceConnectionState: 'connected',
      dtlsState: 'connected',
    })
    return { ...first, window: { ...first.window, ...win } }
  }

  it('is UNKNOWN when there is no inbound video report at all', () => {
    expect(freezeVerdict(null).kind).toBe('unknown')
    expect(freezeVerdict(base({}, false)).kind).toBe('unknown')
  })

  it('is UNKNOWN on the first sample — no window yet', () => {
    expect(freezeVerdict(base({ framesDecoded: null, kbps: null })).kind).toBe('unknown')
  })

  it('is DECODING while frames come out', () => {
    expect(freezeVerdict(base({ framesDecoded: 14, kbps: 900 })).kind).toBe('decoding')
  })

  it('names a DECODER stall: bytes are arriving and no frame came out', () => {
    const v = freezeVerdict(base({ framesDecoded: 0, kbps: 900 }))
    expect(v.kind).toBe('decoder-stall')
    expect(v.label).toMatch(/decoder/i)
  })

  it('names a TRANSPORT stall: nothing is arriving', () => {
    const v = freezeVerdict(base({ framesDecoded: 0, kbps: 0 }))
    expect(v.kind).toBe('transport-stall')
    expect(v.label).toMatch(/transport/i)
  })

  it('refuses to guess when frames stopped but the byte rate is unknown', () => {
    expect(freezeVerdict(base({ framesDecoded: 0, kbps: null })).kind).toBe('frozen-unknown')
  })
})
