/**
 * The adaptive ladder × the D42 recorded pointer.
 *
 * D42 put live, recorded playback and scrub on ONE track whose SOURCE POINTER
 * the server moves. The ladder predates it and is armed purely on the stream
 * id (`startAdaptive`, for any `${deviceId}/adaptive`), so it kept ticking
 * while the pointer was off live — and its only action, a tier switch, is a
 * close-and-recreate re-offer that disposes the `TimelineSession` AND its
 * feeder. The viewer silently lands back on live at the wrong moment, and no
 * code path re-issues the playback pointer.
 *
 * Production, 2026-08-02/03 (Loki): 13 of the 18 sessions that renegotiated in
 * 24h were in recorded playback when they did, `recorded: live RTP GATED`
 * on the line before.
 *
 * This is the only test that exercises the controller and a TimelineSession in
 * the same session.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type {
  IScopedLogger,
  IStreamBroker,
  EncodedPacket,
  BrokerStats,
  Unsubscribe,
} from '@camstack/types'
import { BrokerWebrtcServer } from '../webrtc/broker-webrtc-server.js'
import { ControlMessageSchema } from '../recorded/control-protocol.js'

type LossCb = (s: { packetsLost: number; highestSequence: number }) => void

/**
 * Handles onto the single mocked session, so the test can play the two roles
 * werift and the client normally play: deliver RTCP Receiver Reports, and send
 * a control message on the data channel.
 */
interface SessionHandles {
  rrCb: LossCb | null
  controlCb: ((raw: string) => void) | null
  pendingRenegotiation: { target: unknown; epoch: number } | null
  liveFeedGated: boolean
  /** What every mocked session reports it SENT, kbps (the delivery ratio's denominator). */
  sentKbps: number
}

const handles: SessionHandles = {
  rrCb: null,
  controlCb: null,
  pendingRenegotiation: null,
  liveFeedGated: false,
  sentKbps: 0,
}

vi.mock('../webrtc/session.js', () => {
  class MockAdaptiveSession {
    static readonly ADAPTIVE_LOW_MTU = 900
    static readonly H264_REPACKETIZER_MTU = 1100
    readonly sessionId: string
    readonly deviceId: number
    readonly source: AsyncGenerator<unknown>
    readonly isOpusAudio = false
    onClosed: (() => void) | null = null
    onConnected: (() => void) | null = null
    private _closed = false

    constructor(options: { sessionId: string; deviceId: number; source: AsyncGenerator<unknown> }) {
      this.sessionId = options.sessionId
      this.deviceId = options.deviceId
      this.source = options.source
    }

    get pendingRenegotiation(): { target: unknown; epoch: number } | null {
      return handles.pendingRenegotiation
    }

    set pendingRenegotiation(v: { target: unknown; epoch: number } | null) {
      handles.pendingRenegotiation = v
    }

    readNominatedPair() {
      return null
    }
    /** The adaptive ladder's transport inputs (D635): no REMB, nothing sent. */
    receiverEstimateKbps(_now: number): number | null {
      return null
    }
    private rtpReads = 0
    /** Advances on every read while the fixture says the session sends. */
    get rtpPacketsSentTotal(): number {
      if (handles.sentKbps > 0) this.rtpReads += 1
      return this.rtpReads
    }
    readonly sentVideoHistory = {
      bitsBetween: (from: number, to: number): number => handles.sentKbps * Math.max(0, to - from),
    }
    setForceRelayOnly(_v: boolean) {}
    onReceiverReport(cb: LossCb) {
      handles.rrCb = cb
    }
    onControlMessage(cb: (raw: string) => void) {
      handles.controlCb = cb
    }
    setLiveFeedGate(gated: boolean) {
      handles.liveFeedGated = gated
    }
    pushRecordedAccessUnit() {}
    writeRecordedAudio() {}
    writeRecordedAudioOpus() {}
    requestKeyframe() {}
    sendControl(_raw: string) {}
    setRepacketizerMtu(_mtu: number) {}
    resetRepacketizer() {}
    forwardSourceRtpVideo(_rtp: Buffer) {}
    async createOffer() {
      return { sdp: `v=0\r\no=- ${this.sessionId} 0 IN IP4 127.0.0.1\r\n`, type: 'offer' as const }
    }
    async close() {
      if (this._closed) return
      this._closed = true
      try {
        await this.source.return(undefined)
      } catch {
        /* */
      }
      const hook = this.onClosed
      this.onClosed = null
      hook?.()
    }
  }
  return { AdaptiveSession: MockAdaptiveSession }
})

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function makeMockBroker(): IStreamBroker {
  const stats: BrokerStats = {
    status: 'streaming',
    inputFps: 30,
    encodedSubscribers: 0,
    uptimeMs: 60_000,
    bitrateKbps: 2000,
    idrIntervalMs: 2000,
    codec: 'h264',
    totalBytes: 1_000_000,
    packetCount: 500,
    rtspClients: 0,
    pipeClients: 0,
    preBufferSec: 10,
    preBufferMs: 10_000,
    preBufferPackets: 300,
  }
  const noop: Unsubscribe = () => {}
  return {
    getStats: () => stats,
    getPreBuffer: () => [],
    getRtpPreBuffer: () => [],
    onEncodedData: (_cb: (packet: EncodedPacket) => void): Unsubscribe => noop,
    onVideoRtp: (_cb: (rtpData: Buffer) => void): Unsubscribe => noop,
    updateConsumerAttributionBySession: (): boolean => true,
    getSdpParameterSets: (): ReadonlyArray<Buffer> | null => null,
    onSdpParameterSets: (_cb: (ps: ReadonlyArray<Buffer>) => void): Unsubscribe => noop,
    onSourceRestart: (_cb: (reason: string) => void): Unsubscribe => noop,
    getSourceType: (): string | null => 'rtsp',
    isRtpSource: (): boolean => true,
  } as unknown as IStreamBroker
}

