/**
 * Level-capped H.264 client offer: serve the camera's substream, else transcode.
 *
 * Strict WebKit/iOS offers only `42e01f` / `640c1f` (L3.1). A 4K Main L5.1
 * source is negotiated at L3.1 and shows black. When the client's highest
 * offered level for a compatible profile is below the source's, the session is
 * bound to the camera's lower-resolution stream if one fits (no CPU); only
 * without one does it fall back to the Baseline re-encode. A Chrome-style offer
 * (a high level for Main/High) is untouched: the main stream, passthrough.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type {
  BrokerStats,
  CamProfile,
  EncodedPacket,
  IScopedLogger,
  IStreamBroker,
  Unsubscribe,
} from '@camstack/types'
import { BrokerWebrtcServer } from '../webrtc/broker-webrtc-server.js'

const captured: Array<{ transcodeToBaseline: boolean }> = []

vi.mock('../webrtc/session.js', () => {
  class MockAdaptiveSession {
    static readonly ADAPTIVE_LOW_MTU = 900
    static readonly H264_REPACKETIZER_MTU = 1100
    readonly sessionId: string
    readonly deviceId: number
    readonly source: AsyncGenerator<unknown>
    onClosed: (() => void) | null = null
    onConnected: (() => void) | null = null
    constructor(options: {
      sessionId: string
      deviceId: number
      source: AsyncGenerator<unknown>
      transcodeToBaseline: boolean
    }) {
      captured.push({ transcodeToBaseline: options.transcodeToBaseline })
      this.sessionId = options.sessionId
      this.deviceId = options.deviceId
      this.source = options.source
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

function makeLogger(): {
  logger: IScopedLogger
  info: ReturnType<typeof vi.fn>
} {
  const info = vi.fn()
  const l: IScopedLogger = {
    info,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return { logger: l, info }
}

interface MockBroker {
  readonly broker: IStreamBroker
  /** Subscriptions that are real consumers (not warm-up ghosts). */
  readonly realSubscribers: () => number
}

function sps(profileLevelId: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x67]),
    Buffer.from(profileLevelId, 'hex'),
    Buffer.from([0x00]),
  ])
}

function makeMockBroker(profileLevelId: string): MockBroker {
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
  let real = 0
  const noop = (): Unsubscribe => () => undefined
  const broker = {
    getStats: () => stats,
    getPreBuffer: () => [],
    getRtpPreBuffer: () => [],
    onEncodedData: (
      _cb: (packet: EncodedPacket) => void,
      attribution?: { readonly kind?: string },
    ): Unsubscribe => {
      if (attribution?.kind === 'warmup') return noop()
      real += 1
      return noop()
    },
    onVideoRtp: () => noop(),
    updateConsumerAttributionBySession: () => true,
    getSdpParameterSets: () => [sps(profileLevelId)],
    onSdpParameterSets: () => noop(),
    onSourceRestart: () => noop(),
    getSourceType: () => 'rtsp',
    isRtpSource: () => false,
  } as unknown as IStreamBroker
  return { broker, realSubscribers: () => real }
}

function offerWithLevels(...profileLevelIds: string[]): string {
  const fmtp = profileLevelIds.map(
    (p, i) =>
      `a=fmtp:${String(96 + i)} level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${p}`,
  )
  return ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', ...fmtp, ''].join('\r\n')
}

const MAIN_4K = '4d0033' // Main L5.1
const SUB_360P = '4d001e' // Main L3.0
const STRICT_SAFARI = ['42e01f', '640c1f'] // L3.1 only
const CHROME = ['42e01f', '4d0034', '640034'] // Main/High up to L5.2

describe('level-capped client offer', () => {
  let server: BrokerWebrtcServer
  let main: MockBroker
  let sub: MockBroker
  let log: ReturnType<typeof makeLogger>

  beforeEach(() => {
    captured.length = 0
    log = makeLogger()
    server = new BrokerWebrtcServer({ logger: log.logger })
    const tiers = new Map<string, CamProfile>([
      ['101/high', 'high'],
      ['101/low', 'low'],
    ])
    server.setProfileTierResolver((id) => tiers.get(id) ?? null)
    main = makeMockBroker(MAIN_4K)
    sub = makeMockBroker(SUB_360P)
    server.registerBroker('101/high', main.broker)
  })
  afterEach(async () => {
    await server.stop()
  })

  it('serves the substream when the client offers only L3.1 and a substream fits', async () => {
    server.registerBroker('101/low', sub.broker)
    await server.handleOffer('101/high', offerWithLevels(...STRICT_SAFARI))
    expect(sub.realSubscribers()).toBe(1)
    expect(main.realSubscribers()).toBe(0)
    expect(captured[0]?.transcodeToBaseline).toBe(false)
    const decision = log.info.mock.calls.find((c) =>
      String(c[0]).includes('lower-resolution stream'),
    )
    expect(decision?.[1]).toMatchObject({
      tags: { deviceId: 101 },
      meta: { reason: 'client-level-below-source', toBrokerId: '101/low' },
    })
  })

  it('falls back to the Baseline transcode of the main stream when no substream exists', async () => {
    await server.handleOffer('101/high', offerWithLevels(...STRICT_SAFARI))
    expect(main.realSubscribers()).toBe(1)
    expect(captured[0]?.transcodeToBaseline).toBe(true)
    const decision = log.info.mock.calls.find((c) =>
      String(c[0]).includes('no lower-resolution stream fits'),
    )
    expect(decision?.[1]).toMatchObject({
      tags: { deviceId: 101 },
      meta: { reason: 'client-level-below-source-no-substream' },
    })
  })

  it('keeps the main stream, passthrough, for a Chrome-style offer with a high level', async () => {
    server.registerBroker('101/low', sub.broker)
    await server.handleOffer('101/high', offerWithLevels(...CHROME))
    expect(main.realSubscribers()).toBe(1)
    expect(sub.realSubscribers()).toBe(0)
    expect(captured[0]?.transcodeToBaseline).toBe(false)
  })
})
