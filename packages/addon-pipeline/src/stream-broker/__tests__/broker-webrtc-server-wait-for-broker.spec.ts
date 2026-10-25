/**
 * A stream whose broker is still being recreated is NOT a stream that is gone.
 *
 * After an addon respawn — every deploy, every update — the manager rebuilds
 * its brokers and re-registers them with the WebRTC server. A viewer that was
 * watching reconnects in that window and gets `No broker for stream "…"`,
 * terminal, immediately. The operator's workaround has been pause/play, and it
 * works for one reason only: TIME. The second attempt issues the identical call
 * a few seconds later, by which point the broker exists.
 *
 * So the resolve path waits, briefly and boundedly, for the broker to appear —
 * and says so if it gives up. `registerBroker` is the event it waits on, which
 * is the same call the manager already makes as each broker comes back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type {
  BrokerStats,
  EncodedPacket,
  IScopedLogger,
  IStreamBroker,
  Unsubscribe,
} from '@camstack/types'
import { BrokerWebrtcServer } from '../webrtc/broker-webrtc-server.js'

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
    onSdpParameterSets: () => noop(),
    onSourceRestart: () => noop(),
  } as unknown as IStreamBroker
}

describe('waiting for a broker that is coming back', () => {
  let server: BrokerWebrtcServer

  beforeEach(() => {
    server = new BrokerWebrtcServer({ logger: makeLogger() })
  })
  afterEach(async () => {
    await server.stop()
  })

  it('resolves as soon as the manager re-registers the broker', async () => {
    const pending = server.waitForBroker('101/high', 2_000)
    // The respawned manager re-registers a moment later — the same call it
    // already makes for every broker it rebuilds.
    setTimeout(() => {
      server.registerBroker('101/high', makeMockBroker())
    }, 50)
    await expect(pending).resolves.not.toBeNull()
  })

  it('answers immediately when the broker is already there', async () => {
    server.registerBroker('101/high', makeMockBroker())
    const started = Date.now()
    await expect(server.waitForBroker('101/high', 5_000)).resolves.not.toBeNull()
    expect(Date.now() - started).toBeLessThan(50)
  })

  it('gives up on the deadline — a stream that really is gone must still fail', async () => {
    const started = Date.now()
    await expect(server.waitForBroker('101/high', 120)).resolves.toBeNull()
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)
  })

  it('a waiter for ANOTHER broker is not woken by an unrelated registration', async () => {
    const pending = server.waitForBroker('101/high', 250)
    server.registerBroker('102/low', makeMockBroker())
    await expect(pending).resolves.toBeNull()
  })
})
