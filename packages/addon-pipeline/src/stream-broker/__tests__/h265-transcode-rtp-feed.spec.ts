/**
 * H.265 RTP-source session feed — RTSP-pull transcode reality.
 *
 * ARCHITECTURE (current):
 *   For `isRtp` sources (RTSP / rfc4571), video is forwarded through the RTP
 *   repacketizer fast-path (`onVideoRtp` → `forwardSourceRtpVideo`) and the
 *   AnnexB `onEncodedData` video branch is skipped entirely for RTP sessions:
 *
 *     if (useRtpRepacketizer || session?.needsTranscode === true) return
 *
 *   This means:
 *   - For a PASSTHROUGH H.265↔H.265 session (`needsTranscode=false`), the
 *     repacketizer owns the wire; the push `FrameSource` carries ONLY audio.
 *   - For a TRANSCODE H.265→H.264 session (`needsTranscode=true`), ffmpeg
 *     PULLS the source restream over RTSP (`startTranscodeFeed`, mode=rtsp-pull)
 *     and reads video itself. The push `FrameSource` still carries ONLY audio —
 *     video is never pushed into it for any RTP or transcode session.
 *   - The source-RTP repacketizer (`forwardSourceRtpVideo`) is suppressed for
 *     transcode sessions (`onVideoRtp` bails on `needsTranscode`), to prevent
 *     H.265 RTP being sent under an H.264 negotiation.
 *
 * This spec asserts:
 *   1. Transcode session (H.265 isRtp → H.264): video is NOT pushed into the
 *      FrameSource (`collectedFrames` has no video MediaFrames). Audio still
 *      rides the source.
 *   2. Transcode session: the source-RTP repacketizer is suppressed
 *      (`forwardedRtp` is empty).
 *   3. Passthrough session (H.265↔H.265, `needsTranscode=false`): video is
 *      also NOT pushed into the FrameSource (repacketizer owns the wire),
 *      and only audio rides the source.
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
import { AdaptiveSession } from '../webrtc/session.js'
import type { MediaFrame } from '../webrtc/types.js'

// ── Mocked AdaptiveSession ───────────────────────────────────────────────────
//
// As in `broker-webrtc-server.spec.ts`, we mock AdaptiveSession to avoid the
// heavy werift import. This mock additionally:
//   - exposes `needsTranscode` (driven by the source codec the broker passes,
//     plus a test override) so the broker's transcode-gated branches can be
//     exercised without real SDP negotiation;
//   - records every `forwardSourceRtpVideo` call so a test can assert the
//     repacketizer is suppressed on the transcode path;
//   - drains its captured push `source` into `collectedFrames` so a test can
//     assert which MediaFrames the transcode feed would actually read.

interface MockSessionShape {
  readonly sessionId: string
  needsTranscode: boolean
  readonly sourceCodec: 'H264' | 'H265'
  readonly forwardedRtp: Buffer[]
  readonly collectedFrames: MediaFrame[]
  onConnected: (() => void) | null
}

function mockSessions(): MockSessionShape[] {
  const reg = (AdaptiveSession as unknown as { _instances?: MockSessionShape[] })._instances
  return reg ?? []
}

vi.mock('../webrtc/session.js', () => {
  // A test knob: when `sourceCodec === 'H265'` the mock reports
  // `needsTranscode = true` (H.265 source toward the default H.264
  // negotiation — the production default before an answer arrives), and
  // `false` for H.264. A test can flip the instance field directly to model
  // the H.265↔H.265 passthrough case.
  class MockAdaptiveSession {
    static readonly ADAPTIVE_LOW_MTU = 900
    static readonly H264_REPACKETIZER_MTU = 1100
    static _instances: MockAdaptiveSession[] = []

    readonly sessionId: string
    readonly deviceId: number
    readonly source: AsyncGenerator<MediaFrame, void, unknown>
    readonly sourceCodec: 'H264' | 'H265'
    needsTranscode: boolean
    onClosed: (() => void) | null = null
    onConnected: (() => void) | null = null
    forceRelayOnly = false
    pendingRenegotiation: { target: unknown; epoch: number } | null = null
    private _closed = false
    _nominatedPair: unknown = null

    // Frames drained from the push `source` (what a feed loop would read).
    readonly collectedFrames: MediaFrame[] = []
    // Every source-RTP packet the broker forwarded to the repacketizer.
    readonly forwardedRtp: Buffer[] = []

    readNominatedPair() {
      return this._nominatedPair
    }

    constructor(options: {
      sessionId: string
      deviceId: number
      source: AsyncGenerator<MediaFrame, void, unknown>
      sourceCodec?: 'H264' | 'H265'
    }) {
      MockAdaptiveSession._instances.push(this)
      this.sessionId = options.sessionId
      this.deviceId = options.deviceId
      this.source = options.source
      this.sourceCodec = options.sourceCodec ?? 'H264'
      this.needsTranscode = this.sourceCodec === 'H265'
      // Drain the push source in the background, mirroring what a real feed
      // loop does (`for await (const mediaFrame of this.source)`). This makes
      // the FrameSource observable.
      const source = options.source
      void (async () => {
        try {
          for await (const mf of source) {
            this.collectedFrames.push(mf)
          }
        } catch {
          /* source closed */
        }
      })()
    }

    setForceRelayOnly(value: boolean) {
      this.forceRelayOnly = value
    }

    onReceiverReport(_cb: (s: { packetsLost: number; highestSequence: number }) => void) {
      /* no-op */
    }
    setRepacketizerMtu(_mtu: number) {
      /* no-op */
    }
    resetRepacketizer() {
      /* no-op */
    }
    seedH265CodecInfoFromSdp(_ps: ReadonlyArray<Buffer>) {
      /* no-op */
    }
    seedH264CodecInfoFromSdp(_ps: ReadonlyArray<Buffer>) {
      /* no-op */
    }

    forwardSourceRtpVideo(rtp: Buffer) {
      this.forwardedRtp.push(rtp)
    }

    async createOffer() {
      return { sdp: `v=0\r\no=- ${this.sessionId} 0 IN IP4 127.0.0.1\r\n`, type: 'offer' as const }
    }
    async handleAnswer(_answer: { sdp: string; type: 'answer' }) {
      /* no-op */
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
      try {
        hook?.()
      } catch {
        /* */
      }
    }
  }

  return { AdaptiveSession: MockAdaptiveSession }
})

