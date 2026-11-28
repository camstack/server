/**
 * A clip-intent session never touches live (#566).
 *
 * A Dominevo clip is a file on our own storage. Opening it must not dial the
 * camera: on a sleeping battery camera every live subscription is a wake, and
 * a cold broker made the session wait 2.5 s on parameter sets the camera will
 * never send before the clip request could even reach the server.
 *
 * The intent covers the INITIAL negotiation only. Going live is a re-offer of
 * the same session id that is an ordinary live session (wake, warm-up, codec
 * from the camera); a clip whose codec is not the negotiated one is a re-offer
 * at the clip's codec, with the clip put back on the pointer by the server.
 *
 * The broker here is a sleeping camera: every live subscription is recorded
 * by consumer kind, parameter sets never arrive. The clip feeder is a fake
 * that pushes one access unit of the codec the fixture names.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BrokerConsumerAttribution,
  BrokerStats,
  EncodedPacket,
  IScopedLogger,
  IStreamBroker,
  Unsubscribe,
  WebrtcStreamTarget,
} from '@dominevo/types'
import { BrokerWebrtcServer } from '../webrtc/broker-webrtc-server.js'
import { ControlMessageSchema } from '../recorded/control-protocol.js'

type Codec = 'H264' | 'H265'

interface PushedUnit {
  readonly sessionId: string
  readonly codec: Codec
}

interface MockSessionView {
  readonly sessionId: string
  readonly sourceCodec: Codec
  pendingRenegotiation: { target: WebrtcStreamTarget; epoch: number } | null
  onConnected: (() => void) | null
}

interface SessionHandles {
  controlCb: ((raw: string) => void) | null
  sessions: MockSessionView[]
  pushed: PushedUnit[]
  /** The codec the fake clip feeder's access units carry. */
  clipCodec: Codec
}

const handles: SessionHandles = { controlCb: null, sessions: [], pushed: [], clipCodec: 'H264' }

vi.mock('../webrtc/session.js', () => {
  class MockAdaptiveSession {
    static readonly ADAPTIVE_LOW_MTU = 900
    static readonly H264_REPACKETIZER_MTU = 1100
    readonly sessionId: string
    readonly source: AsyncGenerator<unknown>
    readonly sourceCodec: Codec
    readonly isOpusAudio = false
    readonly isLiveFeedGated = false
    onClosed: (() => void) | null = null
    onConnected: (() => void) | null = null
    pendingRenegotiation: { target: WebrtcStreamTarget; epoch: number } | null = null
    private _closed = false
    constructor(options: {
      sessionId: string
      source: AsyncGenerator<unknown>
      sourceCodec: Codec
    }) {
      this.sessionId = options.sessionId
      this.source = options.source
      this.sourceCodec = options.sourceCodec
      handles.sessions.push(this)
    }
    /** The client accepts whatever the server offers. */
    get debugNegotiatedCodec(): Codec {
      return this.sourceCodec
    }
    readNominatedPair() {
      return null
    }
    receiverEstimateKbps(): number | null {
      return null
    }
    readonly rtpPacketsSentTotal = 0
    readonly sentVideoHistory = { bitsBetween: (): number => 0 }
    setForceRelayOnly() {}
    onReceiverReport() {}
    onControlMessage(cb: (raw: string) => void) {
      handles.controlCb = cb
    }
    setLiveFeedGate() {}
    pushRecordedAccessUnit(_annexB: Uint8Array, _ts: number, codec: Codec) {
      handles.pushed.push({ sessionId: this.sessionId, codec })
    }
    writeRecordedAudio() {}
    writeRecordedAudioOpus() {}
    requestKeyframe() {}
    sendControl() {}
    setRepacketizerMtu() {}
    resetRepacketizer() {}
    forwardSourceRtpVideo() {}
    seedH264CodecInfoFromSdp() {}
    seedH265CodecInfoFromSdp() {}
    onSourceRestarted() {}
    async createOffer() {
      return { sdp: 'v=0\r\n', type: 'offer' as const }
    }
    async handleOffer() {
      return { sdp: 'v=0\r\n', type: 'answer' as const }
    }
    async handleAnswer() {}
    async close() {
      if (this._closed) return
      this._closed = true
      await this.source.return(undefined).catch(() => undefined)
      const hook = this.onClosed
      this.onClosed = null
      hook?.()
    }
  }
  return { AdaptiveSession: MockAdaptiveSession }
})

