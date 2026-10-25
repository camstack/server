/**
 * BrokerWebrtcServer.countLiveViewers — the WebRTC half of the live-viewer count.
 *
 * Same harness as `broker-webrtc-server.spec.ts`: werift is not loaded, the
 * AdaptiveSession is mocked, and `close()` on the mock runs the same
 * `onClosed` hook the real session fires when the peer connection dies — which
 * is the path an ABRUPT disconnect takes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrokerConsumerKind, IScopedLogger, IStreamBroker, Unsubscribe } from '@camstack/types'
import { BrokerWebrtcServer } from '../webrtc/broker-webrtc-server.js'
import { AdaptiveSession } from '../webrtc/session.js'

interface MockSessionShape {
  readonly sessionId: string
  close: () => Promise<void>
}

function sessionInstances(): MockSessionShape[] {
  return (AdaptiveSession as unknown as { _instances?: MockSessionShape[] })._instances ?? []
}

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

function makeBroker(): IStreamBroker {
  const noop = (): Unsubscribe => () => undefined
  return {
    getStats: () => ({
      status: 'streaming',
      inputFps: 30,
      encodedSubscribers: 0,
      uptimeMs: 60_000,
      bitrateKbps: 2000,
      idrIntervalMs: 2000,
      codec: 'h264',
      totalBytes: 1,
      packetCount: 1,
      rtspClients: 0,
      pipeClients: 0,
      preBufferSec: 0,
      preBufferMs: 0,
      preBufferPackets: 0,
    }),
    getPreBuffer: () => [],
    getRtpPreBuffer: () => [],
    onEncodedData: noop,
    onVideoRtp: noop,
    updateConsumerAttributionBySession: () => true,
    getSdpParameterSets: () => null,
    onSdpParameterSets: noop,
    onSourceRestart: noop,
    getSourceType: () => 'rtsp',
    isRtpSource: () => true,
  } as unknown as IStreamBroker
}

vi.mock('../webrtc/session.js', () => {
  class MockAdaptiveSession {
    static readonly ADAPTIVE_LOW_MTU = 900
    static readonly H264_REPACKETIZER_MTU = 1100
    static _instances: MockAdaptiveSession[] = []
    readonly sessionId: string
    readonly deviceId: number
    readonly source: AsyncGenerator<unknown>
    onClosed: (() => void) | null = null
    onConnected: (() => void) | null = null
    pendingRenegotiation: null = null
    private _closed = false
    constructor(options: { sessionId: string; deviceId: number; source: AsyncGenerator<unknown> }) {
      MockAdaptiveSession._instances.push(this)
      this.sessionId = options.sessionId
      this.deviceId = options.deviceId
      this.source = options.source
    }
    readNominatedPair() {
      return null
    }
    setForceRelayOnly() {}
    onReceiverReport() {}
    setRepacketizerMtu() {}
    resetRepacketizer() {}
    forwardSourceRtpVideo() {}
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

describe('BrokerWebrtcServer.countLiveViewers', () => {
  let server: BrokerWebrtcServer

  beforeEach(() => {
    server = new BrokerWebrtcServer({ logger: makeLogger() })
    sessionInstances().length = 0
    server.registerBroker('5/high', makeBroker())
    server.registerBroker('6/high', makeBroker())
  })

  afterEach(async () => {
    await server.stop()
  })

  async function open(streamId: string, kind?: BrokerConsumerKind): Promise<string> {
    const { sessionId } = await server.createSession(
      streamId,
      {},
      kind === undefined ? {} : { consumerAttribution: { kind } },
    )
    return sessionId
  }

  it('counts a viewer session against its camera', async () => {
    await open('5/high')
    expect([...server.countLiveViewers()]).toEqual([[5, 1]])
  })

  it('counts every viewer kind and keeps cameras apart', async () => {
    await open('5/high', 'webrtc-browser')
    await open('5/high', 'webrtc-mobile')
    await open('5/high', 'webrtc-whep')
    await open('5/high', 'alexa')
    await open('6/high', 'homekit')
    expect(server.countLiveViewers().get(5)).toBe(4)
    expect(server.countLiveViewers().get(6)).toBe(1)
  })

  it('does not count a session held by the system', async () => {
    for (const kind of [
      'recording',
      'pipeline',
      'snapshot',
      'warmup',
      'derived-broker',
      'unknown',
    ] as const) {
      await open('5/high', kind)
    }
    expect(server.getSessionCount()).toBe(6)
    expect(server.countLiveViewers().size).toBe(0)
  })

  it('counts a viewer next to system sessions on the same camera', async () => {
    await open('5/high', 'snapshot')
    await open('5/high', 'webrtc-browser')
    expect(server.countLiveViewers().get(5)).toBe(1)
  })

  it('decrements when the session is closed', async () => {
    const a = await open('5/high')
    await open('5/high')
    expect(server.countLiveViewers().get(5)).toBe(2)
    await server.closeSession(a)
    expect(server.countLiveViewers().get(5)).toBe(1)
  })

  it('decrements when the peer connection dies without a close request (abrupt)', async () => {
    const id = await open('5/high')
    const inst = sessionInstances().find((s) => s.sessionId === id)
    expect(inst).toBeDefined()
    // The real session calls this from its connection-state handler when ICE
    // fails or the client vanishes; nobody called closeSession.
    await inst?.close()
    expect(server.countLiveViewers().has(5)).toBe(false)
    expect(server.getSessionCount()).toBe(0)
  })

  it('leaves no entry for a camera once its last viewer is gone', async () => {
    const a = await open('5/high')
    await server.closeSession(a)
    expect(server.countLiveViewers().size).toBe(0)
  })
})