// ── Broker fake (isRtp H.265, real onEncodedData + onVideoRtp fan-out) ───────

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

interface RtpBrokerControls {
  pushEncoded: (pkt: EncodedPacket) => void
  pushVideoRtp: (rtp: Buffer) => void
  /** Deliver SDP-derived VPS/SPS/PPS to every late `onSdpParameterSets`
   *  subscriber (mirrors `StreamBroker.emitSdpParamSetsTo` late delivery). */
  pushSdpParameterSets: (ps: ReadonlyArray<Buffer>) => void
}

function makeRtpH265Broker(
  controls: { out: RtpBrokerControls },
  options: {
    preBuffer?: readonly EncodedPacket[]
    sdpParameterSets?: ReadonlyArray<Buffer>
  } = {},
): IStreamBroker {
  const encodedListeners = new Set<(packet: EncodedPacket) => void>()
  const rtpListeners = new Set<(rtp: Buffer) => void>()
  const sdpParamListeners = new Set<(ps: ReadonlyArray<Buffer>) => void>()
  const sourceRestartListeners = new Set<(reason: string) => void>()
  const stats: BrokerStats = {
    status: 'streaming',
    inputFps: 30,
    encodedSubscribers: 0,
    uptimeMs: 60_000,
    bitrateKbps: 2000,
    idrIntervalMs: 2000,
    codec: 'h265',
    totalBytes: 1_000_000,
    packetCount: 500,
    rtspClients: 0,
    pipeClients: 0,
    preBufferSec: 10,
    preBufferMs: 10_000,
    preBufferPackets: 300,
  }

  controls.out.pushEncoded = (pkt) => {
    for (const cb of encodedListeners) cb(pkt)
  }
  controls.out.pushVideoRtp = (rtp) => {
    for (const cb of rtpListeners) cb(rtp)
  }
  controls.out.pushSdpParameterSets = (ps) => {
    for (const cb of sdpParamListeners) cb(ps)
  }

  return {
    getStats: () => stats,
    getPreBuffer: () => options.preBuffer ?? [],
    getRtpPreBuffer: () => [],
    onEncodedData: (cb: (packet: EncodedPacket) => void): Unsubscribe => {
      encodedListeners.add(cb)
      return () => {
        encodedListeners.delete(cb)
      }
    },
    onVideoRtp: (cb: (rtp: Buffer) => void): Unsubscribe => {
      rtpListeners.add(cb)
      return () => {
        rtpListeners.delete(cb)
      }
    },
    updateConsumerAttributionBySession: (): boolean => true,
    getSdpParameterSets: (): ReadonlyArray<Buffer> | null => options.sdpParameterSets ?? null,
    onSdpParameterSets: (cb: (ps: ReadonlyArray<Buffer>) => void): Unsubscribe => {
      sdpParamListeners.add(cb)
      return () => {
        sdpParamListeners.delete(cb)
      }
    },
    onSourceRestart: (cb: (reason: string) => void): Unsubscribe => {
      sourceRestartListeners.add(cb)
      return () => {
        sourceRestartListeners.delete(cb)
      }
    },
    getSourceType: (): string | null => 'rtsp',
    isRtpSource: (): boolean => true,
  } as unknown as IStreamBroker
}