/** A clip feeder that pushes one access unit of `handles.clipCodec` on its first seek. */
vi.mock('../recorded/recorded-feeder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../recorded/recorded-feeder.js')>()
  class FakeFeeder {
    private readonly sink: { pushAccessUnit: (d: Uint8Array, ts: number, c: Codec) => void }
    constructor(opts: { sink: { pushAccessUnit: (d: Uint8Array, ts: number, c: Codec) => void } }) {
      this.sink = opts.sink
    }
    async seek(): Promise<void> {
      this.sink.pushAccessUnit(new Uint8Array([0, 0, 0, 1, 0x26, 0x01]), 0, handles.clipCodec)
    }
    setRate() {}
    stepFrame() {}
    beginScrub() {}
    scrubTo() {}
    scrubAck() {}
    dispose() {}
  }
  return { ...actual, RecordedFeeder: FakeFeeder }
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

/** What the camera's broker was asked for, by subscription kind. */
interface LiveDemand {
  readonly encoded: string[]
  readonly rtp: string[]
}

/**
 * A battery camera asleep: its catalog is known (the broker is registered)
 * but nothing has dialled it. `codec` is what the publisher declared, if
 * anything. Every `onEncodedData` / `onVideoRtp` call is demand.
 */
function makeSleepingBroker(demand: LiveDemand, codec?: 'h264' | 'h265'): IStreamBroker {
  const stats: BrokerStats = {
    status: 'idle',
    inputFps: 0,
    encodedSubscribers: 0,
    uptimeMs: 0,
    bitrateKbps: 0,
    idrIntervalMs: 0,
    ...(codec !== undefined ? { codec } : {}),
    totalBytes: 0,
    packetCount: 0,
    rtspClients: 0,
    pipeClients: 0,
    preBufferSec: 0,
    preBufferMs: 0,
    preBufferPackets: 0,
  }
  const noop: Unsubscribe = () => {}
  // The whole interface, typed: the members the server never reaches on a
  // session are inert, so a fake cannot supply a value production forgot.
  const broker: IStreamBroker = {
    deviceId: '3628',
    status: 'idle',
    suspended: false,
    start: async () => {},
    stop: async () => {},
    pushEncodedPacket: () => {},
    subscribeAudioChunks: () => ({ subscriptionId: 'none' }),
    pullAudioChunks: () => [],
    unsubscribeAudioChunks: () => false,
    getLocalStreamUrl: () => '',
    setPreBufferDuration: () => {},
    getPreBufferDuration: () => 0,
    setPreBufferEnabled: () => {},
    getStats: () => stats,
    getPreBuffer: () => [],
    getRtpPreBuffer: () => [],
    onEncodedData: (
      _cb: (packet: EncodedPacket) => void,
      attribution?: BrokerConsumerAttribution,
    ): Unsubscribe => {
      demand.encoded.push(attribution?.kind ?? 'unattributed')
      return noop
    },
    onVideoRtp: (
      _cb: (rtpData: Buffer) => void,
      attribution?: BrokerConsumerAttribution,
    ): Unsubscribe => {
      demand.rtp.push(attribution?.kind ?? 'unattributed')
      return noop
    },
    updateConsumerAttributionBySession: (): boolean => true,
    getSdpParameterSets: (): ReadonlyArray<Buffer> | null => null,
    onSdpParameterSets: (_cb: (ps: ReadonlyArray<Buffer>) => void): Unsubscribe => noop,
    onSourceRestart: (_cb: (reason: string) => void): Unsubscribe => noop,
    getSourceType: () => 'push-rtp',
    isRtpSource: (): boolean => true,
  }
  return broker
}

const SETTLED = Symbol('settled')
const PENDING = Symbol('pending')

/** Did `p` settle without any timer advancing? */
async function settlesWithoutWaiting<T>(p: Promise<T>): Promise<boolean> {
  const winner = await Promise.race([
    p.then(() => SETTLED),
    (async () => {
      for (let i = 0; i < 50; i++) await Promise.resolve()
      return PENDING
    })(),
  ])
  return winner === SETTLED
}

const STREAM = '3628/native:main'
const SESSION = 'sess-clip'

