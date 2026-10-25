/**
 * D733 — ONE WebRTC session per live open.
 *
 * Measured on the hub (Loki, 48 h to 2026-10-07): 31 of 38 adaptive cold
 * starts were followed, 0.3–8 s later, by a SECOND session — the player's
 * probe-climb reconnect — and every ladder move was a third (a
 * close-and-recreate re-offer). Here the probe is handed to the session the
 * viewer already has and the rung changes on that session, the track moving
 * from one broker to the other on a keyframe.
 *
 * The session is mocked (no werift); the brokers are real enough to deliver
 * RTP and hold a pre-buffer, which is what the switch commits on.
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

/** What the mocked session saw. */
interface SessionLog {
  forwarded: string[]
  switches: { bootstrap: string[]; reason: string }[]
  pendingRenegotiation: { target: unknown; epoch: number } | null
  liveFeedGated: boolean
  controlCb: ((raw: string) => void) | null
  rrCb: ((s: { packetsLost: number; highestSequence: number }) => void) | null
}

const seen: SessionLog = {
  forwarded: [],
  switches: [],
  pendingRenegotiation: null,
  liveFeedGated: false,
  controlCb: null,
  rrCb: null,
}

vi.mock('../webrtc/session.js', () => {
  class MockAdaptiveSession {
    static readonly ADAPTIVE_LOW_MTU = 900
    static readonly H264_REPACKETIZER_MTU = 1100
    readonly sessionId: string
    readonly source: AsyncGenerator<unknown>
    readonly isOpusAudio = false
    readonly needsTranscode = false
    onClosed: (() => void) | null = null
    onConnected: (() => void) | null = null
    private bootstrap: (() => readonly Buffer[]) | undefined
    private bootstrapDone = false

    constructor(options: {
      sessionId: string
      source: AsyncGenerator<unknown>
      rtpBootstrap?: () => readonly Buffer[]
    }) {
      this.sessionId = options.sessionId
      this.source = options.source
      this.bootstrap = options.rtpBootstrap
    }
    get pendingRenegotiation(): { target: unknown; epoch: number } | null {
      return seen.pendingRenegotiation
    }
    set pendingRenegotiation(v: { target: unknown; epoch: number } | null) {
      seen.pendingRenegotiation = v
    }
    get isLiveFeedGated(): boolean {
      return seen.liveFeedGated
    }
    /** Mirrors the real session: the first forward after (re)binding replays the bootstrap. */
    forwardSourceRtpVideo(rtp: Buffer): void {
      if (!this.bootstrapDone) {
        this.bootstrapDone = true
        const replay = this.bootstrap?.() ?? []
        if (replay.length > 0) {
          for (const p of replay) seen.forwarded.push(p.toString())
          return
        }
      }
      seen.forwarded.push(rtp.toString())
    }
    switchLiveSource(next: {
      rtpBootstrap: () => readonly Buffer[]
      parameterSets: ReadonlyArray<Buffer> | null
      reason: string
    }): void {
      this.bootstrap = next.rtpBootstrap
      this.bootstrapDone = false
      seen.switches.push({
        bootstrap: next.rtpBootstrap().map((b) => b.toString()),
        reason: next.reason,
      })
    }
    seedH264CodecInfoFromSdp(): void {}
    seedH265CodecInfoFromSdp(): void {}
    onSourceRestarted(): void {}
    readNominatedPair() {
      return null
    }
    receiverEstimateKbps(): number | null {
      return null
    }
    readonly rtpPacketsSentTotal = 0
    readonly sentVideoHistory = { bitsBetween: (): number => 0 }
    setForceRelayOnly(): void {}
    onReceiverReport(cb: (s: { packetsLost: number; highestSequence: number }) => void): void {
      seen.rrCb = cb
    }
    onControlMessage(cb: (raw: string) => void): void {
      seen.controlCb = cb
    }
    setLiveFeedGate(gated: boolean): void {
      seen.liveFeedGated = gated
    }
    sendControl(): void {}
    setRepacketizerMtu(): void {}
    async createOffer() {
      return { sdp: 'v=0\r\n', type: 'offer' as const }
    }
    async close() {
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

/** A rendition: delivers named RTP packets, keeps its GOP from the last keyframe. */
class Rendition {
  readonly preBuffer: Buffer[] = []
  readonly rtpCbs = new Set<(rtp: Buffer) => void>()
  readonly encodedCbs = new Set<(p: EncodedPacket) => void>()
  constructor(
    readonly name: string,
    private readonly codec: 'h264' | 'h265',
  ) {}
  emit(label: string, keyframe = false): void {
    const rtp = Buffer.from(`${this.name}:${label}`)
    if (keyframe) this.preBuffer.length = 0
    if (keyframe || this.preBuffer.length > 0) this.preBuffer.push(rtp)
    for (const cb of [...this.rtpCbs]) cb(rtp)
  }
  broker(): IStreamBroker {
    const stats: BrokerStats = {
      status: 'streaming',
      inputFps: 25,
      encodedSubscribers: 0,
      uptimeMs: 60_000,
      bitrateKbps: 2000,
      idrIntervalMs: 4000,
      codec: this.codec,
      totalBytes: 1_000_000,
      packetCount: 500,
      rtspClients: 0,
      pipeClients: 0,
      preBufferSec: 10,
      preBufferMs: 10_000,
      preBufferPackets: 300,
    }
    const noop: Unsubscribe = () => {}
    const self = this
    const partial: Partial<IStreamBroker> = {
      getStats: () => stats,
      getPreBuffer: () => [],
      getRtpPreBuffer: () => self.preBuffer,
      onEncodedData: (cb: (packet: EncodedPacket) => void): Unsubscribe => {
        self.encodedCbs.add(cb)
        return () => self.encodedCbs.delete(cb)
      },
      onVideoRtp: (cb: (rtpData: Buffer) => void): Unsubscribe => {
        self.rtpCbs.add(cb)
        return () => self.rtpCbs.delete(cb)
      },
      updateConsumerAttributionBySession: (): boolean => true,
      getSdpParameterSets: (): ReadonlyArray<Buffer> | null => null,
      onSdpParameterSets: (): Unsubscribe => noop,
      onSourceRestart: (): Unsubscribe => noop,
      getSourceType: (): string | null => 'rtsp',
      isRtpSource: (): boolean => true,
    }
    return partial as IStreamBroker
  }
}

describe('one WebRTC session per live open (D733)', () => {
  let server: BrokerWebrtcServer
  let logger: IScopedLogger
  let low: Rendition
  let high: Rendition

  const setup = (highCodec: 'h264' | 'h265'): void => {
    logger = makeLogger()
    server = new BrokerWebrtcServer({ logger })
    server.setProfileTierResolver((brokerId) => {
      const tail = brokerId.slice(brokerId.lastIndexOf('/') + 1)
      return tail === 'high' || tail === 'mid' || tail === 'low' ? tail : null
    })
    low = new Rendition('low', 'h264')
    high = new Rendition('high', highCodec)
    server.registerBroker('5/low', low.broker())
    server.registerBroker('5/high', high.broker())
  }

  /** The cold start the player makes: no downlink, a phone-sized viewport. */
  const coldStart = async (): Promise<string> => {
    const { sessionId } = await server.createSession('5/adaptive', {
      viewportWidth: 1290,
      viewportHeight: 726,
    })
    low.emit('k0', true)
    low.emit('p1')
    return sessionId
  }

  const loggedMessages = (): string[] =>
    [...vi.mocked(logger.info).mock.calls, ...vi.mocked(logger.warn).mock.calls].map(([msg]) => msg)

  beforeEach(() => {
    vi.useFakeTimers()
    seen.forwarded = []
    seen.switches = []
    seen.pendingRenegotiation = null
    seen.liveFeedGated = false
    seen.controlCb = null
    seen.rrCb = null
  })

  afterEach(async () => {
    vi.useRealTimers()
    await server.stop()
  })

  it('a fat probe moves the open session to high: still ONE session, no re-offer', async () => {
    setup('h264')
    const sessionId = await coldStart()
    expect(seen.forwarded).toEqual(['low:k0', 'low:p1'])

    const outcome = server.applyDownlinkProbe(sessionId, 11.1)
    expect(outcome).toEqual({ outcome: 'switching', tier: 'high', reason: 'downlink' })
    await vi.advanceTimersByTimeAsync(0)

    expect(server.getSessionCount()).toBe(1)
    expect(seen.pendingRenegotiation).toBeNull()
    const debug = server.getSessionDebug(sessionId, Date.now())
    expect(debug.servedTier).toBe('low') // not yet: waiting for high's keyframe
  })

  it('no frozen frame: the old rendition keeps feeding until the new one has a keyframe, then the switch replays from it', async () => {
    setup('h264')
    const sessionId = await coldStart()
    server.applyDownlinkProbe(sessionId, 11.1)
    await vi.advanceTimersByTimeAsync(0)

    // High is mid-GOP: nothing it sends can start a decoder.
    high.emit('p7')
    low.emit('p2')
    expect(seen.switches).toEqual([])
    expect(seen.forwarded.at(-1)).toBe('low:p2')

    // High's keyframe: the switch commits ON it and replays its GOP from it.
    high.emit('k8', true)
    expect(seen.switches).toHaveLength(1)
    expect(seen.switches[0]?.bootstrap[0]).toBe('high:k8')
    expect(seen.forwarded.at(-1)).toBe('high:k8')

    // From here the track is high's alone.
    low.emit('p3')
    high.emit('p9')
    expect(seen.forwarded.slice(-1)).toEqual(['high:p9'])
    expect(seen.forwarded).not.toContain('low:p3')

    expect(server.getSessionCount()).toBe(1)
    expect(seen.pendingRenegotiation).toBeNull()
    expect(server.getSessionDebug(sessionId, Date.now()).servedTier).toBe('high')
    // Low lost its only viewer; high has exactly one video subscription.
    expect(low.rtpCbs.size).toBe(0)
    expect(high.rtpCbs.size).toBe(1)
    expect(loggedMessages()).toContain(
      'adaptive: tier switched in place — same session, same connection',
    )
  })

  it('the ladder moves in place too: a measured downgrade on a two-stream camera lands on low, no re-offer', async () => {
    setup('h264')
    const { sessionId } = await server.createSession('5/adaptive', { prefersTier: 'high' })
    high.emit('k0', true)
    low.emit('k0', true)
    // Sustained RTCP loss: the ladder demotes high → `mid`, which this camera
    // does not serve — the move lands on `low`, the rung the re-offer always
    // landed it on.
    seen.rrCb?.({ packetsLost: 0, highestSequence: 1000 })
    seen.rrCb?.({ packetsLost: 200, highestSequence: 2000 })
    await vi.advanceTimersByTimeAsync(2_500)
    expect(server.getSessionDebug(sessionId, Date.now()).lastDecision?.cause).toBe('loss')
    low.emit('k1', true)

    expect(seen.switches).toHaveLength(1)
    expect(seen.switches[0]?.bootstrap).toEqual(['low:k1'])
    expect(server.getSessionDebug(sessionId, Date.now()).servedTier).toBe('low')
    expect(seen.pendingRenegotiation).toBeNull()
    expect(server.getSessionCount()).toBe(1)
  })

  it('codec differs (main H.265, sub H.264 — camera 106): falls back to the re-offer, by name', async () => {
    setup('h265')
    const sessionId = await coldStart()
    const outcome = server.applyDownlinkProbe(sessionId, 11.1)
    expect(outcome.outcome).toBe('switching')
    await vi.advanceTimersByTimeAsync(0)

    expect(seen.switches).toEqual([])
    expect(seen.pendingRenegotiation).not.toBeNull()
    const fallback = vi
      .mocked(logger.info)
      .mock.calls.find(
        ([msg]) => msg === 'adaptive: tier switch needs a re-offer — cannot stay on the session',
      )
    expect(fallback?.[1]).toMatchObject({
      tags: { deviceId: 5 },
      meta: { reason: 'codec-differs' },
    })
  })

  it('a target that never shows a keyframe: the old picture stays, then the re-offer takes over', async () => {
    setup('h264')
    const sessionId = await coldStart()
    server.applyDownlinkProbe(sessionId, 11.1)
    await vi.advanceTimersByTimeAsync(7_000)
    low.emit('p2')
    expect(seen.forwarded.at(-1)).toBe('low:p2')
    expect(seen.pendingRenegotiation).toBeNull()

    await vi.advanceTimersByTimeAsync(1_500)
    expect(seen.pendingRenegotiation).not.toBeNull()
    expect(high.rtpCbs.size).toBe(0)
    const fallback = vi
      .mocked(logger.info)
      .mock.calls.find(
        ([msg]) => msg === 'adaptive: tier switch needs a re-offer — cannot stay on the session',
      )
    expect(fallback?.[1]).toMatchObject({ meta: { reason: 'target-no-keyframe' } })
  })

  it('a probe that picks no higher rung holds, and changes nothing', async () => {
    setup('h264')
    const sessionId = await coldStart()
    expect(server.applyDownlinkProbe(sessionId, 1.2)).toMatchObject({
      outcome: 'held',
      reason: 'already-there',
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(seen.switches).toEqual([])
    expect(seen.pendingRenegotiation).toBeNull()
  })

  it('remote viewers are unchanged: a pinned profile session is not adaptive and holds', async () => {
    setup('h264')
    const { sessionId } = await server.createSession('5/low', {})
    expect(server.applyDownlinkProbe(sessionId, 50)).toMatchObject({
      outcome: 'held',
      reason: 'not-adaptive',
      tier: 'low',
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(server.getSessionCount()).toBe(1)
    expect(seen.switches).toEqual([])
    expect(seen.pendingRenegotiation).toBeNull()
  })

  it('an adaptive session pinned by prefersTier holds', async () => {
    setup('h264')
    const { sessionId } = await server.createSession('5/adaptive', { prefersTier: 'low' })
    expect(server.applyDownlinkProbe(sessionId, 50)).toMatchObject({
      outcome: 'held',
      reason: 'pinned',
    })
  })

  it('a tile keeps its viewport ceiling — a fat probe does not lift a 200 px tile', async () => {
    setup('h264')
    const { sessionId } = await server.createSession('5/adaptive', {
      viewportWidth: 200,
      viewportHeight: 112,
    })
    expect(server.applyDownlinkProbe(sessionId, 50)).toMatchObject({ outcome: 'held' })
  })

  it('an unknown session holds — the client must not reconnect on an answer', () => {
    setup('h264')
    expect(server.applyDownlinkProbe('nope', 50)).toEqual({
      outcome: 'held',
      tier: null,
      reason: 'no-session',
    })
  })
})