// H.265 NAL header: (type << 1) in the top bits of byte 0.
const H265_VPS = Buffer.from([32 << 1, 0x01, 0xc0, 0x01])
const H265_SPS = Buffer.from([33 << 1, 0x01, 0x42, 0x01])
const H265_PPS = Buffer.from([34 << 1, 0x01, 0xc1])
const H265_IDR = Buffer.from([19 << 1, 0x01, 0xaa, 0xbb, 0xcc])

/** Length-prefix (AVCC-style) one or more NALs — the broker `EncodedPacket.data`
 * shape that `convertH265ToAnnexB` rewrites into Annex-B. */
function lengthPrefixed(...nals: Buffer[]): Buffer {
  return Buffer.concat(
    nals.map((nal) => {
      const len = Buffer.alloc(4)
      len.writeUInt32BE(nal.length, 0)
      return Buffer.concat([len, nal])
    }),
  )
}

/**
 * Real RTSP H.265 cameras deliver parameter sets and VCL slices as SEPARATE
 * `EncodedPacket`s. Returns a VPS/SPS/PPS packet followed by an IDR slice.
 */
function makeH265KeyframePackets(pts: number): readonly EncodedPacket[] {
  const paramSets: EncodedPacket = {
    type: 'video',
    data: lengthPrefixed(H265_VPS, H265_SPS, H265_PPS),
    pts,
    dts: pts,
    keyframe: false,
    codec: 'h265',
  }
  const idr: EncodedPacket = {
    type: 'video',
    data: lengthPrefixed(H265_IDR),
    pts,
    dts: pts,
    keyframe: true,
    codec: 'h265',
  }
  return [paramSets, idr]
}

function makeAudioPacket(pts: number): EncodedPacket {
  return {
    type: 'audio',
    data: Buffer.from([0xff, 0xfe, 0xfd, 0xfc]),
    pts,
    dts: pts,
    keyframe: false,
    codec: 'PCMU',
  }
}

const flush = () => new Promise((r) => setImmediate(r))

/** A mutable `RtpBrokerControls` whose methods the broker fake overwrites on
 *  construction. */