function send(msg: unknown): void {
  handles.controlCb?.(JSON.stringify(ControlMessageSchema.parse(msg)))
}

function playClip(): void {
  send({
    t: 'playClip',
    deviceId: 3628,
    clipId: 'clip-1',
    provider: 'recorder',
    offsetMs: 0,
    profile: 'high',
  })
}

function lastSession(): MockSessionView {
  const s = handles.sessions.at(-1)
  if (s === undefined) throw new Error('no session')
  return s
}

describe('a clip-intent session on a sleeping camera (#566)', () => {
  let server: BrokerWebrtcServer
  let demand: LiveDemand

  /** Offer (or re-offer) the fixed session id, letting any setup timer run out. */
  async function offer(hints: { intent?: 'live' | 'clip' }): Promise<void> {
    const answered = server.handleOffer(STREAM, 'v=0', hints, { sessionId: SESSION })
    await vi.advanceTimersByTimeAsync(2_500)
    await answered
  }

  function setUp(codec?: 'h264' | 'h265'): void {
    server.registerBroker(STREAM, makeSleepingBroker(demand, codec))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    handles.controlCb = null
    handles.sessions = []
    handles.pushed = []
    handles.clipCodec = 'H264'
    demand = { encoded: [], rtp: [] }
    server = new BrokerWebrtcServer({
      logger: makeLogger(),
      locateRecordedSegment: () => Promise.reject(new Error('no footage in this fixture')),
      readRecordedSegmentBytes: () => Promise.reject(new Error('no footage in this fixture')),
      readClipBytes: async () => new Uint8Array([0, 0, 0, 1]),
    })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await server.stop()
  })

  it('answers at once, subscribes no live consumer, and serves the clip', async () => {
    setUp()
    const answered = server.handleOffer(STREAM, 'v=0', { intent: 'clip' }, { sessionId: SESSION })
    expect(await settlesWithoutWaiting(answered)).toBe(true)
    await answered
    expect(demand).toEqual({ encoded: [], rtp: [] })

    playClip()
    await vi.advanceTimersByTimeAsync(50)

    expect(handles.pushed).toEqual([{ sessionId: SESSION, codec: 'H264' }])
    expect(demand).toEqual({ encoded: [], rtp: [] })
  })

  it('an H.265 clip on a cold broker re-offers at the clip codec and replays the clip, never dialling', async () => {
    setUp()
    handles.clipCodec = 'H265'
    await offer({ intent: 'clip' })
    expect(lastSession().sourceCodec).toBe('H264')

    playClip()
    await vi.advanceTimersByTimeAsync(50)
    // Never packetised under the wrong payload type: that is a black picture.
    expect(handles.pushed).toEqual([])
    expect(lastSession().pendingRenegotiation).toEqual({
      target: { kind: 'cam-stream', camStreamId: 'native:main' },
      epoch: 1,
    })
    expect(server.isClipIntentOffer({}, SESSION)).toBe(true)

    // The player re-offers on the same id; the re-offer carries no hint.
    // The server puts the clip back once the new session is connected.
    await offer({})
    expect(handles.pushed).toEqual([])
    lastSession().onConnected?.()
    await vi.advanceTimersByTimeAsync(50)
    expect(lastSession().sourceCodec).toBe('H265')
    expect(handles.pushed).toEqual([{ sessionId: SESSION, codec: 'H265' }])
    expect(demand).toEqual({ encoded: [], rtp: [] })
  })

  it('goLive while a clip-codec re-offer is pending makes the re-offer live, with no clip replay', async () => {
    setUp()
    handles.clipCodec = 'H265'
    await offer({ intent: 'clip' })
    playClip()
    await vi.advanceTimersByTimeAsync(50)
    expect(lastSession().pendingRenegotiation?.epoch).toBe(1)

    // The viewer leaves the clip before its player re-offered.
    send({ t: 'goLive' })
    await vi.advanceTimersByTimeAsync(0)
    expect(lastSession().pendingRenegotiation?.epoch).toBe(1)
    // The provider wakes the camera for this re-offer.
    expect(server.isClipIntentOffer({}, SESSION)).toBe(false)

    await offer({})
    // An ordinary live session: the cold broker is warmed up, live attached.
    expect(demand.encoded).toEqual(['warmup', 'webrtc-browser'])
    expect(demand.rtp).toEqual(['webrtc-browser'])
    lastSession().onConnected?.()
    await vi.advanceTimersByTimeAsync(50)
    expect(handles.pushed).toEqual([])
  })

  it('goLive on the session re-offered at the clip codec cancels its pending clip replay', async () => {
    setUp()
    handles.clipCodec = 'H265'
    await offer({ intent: 'clip' })
    playClip()
    await vi.advanceTimersByTimeAsync(50)
    await offer({})
    // Live is asked for before the re-offered session reports connected.
    send({ t: 'goLive' })
    await vi.advanceTimersByTimeAsync(0)
    lastSession().onConnected?.()
    await vi.advanceTimersByTimeAsync(50)
    expect(handles.pushed).toEqual([])
    expect(lastSession().pendingRenegotiation?.epoch).toBe(1)
  })

  it('a re-offered clip that meets the other codec re-offers once more, then refuses', async () => {
    setUp()
    handles.clipCodec = 'H265'
    await offer({ intent: 'clip' })
    playClip()
    await vi.advanceTimersByTimeAsync(50)
    await offer({})
    lastSession().onConnected?.()
    await vi.advanceTimersByTimeAsync(50)
    expect(lastSession().sourceCodec).toBe('H265')

    // The next clip is H.264: one more re-offer, at H.264.
    handles.clipCodec = 'H264'
    playClip()
    await vi.advanceTimersByTimeAsync(50)
    expect(lastSession().pendingRenegotiation?.epoch).toBe(1)
    await offer({})
    lastSession().onConnected?.()
    await vi.advanceTimersByTimeAsync(50)
    expect(lastSession().sourceCodec).toBe('H264')
    expect(handles.pushed.at(-1)).toEqual({ sessionId: SESSION, codec: 'H264' })

    // Back to H.265, already tried on this id: refused, no third re-offer.
    handles.clipCodec = 'H265'
    playClip()
    await vi.advanceTimersByTimeAsync(50)
    expect(lastSession().pendingRenegotiation).toBeNull()
    expect(demand).toEqual({ encoded: [], rtp: [] })
  })

  it('goLive on an H.265 camera re-offers as a live session at the camera codec', async () => {
    setUp('h265')
    await offer({ intent: 'clip' })
    send({ t: 'goLive' })
    await vi.advanceTimersByTimeAsync(0)
    expect(lastSession().pendingRenegotiation?.epoch).toBe(1)
    expect(server.isClipIntentOffer({ intent: 'clip' }, SESSION)).toBe(false)

    // A viewer that resends its first hints still gets live: the intent
    // belonged to the initial negotiation only.
    await offer({ intent: 'clip' })
    expect(lastSession().sourceCodec).toBe('H265')
    expect(demand.encoded).toEqual(['webrtc-browser'])
    expect(demand.rtp).toEqual(['webrtc-browser'])
  })

  it('a second goLive asks for one renegotiation, not two', async () => {
    setUp()
    await offer({ intent: 'clip' })
    send({ t: 'goLive' })
    send({ t: 'goLive' })
    await vi.advanceTimersByTimeAsync(0)
    expect(lastSession().pendingRenegotiation?.epoch).toBe(1)
    expect(demand).toEqual({ encoded: [], rtp: [] })
  })

  it('after goLive and the re-offer, teardown releases live and arms the linger', async () => {
    setUp('h264')
    await offer({ intent: 'clip' })
    send({ t: 'goLive' })
    await vi.advanceTimersByTimeAsync(0)
    await offer({})
    expect(demand.encoded).toEqual(['webrtc-browser'])

    await server.closeSession(SESSION)
    // The linger ghost: a `warmup`-kind hold on the broker the viewer left.
    expect(demand.encoded).toEqual(['webrtc-browser', 'warmup'])
  })

  it('leaves no linger ghost behind a clip-only session', async () => {
    setUp()
    await offer({ intent: 'clip' })
    await server.closeSession(SESSION)
    expect(demand.encoded).toEqual([])
  })

  it('without the hint keeps today’s behaviour: a warm-up dial on a cold broker', async () => {
    setUp()
    await offer({})
    expect(demand.encoded[0]).toBe('warmup')
    expect(demand.encoded).toContain('webrtc-browser')
    expect(demand.rtp).toEqual(['webrtc-browser'])
  })
})