/** Deliver enough RTCP loss for the tracker to read >5% over its window. */
function deliverSustainedLoss(base: number): void {
  handles.rrCb?.({ packetsLost: 0, highestSequence: base })
  handles.rrCb?.({ packetsLost: 200, highestSequence: base + 1000 })
}

describe('adaptive ladder vs the recorded source pointer (D42)', () => {
  let logger: IScopedLogger
  let server: BrokerWebrtcServer

  beforeEach(() => {
    vi.useFakeTimers()
    handles.rrCb = null
    handles.controlCb = null
    handles.pendingRenegotiation = null
    handles.liveFeedGated = false
    handles.sentKbps = 0
    logger = makeLogger()
    server = new BrokerWebrtcServer({
      logger,
      // Presence of BOTH accessors is what wires the TimelineSession.
      locateRecordedSegment: () => Promise.reject(new Error('no footage in this fixture')),
      readRecordedSegmentBytes: () => Promise.reject(new Error('no footage in this fixture')),
    })
    server.setProfileTierResolver((brokerId) => {
      const tail = brokerId.slice(brokerId.lastIndexOf('/') + 1)
      return tail === 'high' || tail === 'mid' || tail === 'low' ? tail : null
    })
    server.registerBroker('5/high', makeMockBroker())
    server.registerBroker('5/mid', makeMockBroker())
    server.registerBroker('5/low', makeMockBroker())
  })

  afterEach(async () => {
    vi.useRealTimers()
    await server.stop()
  })

  it('switches tier on measured loss while the pointer is on LIVE (control)', async () => {
    const { sessionId } = await server.createSession('5/adaptive', { prefersTier: 'high' })
    expect(handles.liveFeedGated).toBe(false)

    deliverSustainedLoss(1000)
    await vi.advanceTimersByTimeAsync(2_500)

    // D733: the move may stay on the session (no re-offer), so the ladder's
    // own record is what proves it moved.
    expect(server.getSessionDebug(sessionId, Date.now()).lastDecision?.tier).toBe('mid')
  })

  it('does NOT switch tier while the pointer is on RECORDED — that would dispose the feeder', async () => {
    const { sessionId } = await server.createSession('5/adaptive', { prefersTier: 'high' })
    expect(handles.controlCb).not.toBeNull()

    // Move the pointer off live. The feeder's seek rejects (no fixture
    // footage) and the broker swallows it; the MODE flip happens first and is
    // what matters here.
    handles.controlCb?.(
      JSON.stringify(
        ControlMessageSchema.parse({
          t: 'playRecorded',
          deviceId: 5,
          epoch: 1_754_000_000_000,
          profile: 'mid',
        }),
      ),
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(handles.liveFeedGated).toBe(true)

    deliverSustainedLoss(1000)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(handles.pendingRenegotiation).toBeNull()
    // Nor in place (D733): the ladder made no decision at all.
    expect(server.getSessionDebug(sessionId, Date.now()).lastDecision).toBeNull()
  })
})

/**
 * I2 (review, D635): the client record is DEVICE-scoped — the last writer
 * wins. With two adaptive sessions of camera 5 here, the high session would
 * read the low viewer's 41 kbps against its own 4 631 kbps sent and demote a
 * healthy picture. The broker must count its sessions per device.
 */
describe('adaptive ladder vs a second viewer of the same camera (I2)', () => {
  let server: BrokerWebrtcServer

  beforeEach(() => {
    vi.useFakeTimers()
    handles.rrCb = null
    handles.controlCb = null
    handles.pendingRenegotiation = null
    handles.liveFeedGated = false
    handles.sentKbps = 4_631
    server = new BrokerWebrtcServer({
      logger: makeLogger(),
      clientNetworkStats: async () => ({
        packetLossPercent: 0,
        estimatedBandwidthKbps: 41,
        lastUpdated: Date.now(),
        rttMs: 4,
      }),
    })
    server.setProfileTierResolver((brokerId) => {
      const tail = brokerId.slice(brokerId.lastIndexOf('/') + 1)
      return tail === 'high' || tail === 'mid' || tail === 'low' ? tail : null
    })
    server.registerBroker('5/high', makeMockBroker())
    server.registerBroker('5/low', makeMockBroker())
  })

  afterEach(async () => {
    vi.useRealTimers()
    await server.stop()
  })

  it('control: ONE session reading 41 of 4 631 kbps sent is a stall, and it demotes', async () => {
    const { sessionId } = await server.createSession('5/adaptive', { prefersTier: 'high' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(server.getSessionDebug(sessionId, Date.now()).lastDecision).not.toBeNull()
  })

  it("TWO sessions of the camera: the shared record is nobody's own — no demotion from it", async () => {
    const high = await server.createSession('5/adaptive', { prefersTier: 'high' })
    await server.createSession('5/adaptive', { prefersTier: 'low' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(handles.pendingRenegotiation).toBeNull()
    expect(server.getSessionDebug(high.sessionId, Date.now()).lastDecision).toBeNull()
  })
})

/** The client record the broker polls, as a mutable fixture. */
interface ClientFixture {
  receivedKbps: number
  downlinkMbps: number | undefined
  /** Throw from the poll this many more times. */
  throwsLeft: number
}

/**
 * Round 4 (review of round 3): what the broker keeps PER DEVICE outlives a
 * session — the try backoff by design, the probe not beyond its welcome.
 */
describe('per-device ladder memory across viewer sessions (D635 round 4)', () => {
  let server: BrokerWebrtcServer
  let logger: IScopedLogger
  const client: ClientFixture = { receivedKbps: 100, downlinkMbps: undefined, throwsLeft: 0 }

  beforeEach(() => {
    vi.useFakeTimers()
    handles.rrCb = null
    handles.controlCb = null
    handles.pendingRenegotiation = null
    handles.liveFeedGated = false
    handles.sentKbps = 100
    client.receivedKbps = 100
    client.downlinkMbps = undefined
    client.throwsLeft = 0
    logger = makeLogger()
    server = new BrokerWebrtcServer({
      logger,
      clientNetworkStats: async () => {
        if (client.throwsLeft > 0) {
          client.throwsLeft -= 1
          throw new Error('telemetry backend exploded')
        }
        return {
          packetLossPercent: 0,
          estimatedBandwidthKbps: client.receivedKbps,
          lastUpdated: Date.now(),
          rttMs: 4,
          ...(client.downlinkMbps !== undefined
            ? { downlinkMbps: client.downlinkMbps, downlinkAgeMs: 0 }
            : {}),
        }
      },
    })
    server.setProfileTierResolver((brokerId) => {
      const tail = brokerId.slice(brokerId.lastIndexOf('/') + 1)
      return tail === 'high' || tail === 'mid' || tail === 'low' ? tail : null
    })
    server.registerBroker('5/high', makeMockBroker())
    server.registerBroker('5/mid', makeMockBroker())
    server.registerBroker('5/low', makeMockBroker())
  })

  afterEach(async () => {
    vi.useRealTimers()
    await server.stop()
  })

  /**
   * Review "backoff seeding": a failed try of one viewer must hold the NEXT
   * viewer of the camera in backoff — the per-device memory is what carries it.
   */
  it("session A's try reverts and A closes; session B of the camera holds try-backoff with time left", async () => {
    const a = await server.createSession('5/adaptive', { prefersTier: 'low' })
    // Clean, fully delivered, no capacity evidence: A tries `mid`.
    await vi.advanceTimersByTimeAsync(12_000)
    expect(server.getSessionDebug(a.sessionId, Date.now()).lastDecision?.tier).toBe('mid')
    // The tried rung lands 60 %: the trial reverts.
    client.receivedKbps = 60
    await vi.advanceTimersByTimeAsync(8_000)
    await server.closeSession(a.sessionId)

    client.receivedKbps = 100
    const b = await server.createSession('5/adaptive', { prefersTier: 'low' })
    await vi.advanceTimersByTimeAsync(8_000)
    const hold = server.getSessionDebug(b.sessionId, Date.now()).climbHold
    expect(hold?.code).toBe('try-backoff')
    expect(hold?.retryInMs ?? 0).toBeGreaterThan(0)
  })

  /**
   * N1: a SHORT probe holds `capacity` until a newer probe replaces it — and a
   * viewer that cannot probe (no token, a share link) never supplies one. The
   * device's probe must not outlive its last adaptive session.
   */
  it("a short probe is forgotten when the device's last adaptive session ends", async () => {
    client.downlinkMbps = 1.2
    const a = await server.createSession('5/adaptive', { prefersTier: 'low' })
    await vi.advanceTimersByTimeAsync(12_000)
    expect(server.getSessionDebug(a.sessionId, Date.now()).climbHold?.code).toBe('capacity')
    await server.closeSession(a.sessionId)

    // B cannot probe (no telemetry probe at all).
    client.downlinkMbps = undefined
    const b = await server.createSession('5/adaptive', { prefersTier: 'low' })
    await vi.advanceTimersByTimeAsync(4_000)
    expect(server.getSessionDebug(b.sessionId, Date.now()).climbHold?.code).not.toBe('capacity')
  })

  it('a tick whose dependency throws is logged, and the ladder keeps ticking', async () => {
    client.throwsLeft = 2
    handles.sentKbps = 4_631
    client.receivedKbps = 41
    const { sessionId } = await server.createSession('5/adaptive', { prefersTier: 'high' })
    await vi.advanceTimersByTimeAsync(24_000)
    // The ticks after the throws still ran: the stall they measured demoted.
    expect(server.getSessionDebug(sessionId, Date.now()).lastDecision).not.toBeNull()
    const warns = vi
      .mocked(logger.warn)
      .mock.calls.filter(([msg]) => msg === 'adaptive: tick failed')
    // Rate-limited: two failures in a row, one line.
    expect(warns).toHaveLength(1)
  })
})