function makeControls(): RtpBrokerControls {
  return {
    pushEncoded: (_: EncodedPacket) => {},
    pushVideoRtp: (_: Buffer) => {},
    pushSdpParameterSets: (_: ReadonlyArray<Buffer>) => {},
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('H.265 RTP-source transcode feed', () => {
  let logger: IScopedLogger
  let server: BrokerWebrtcServer

  beforeEach(() => {
    logger = makeLogger()
    server = new BrokerWebrtcServer({ logger })
    mockSessions().length = 0
  })

  afterEach(async () => {
    await server.stop()
  })

  it('transcode session (isRtp H.265→H.264): video is NOT pushed into the FrameSource', async () => {
    // The new invariant: ffmpeg pulls the source restream over RTSP
    // (`startTranscodeFeed`, mode=rtsp-pull). The push FrameSource is
    // audio-only for any RTP source or transcode session.
    const out = makeControls()
    const broker = makeRtpH265Broker({ out })
    server.registerBroker('7/high', broker)

    await server.createSession('7/high')
    const session = mockSessions().at(-1)
    expect(session).toBeDefined()
    expect(session!.sourceCodec).toBe('H265')
    expect(session!.needsTranscode).toBe(true)

    // Drive onEncodedData with H.265 video packets and an audio packet.
    out.pushEncoded(makeAudioPacket(0))
    for (const pkt of makeH265KeyframePackets(10)) out.pushEncoded(pkt)
    await flush()
    await flush()

    const videoFrames = session!.collectedFrames.filter((f) => f.type === 'video')
    const audioFrames = session!.collectedFrames.filter((f) => f.type === 'audio')

    // NEW invariant: video is NOT pushed into the FrameSource for any RTP
    // or transcode session. ffmpeg pulls video via RTSP-pull instead.
    expect(videoFrames.length).toBe(0)
    // Audio still rides the source FrameSource.
    expect(audioFrames.length).toBeGreaterThan(0)
  })

  it('transcode session: the source-RTP repacketizer is suppressed', async () => {
    const out = makeControls()
    const broker = makeRtpH265Broker({ out })
    server.registerBroker('7/high', broker)

    await server.createSession('7/high')
    const session = mockSessions().at(-1)
    expect(session!.needsTranscode).toBe(true)

    // Source RTP arrives on the repacketizer fan-out. On the transcode path it
    // must be dropped — forwarding it would send H.265 RTP under an H.264
    // negotiation AND duplicate the transcoded egress.
    out.pushVideoRtp(Buffer.from([0x80, 0x60, 0x00, 0x01]))
    out.pushVideoRtp(Buffer.from([0x80, 0x60, 0x00, 0x02]))
    await flush()

    expect(session!.forwardedRtp.length).toBe(0)
  })

  it('passthrough session (needsTranscode=false): video is NOT pushed into the FrameSource, only audio rides the source', async () => {
    const out = makeControls()
    const broker = makeRtpH265Broker({ out })
    server.registerBroker('7/high', broker)

    await server.createSession('7/high')
    const session = mockSessions().at(-1)
    // Model the H.265↔H.265 passthrough: the negotiated answer settled on
    // H.265, so the session no longer needs transcode.
    session!.needsTranscode = false

    out.pushEncoded(makeAudioPacket(0))
    for (const pkt of makeH265KeyframePackets(10)) out.pushEncoded(pkt)
    out.pushVideoRtp(Buffer.from([0x80, 0x60, 0x00, 0x01]))
    await flush()
    await flush()

    const videoFrames = session!.collectedFrames.filter((f) => f.type === 'video')
    const audioFrames = session!.collectedFrames.filter((f) => f.type === 'audio')

    // Repacketizer owns video — it must NOT be duplicated into the source.
    expect(videoFrames.length).toBe(0)
    // The source RTP rode the repacketizer fast-path.
    expect(session!.forwardedRtp.length).toBeGreaterThan(0)
    // Audio still rides the source.
    expect(audioFrames.length).toBeGreaterThan(0)
  })
})
