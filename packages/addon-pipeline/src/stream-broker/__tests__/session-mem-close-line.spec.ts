import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type {
  BrokerStats,
  EncodedPacket,
  IScopedLogger,
  IStreamBroker,
  Unsubscribe,
} from '@camstack/types'
import { BrokerWebrtcServer } from '../webrtc/broker-webrtc-server.js'

const MB = 1024 * 1024
const mockSessions: { onClosed: (() => void) | null }[] = []

vi.mock('../webrtc/session.js', () => {
  class MockAdaptiveSession {
    static readonly ADAPTIVE_LOW_MTU = 900
    static readonly H264_REPACKETIZER_MTU = 1100
    readonly sessionId: string
    readonly deviceId: number
    readonly source: AsyncGenerator<unknown>
    onClosed: (() => void) | null = null
    onConnected: (() => void) | null = null
    constructor(options: { sessionId: string; deviceId: number; source: AsyncGenerator<unknown> }) {
      mockSessions.push(this)
      this.sessionId = options.sessionId
      this.deviceId = options.deviceId
      this.source = options.source
    }
    readMemTotals() {
      const t = {
        entries: 3,
        payloadBytes: 300,
        naiveBackingBytes: 2 * MB,
        distinctBackingBytes: MB,
        capped: false,
      }
      return { rtpCache: t, rtpReplay: { ...t, entries: 0, distinctBackingBytes: 0 } }
    }
    readNominatedPair() {
      return null
    }
    setForceRelayOnly() {
      /* no-op */
    }
    onReceiverReport() {
      /* no-op */
    }
    setRepacketizerMtu() {
      /* no-op */
    }
    resetRepacketizer() {
      /* no-op */
    }
    forwardSourceRtpVideo() {
      /* no-op */
    }
    async createOffer() {
      return { sdp: 'v=0\r\n', type: 'offer' as const }
    }
    async handleOffer() {
      return { sdp: 'v=0\r\n', type: 'answer' as const }
    }
    async close() {
      try {
        await this.source.return(undefined)
      } catch {
        /* */
      }
      this.onClosed?.()
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
    totalBytes: 1_000,
    packetCount: 10,
    rtspClients: 0,
    pipeClients: 0,
    preBufferSec: 10,
    preBufferMs: 10_000,
    preBufferPackets: 10,
  }
  const noop = (): Unsubscribe => () => undefined
  return {
    getStats: () => stats,
    getPreBuffer: () => [],
    getRtpPreBuffer: () => [],
    onEncodedData: (_cb: (packet: EncodedPacket) => void) => noop(),
    onVideoRtp: () => noop(),
    updateConsumerAttributionBySession: () => true,
    getSdpParameterSets: () => null,
    getSourceType: (): string | null => 'rtsp',
    isRtpSource: (): boolean => true,
    onSdpParameterSets: () => noop(),
    onSourceRestart: () => noop(),
  } as unknown as IStreamBroker
}

function countersCalls(logger: IScopedLogger) {
  return vi
    .mocked(logger.info)
    .mock.calls.filter(([msg]) => msg === 'WebRTC session closing: pinned-memory counters')
}

describe('per-session counters at close', () => {
  let logger: IScopedLogger
  let server: BrokerWebrtcServer

  beforeEach(() => {
    mockSessions.length = 0
    logger = makeLogger()
    server = new BrokerWebrtcServer({ logger })
    server.registerBroker('101/high', makeMockBroker())
  })
  afterEach(async () => {
    await server.stop()
  })

  it('a session that ends through onClosed logs its counters once, with the deviceId tag', async () => {
    await server.createSession('101/high')
    mockSessions[0]?.onClosed?.()
    const calls = countersCalls(logger)
    expect(calls).toHaveLength(1)
    const opts = calls[0]?.[1]
    expect(opts?.tags).toEqual({ deviceId: 101 })
    expect(opts?.meta).toMatchObject({
      rtpCacheEntries: 3,
      rtpCacheBackingMb: 1,
      rtpCacheNaiveMb: 2,
    })
  })

  it('closeSession does not log a second line when the session then fires onClosed', async () => {
    const { sessionId } = await server.createSession('101/high')
    await server.closeSession(sessionId)
    expect(countersCalls(logger)).toHaveLength(1)
  })
})
