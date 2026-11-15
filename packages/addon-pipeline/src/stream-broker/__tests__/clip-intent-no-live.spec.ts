/**
 * A clip-intent session never touches live (#566).
 *
 * A CamStack clip is a file on our own storage. Opening it must not dial the
 * camera: on a sleeping battery camera every live subscription is a wake, and
 * a cold broker made the session wait 2.5 s on parameter sets the camera will
 * never send before the clip request could even reach the server.
 *
 * The broker here is that sleeping camera: no codec known, no parameter sets
 * ever, and every live subscription is recorded by consumer kind. A session
 * offered with `intent: 'clip'` must answer at once, subscribe nothing, and
 * still serve the clip. Going live afterwards is what attaches live. A session
 * without the hint keeps today's behaviour.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BrokerConsumerAttribution,
  BrokerStats,
  CamProfile,
  EncodedPacket,
  IScopedLogger,
  IStreamBroker,
  Unsubscribe,
} from '@camstack/types'
import { BrokerWebrtcServer } from '../webrtc/broker-webrtc-server.js'
import { ControlMessageSchema } from '../recorded/control-protocol.js'

interface SessionHandles {
  controlCb: ((raw: string) => void) | null
}

const handles: SessionHandles = { controlCb: null }

vi.mock('../webrtc/session.js', () => {
  class MockAdaptiveSession {
    static readonly ADAPTIVE_LOW_MTU = 900
    static readonly H264_REPACKETIZER_MTU = 1100
    readonly sessionId: string
    readonly source: AsyncGenerator<unknown>
    readonly isOpusAudio = false
    readonly isLiveFeedGated = false
    onClosed: (() => void) | null = null
    onConnected: (() => void) | null = null
    pendingRenegotiation: null = null
    private _closed = false
    constructor(options: { sessionId: string; source: AsyncGenerator<unknown> }) {
      this.sessionId = options.sessionId
      this.source = options.source
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
    pushRecordedAccessUnit() {}
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

/** What the sleeping camera's broker was asked for, by subscription kind. */
interface LiveDemand {
  readonly encoded: string[]
  readonly rtp: string[]
}

/**
 * A battery camera asleep: its catalog is known (the broker is registered)
 * but nothing has dialled it, so the codec is unknown and parameter sets
 * never arrive. Every `onEncodedData` / `onVideoRtp` call is demand — the
 * subscription that would dial it.
 */
function makeSleepingBroker(demand: LiveDemand): IStreamBroker {
  const stats: BrokerStats = {
    status: 'idle',
    inputFps: 0,
    encodedSubscribers: 0,
    uptimeMs: 0,
    bitrateKbps: 0,
    idrIntervalMs: 0,
    totalBytes: 0,
    packetCount: 0,
    rtspClients: 0,
    pipeClients: 0,
    preBufferSec: 0,
    preBufferMs: 0,
    preBufferPackets: 0,
  }
  const noop: Unsubscribe = () => {}
  return {
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
    getSourceType: (): string | null => 'push-rtp',
    isRtpSource: (): boolean => true,
  } as unknown as IStreamBroker
}

/** `readClipBytes` as the server is handed it, recording each read. */
function makeReadClipBytes() {
  return vi.fn(
    async (_args: {
      deviceId: number
      clipId: string
      provider: string
      profile: CamProfile | null
    }): Promise<Uint8Array> => new Uint8Array([0, 0, 0, 1]),
  )
}

const SETTLED = Symbol('settled')
const PENDING = Symbol('pending')

/** Did `p` settle without any timer advancing? */
async function settlesWithoutWaiting<T>(p: Promise<T>): Promise<boolean> {
  const winner = await Promise.race([
    p.then(() => SETTLED),
    // Several microtask turns, zero wall-clock: the setup awaits ICE
    // resolution and the offer, never a timer, when it does not wait on live.
    (async () => {
      for (let i = 0; i < 50; i++) await Promise.resolve()
      return PENDING
    })(),
  ])
  return winner === SETTLED
}

/** Open a clip-intent session, letting any timer the setup waits on run out. */
async function openClipSession(server: BrokerWebrtcServer): Promise<string> {
  const created = server.createSession('3628/native:sub', { intent: 'clip' })
  await vi.advanceTimersByTimeAsync(2_500)
  return (await created).sessionId
}

function send(msg: unknown): void {
  handles.controlCb?.(JSON.stringify(ControlMessageSchema.parse(msg)))
}

describe('a clip-intent session on a sleeping camera (#566)', () => {
  let server: BrokerWebrtcServer
  let demand: LiveDemand
  let readClipBytes: ReturnType<typeof makeReadClipBytes>

  beforeEach(() => {
    vi.useFakeTimers()
    handles.controlCb = null
    demand = { encoded: [], rtp: [] }
    readClipBytes = makeReadClipBytes()
    server = new BrokerWebrtcServer({
      logger: makeLogger(),
      locateRecordedSegment: () => Promise.reject(new Error('no footage in this fixture')),
      readRecordedSegmentBytes: () => Promise.reject(new Error('no footage in this fixture')),
      readClipBytes,
    })
    server.registerBroker('3628/native:sub', makeSleepingBroker(demand))
  })

  afterEach(async () => {
    vi.useRealTimers()
    await server.stop()
  })

  it('answers at once, subscribes no live consumer, and serves the clip', async () => {
    const created = server.createSession('3628/native:sub', { intent: 'clip' })
    expect(await settlesWithoutWaiting(created)).toBe(true)
    await created

    expect(demand).toEqual({ encoded: [], rtp: [] })

    send({
      t: 'playClip',
      deviceId: 3628,
      clipId: 'clip-1',
      provider: 'recorder',
      offsetMs: 0,
      profile: 'low',
    })
    await vi.advanceTimersByTimeAsync(50)

    expect(readClipBytes).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 3628, clipId: 'clip-1', provider: 'recorder' }),
    )
    // Serving the clip demanded nothing from the camera either.
    expect(demand).toEqual({ encoded: [], rtp: [] })
  })

  it('attaches live only when the client goes live', async () => {
    await openClipSession(server)
    expect(demand).toEqual({ encoded: [], rtp: [] })
    send({ t: 'goLive' })
    await vi.advanceTimersByTimeAsync(0)
    expect(demand.encoded).toEqual(['webrtc-browser'])
    expect(demand.rtp).toEqual(['webrtc-browser'])
  })

  it('leaves no linger ghost behind a clip-only session', async () => {
    const sessionId = await openClipSession(server)
    await server.closeSession(sessionId)
    expect(demand.encoded).toEqual([])
  })

  it('without the hint keeps today’s behaviour: a warm-up dial on a cold broker', async () => {
    const created = server.createSession('3628/native:sub', {})
    await vi.advanceTimersByTimeAsync(2_500)
    await created
    expect(demand.encoded[0]).toBe('warmup')
    expect(demand.encoded).toContain('webrtc-browser')
    expect(demand.rtp).toEqual(['webrtc-browser'])
  })
})
