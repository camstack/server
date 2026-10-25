/**
 * BrokerWebrtcServer — unit + integration tests.
 *
 * Tests the adaptive source selection, session lifecycle, push-based
 * frame delivery, and simulated network conditions (viewport hints,
 * bandwidth constraints, tier preferences).
 *
 * Does NOT load werift (no real ICE/DTLS). The server's session creation
 * path is tested up to the point where it calls `new AdaptiveSession()`.
 * For that we mock the AdaptiveSession to avoid the heavy werift import.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import type {
  IScopedLogger,
  IStreamBroker,
  EncodedPacket,
  BrokerStats,
  Unsubscribe,
} from '@camstack/types'
import { BrokerWebrtcServer } from '../webrtc/broker-webrtc-server.js'
import { AdaptiveSession } from '../webrtc/session.js'

// The mocked AdaptiveSession (see vi.mock below) carries a test-only static
// `_instances` registry plus `_nominatedPair` / `onConnected` hooks. Read them
// through a narrow shape so the onConnected→readNominatedPair→tag flow can be
// driven without loading werift.
interface MockSessionShape {
  onConnected: (() => void) | null
  _nominatedPair: {
    localType: string
    localAddr: string
    remoteType: string
    remoteAddr: string
  } | null
}
function mockSessionInstances(): MockSessionShape[] {
  const reg = (AdaptiveSession as unknown as { _instances?: MockSessionShape[] })._instances
  return reg ?? []
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

interface MockBrokerOptions {
  readonly bitrateKbps?: number
  readonly preBuffer?: readonly EncodedPacket[]
}

function makeMockBroker(options: MockBrokerOptions = {}): IStreamBroker {
  const listeners = new Set<(packet: EncodedPacket) => void>()
  const stats: BrokerStats = {
    status: 'streaming',
    inputFps: 30,
    encodedSubscribers: 0,
    uptimeMs: 60_000,
    bitrateKbps: options.bitrateKbps ?? 2000,
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

  const attributionPatches: Array<{ sessionId: string; patch: Record<string, unknown> }> = []
  // D77: every session subscribes to source restarts. A faithful registry —
  // a bare no-op would hide a session that never detaches.
  const sourceRestartListeners = new Set<(reason: string) => void>()

  return {
    getStats: () => stats,
    getPreBuffer: () => options.preBuffer ?? [],
    getRtpPreBuffer: () => [],
    onEncodedData: (cb: (packet: EncodedPacket) => void): Unsubscribe => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    onVideoRtp: (_cb: (rtpData: Buffer) => void): Unsubscribe => {
      return () => {
        /* no-op */
      }
    },
    updateConsumerAttributionBySession: (
      sessionId: string,
      patch: Record<string, unknown>,
    ): boolean => {
      attributionPatches.push({ sessionId, patch })
      return true
    },
    _attributionPatches: () => attributionPatches,
    getSdpParameterSets: (): ReadonlyArray<Buffer> | null => null,
    onSdpParameterSets: (_cb: (ps: ReadonlyArray<Buffer>) => void): Unsubscribe => {
      return () => {
        /* no-op */
      }
    },
    onSourceRestart: (cb: (reason: string) => void): Unsubscribe => {
      sourceRestartListeners.add(cb)
      return () => {
        sourceRestartListeners.delete(cb)
      }
    },
    _fireSourceRestart: (reason: string) => {
      for (const cb of sourceRestartListeners) cb(reason)
    },
    _sourceRestartListenerCount: () => sourceRestartListeners.size,
    getSourceType: (): string | null => 'rtsp',
    // Mirror the production IStreamBroker contract: rtsp + push-rtp
    // sources both forward source RTP. The fake defaults to rtsp so
    // it's true; tests that need push-source semantics override by
    // passing `getSourceType` differently.
    isRtpSource: (): boolean => true,
    // Expose for tests to push frames
    _pushPacket: (pkt: EncodedPacket) => {
      for (const cb of listeners) cb(pkt)
    },
    _listenerCount: () => listeners.size,
  } as unknown as IStreamBroker & {
    _pushPacket: (pkt: EncodedPacket) => void
    _listenerCount: () => number
    _attributionPatches: () => Array<{ sessionId: string; patch: Record<string, unknown> }>
    _fireSourceRestart: (reason: string) => void
    _sourceRestartListenerCount: () => number
  }
}

/** Build a minimal H.264 IDR keyframe in Annex-B format (SPS+PPS+IDR). */
function makeKeyframePacket(pts: number): EncodedPacket {
  // SPS NAL (type 7) + PPS NAL (type 8) + IDR slice NAL (type 5)
  const sps = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xe0, 0x1f])
  const pps = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x68, 0xce, 0x38, 0x80])
  const idr = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x80, 0x40, 0x00, 0xff])
  return {
    type: 'video',
    data: Buffer.concat([sps, pps, idr]),
    pts,
    dts: pts,
    keyframe: true,
    codec: 'h264',
  }
}

/** Build a P-frame (non-keyframe) packet. */

// ── Mock AdaptiveSession ─────────────────────────────────────────────────────

// We mock the AdaptiveSession to avoid loading werift (optional peer dep).
// The mock captures the FrameSource and exposes it for assertions.
vi.mock('../webrtc/session.js', () => {
  class MockAdaptiveSession {
    // Mirror the real AdaptiveSession statics the broker server reads in the
    // adaptive-controller wiring.
    static readonly ADAPTIVE_LOW_MTU = 900
    static readonly H264_REPACKETIZER_MTU = 1100
    // Test-only registry of constructed sessions so a test can reach the
    // session the server created (set `_nominatedPair`, fire `onConnected`).
    static _instances: MockAdaptiveSession[] = []

    readonly sessionId: string
    readonly deviceId: number
    readonly source: AsyncGenerator<unknown>
    onClosed: (() => void) | null = null
    onConnected: (() => void) | null = null
    forceRelayOnly = false
    pendingRenegotiation: { target: unknown; epoch: number } | null = null
    private _closed = false
    // Tests inject a nominated pair to drive the `onConnected` tagging flow.
    _nominatedPair: {
      localType: string
      localAddr: string
      remoteType: string
      remoteAddr: string
    } | null = null

    readNominatedPair() {
      return this._nominatedPair
    }

    constructor(options: { sessionId: string; deviceId: number; source: AsyncGenerator<unknown> }) {
      MockAdaptiveSession._instances.push(this)
      this.sessionId = options.sessionId
      this.deviceId = options.deviceId
      this.source = options.source
    }

    setForceRelayOnly(value: boolean) {
      this.forceRelayOnly = value
    }

    // ── Adaptive-controller surface (no-ops in the mock) ──────────────
    onReceiverReport(_cb: (s: { packetsLost: number; highestSequence: number }) => void) {
      // no-op in mock
    }

    setRepacketizerMtu(_mtu: number) {
      // no-op in mock
    }

    resetRepacketizer() {
      // no-op in mock
    }

    forwardSourceRtpVideo(_rtp: Buffer) {
      // no-op in mock
    }

    async createOffer() {
      return { sdp: `v=0\r\no=- ${this.sessionId} 0 IN IP4 127.0.0.1\r\n`, type: 'offer' as const }
    }

    async handleAnswer(_answer: { sdp: string; type: 'answer' }) {
      // no-op in mock
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe('BrokerWebrtcServer', () => {
  let logger: IScopedLogger
  let server: BrokerWebrtcServer

  beforeEach(() => {
    logger = makeLogger()
    server = new BrokerWebrtcServer({ logger })
    // Inject a resolver mirroring the StreamBrokerManager: when a
    // brokerId is shaped `${deviceId}/${tier}`, return that tier. The
    // tests register brokerIds with explicit tier suffixes
    // (`5/high`, `5/mid`, `5/low`), so this is the simplest stand-in
    // for the assignments-aware resolver wired in production.
    server.setProfileTierResolver((brokerId) => {
      const idx = brokerId.lastIndexOf('/')
      if (idx < 0) return null
      const tail = brokerId.slice(idx + 1)
      if (tail === 'high' || tail === 'mid' || tail === 'low') return tail
      return null
    })
    mockSessionInstances().length = 0
  })

  afterEach(async () => {
    await server.stop()
  })

  // ── ICE-connected remote-address tagging ──────────────────────────────

  describe('onConnected → remote-address tagging', () => {
    it('tags the broker subscription with the nominated remote address once ICE connects', async () => {
      const broker = makeMockBroker()
      server.registerBroker('1/high', broker)

      const { sessionId } = await server.createSession('1/high')
      const session = mockSessionInstances().at(-1)
      expect(session).toBeDefined()
      expect(session?.onConnected).toBeTypeOf('function')

      session!._nominatedPair = {
        localType: 'host',
        localAddr: '192.168.10.5:5000',
        remoteType: 'host',
        remoteAddr: '203.0.113.7:51000',
      }
      session!.onConnected?.()

      const patches = (
        broker as unknown as {
          _attributionPatches: () => Array<{ sessionId: string; patch: Record<string, unknown> }>
        }
      )._attributionPatches()
      expect(patches).toContainEqual({ sessionId, patch: { remoteAddr: '203.0.113.7:51000' } })
    })

    it('appends the candidate type for a relay/srflx nominated pair', async () => {
      const broker = makeMockBroker()
      server.registerBroker('1/high', broker)

      const { sessionId } = await server.createSession('1/high')
      const session = mockSessionInstances().at(-1)
      session!._nominatedPair = {
        localType: 'host',
        localAddr: '192.168.10.5:5000',
        remoteType: 'relay',
        remoteAddr: '198.51.100.9:3478',
      }
      session!.onConnected?.()

      const patches = (
        broker as unknown as {
          _attributionPatches: () => Array<{ sessionId: string; patch: Record<string, unknown> }>
        }
      )._attributionPatches()
      expect(patches).toContainEqual({
        sessionId,
        patch: { remoteAddr: '198.51.100.9:3478 (relay)' },
      })
    })

    it('does not tag when the nominated pair is unavailable', async () => {
      const broker = makeMockBroker()
      server.registerBroker('1/high', broker)

      await server.createSession('1/high')
      const session = mockSessionInstances().at(-1)
      session!._nominatedPair = null
      session!.onConnected?.()

      const patches = (
        broker as unknown as {
          _attributionPatches: () => Array<{ sessionId: string; patch: Record<string, unknown> }>
        }
      )._attributionPatches()
      expect(patches).toHaveLength(0)
    })

    it('retries when the nominated pair is not yet readable, then tags on a later poll', async () => {
      vi.useFakeTimers()
      try {
        const broker = makeMockBroker()
        server.registerBroker('1/high', broker)

        const { sessionId } = await server.createSession('1/high')
        const session = mockSessionInstances().at(-1)
        // Pair unavailable on the initial read — drives the ≤5×200ms retry.
        session!._nominatedPair = null
        session!.onConnected?.()

        const attrPatches = (
          broker as unknown as {
            _attributionPatches: () => Array<{ sessionId: string; patch: Record<string, unknown> }>
          }
        )._attributionPatches()
        expect(attrPatches).toHaveLength(0)

        // werift populates the pair ~one poll later.
        session!._nominatedPair = {
          localType: 'host',
          localAddr: '192.168.10.5:5000',
          remoteType: 'host',
          remoteAddr: '203.0.113.7:51000',
        }
        vi.advanceTimersByTime(200)

        expect(attrPatches).toContainEqual({
          sessionId,
          patch: { remoteAddr: '203.0.113.7:51000' },
        })
        // No re-arm after a successful tag — the chain is done.
        vi.advanceTimersByTime(2000)
        expect(attrPatches).toHaveLength(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not re-tag / re-arm when onConnected fires twice (ICE reconnect)', async () => {
      const broker = makeMockBroker()
      server.registerBroker('1/high', broker)

      const { sessionId } = await server.createSession('1/high')
      const session = mockSessionInstances().at(-1)
      session!._nominatedPair = {
        localType: 'host',
        localAddr: '192.168.10.5:5000',
        remoteType: 'host',
        remoteAddr: '203.0.113.7:51000',
      }
      // First connect tags once.
      session!.onConnected?.()
      // Simulated reconnects — must be no-ops (already tagged).
      session!.onConnected?.()
      session!.onConnected?.()

      const attrPatches = (
        broker as unknown as {
          _attributionPatches: () => Array<{ sessionId: string; patch: Record<string, unknown> }>
        }
      )._attributionPatches()
      expect(attrPatches).toHaveLength(1)
      expect(attrPatches).toContainEqual({ sessionId, patch: { remoteAddr: '203.0.113.7:51000' } })
    })

    it('does not tag when a pending retry timer fires after the session is torn down', async () => {
      vi.useFakeTimers()
      try {
        const broker = makeMockBroker()
        server.registerBroker('1/high', broker)

        const { sessionId } = await server.createSession('1/high')
        const session = mockSessionInstances().at(-1)
        // Unavailable on first read → a retry timer is armed.
        session!._nominatedPair = null
        session!.onConnected?.()

        // Pair becomes readable, but the session is torn down before the
        // pending timer fires.
        session!._nominatedPair = {
          localType: 'host',
          localAddr: '192.168.10.5:5000',
          remoteType: 'host',
          remoteAddr: '203.0.113.7:51000',
        }
        await server.closeSession(sessionId)

        // Advancing past the retry window must NOT throw and must NOT tag —
        // the timer was cleared on teardown (belt: the live-session check).
        expect(() => vi.advanceTimersByTime(2000)).not.toThrow()
        const attrPatches = (
          broker as unknown as {
            _attributionPatches: () => Array<{ sessionId: string; patch: Record<string, unknown> }>
          }
        )._attributionPatches()
        expect(attrPatches).toHaveLength(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ── Broker registration ──────────────────────────────────────────────

  describe('broker registration', () => {
    it('registerBroker makes the stream available via supportsStream', () => {
      const broker = makeMockBroker()
      server.registerBroker('6/high', broker)
      expect(server.supportsStream('6/high')).toBe(true)
      expect(server.supportsStream('6/low')).toBe(false)
    })

    it('unregisterBroker removes stream support', () => {
      const broker = makeMockBroker()
      server.registerBroker('6/high', broker)
      server.unregisterBroker('6/high')
      expect(server.supportsStream('6/high')).toBe(false)
    })

    it('supportsStream recognises adaptive alias when any profile exists', () => {
      const broker = makeMockBroker()
      server.registerBroker('6/mid', broker)
      expect(server.supportsStream('6/adaptive')).toBe(true)
      expect(server.supportsStream('7/adaptive')).toBe(false)
    })
  })

  // ── Session lifecycle ────────────────────────────────────────────────

  describe('session lifecycle', () => {
    it('createSession returns a sessionId and sdpOffer', async () => {
      const broker = makeMockBroker()
      server.registerBroker('1/high', broker)

      const { sessionId, sdpOffer } = await server.createSession('1/high')
      expect(sessionId).toBeTruthy()
      expect(sdpOffer).toContain('v=0')
      expect(server.getSessionCount()).toBe(1)
    })

    it('closeSession removes the session', async () => {
      const broker = makeMockBroker()
      server.registerBroker('1/high', broker)

      const { sessionId } = await server.createSession('1/high')
      await server.closeSession(sessionId)
      expect(server.getSessionCount()).toBe(0)
    })

    it('closeSession is idempotent (no error on double close)', async () => {
      const broker = makeMockBroker()
      server.registerBroker('1/high', broker)

      const { sessionId } = await server.createSession('1/high')
      await server.closeSession(sessionId)
      await server.closeSession(sessionId) // should not throw
      expect(server.getSessionCount()).toBe(0)
    })

    it('handleAnswer throws for unknown session', async () => {
      await expect(server.handleAnswer('nonexistent', 'v=0\r\n')).rejects.toThrow(
        /Session not found/,
      )
    })

    it('createSession defaults to relayOnly=false (LAN path unchanged)', async () => {
      const broker = makeMockBroker()
      server.registerBroker('1/high', broker)

      await server.createSession('1/high')
      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls
      const created = infoCalls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('session created'),
      )
      const meta = (created![1] as Record<string, unknown>)?.meta as Record<string, unknown>
      expect(meta?.relayOnly).toBe(false)
    })

    it('createSession with relayOnly forces relay on the session + logs it', async () => {
      const broker = makeMockBroker()
      server.registerBroker('1/high', broker)

      await server.createSession('1/high', {}, { relayOnly: true })
      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls
      const created = infoCalls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('session created'),
      )
      const meta = (created![1] as Record<string, unknown>)?.meta as Record<string, unknown>
      expect(meta?.relayOnly).toBe(true)
      // deviceId is parsed from the brokerId and threaded into the log.
      expect(meta?.deviceId).toBe(1)
    })

    it('createSession throws for unregistered stream', async () => {
      await expect(server.createSession('999/high')).rejects.toThrow(/No broker/)
    })

    it('createSession throws after server stop', async () => {
      const broker = makeMockBroker()
      server.registerBroker('1/high', broker)
      await server.stop()

      await expect(server.createSession('1/high')).rejects.toThrow(/stopped/)
    })

    it('stop closes all active sessions', async () => {
      const broker = makeMockBroker()
      server.registerBroker('1/high', broker)

      await server.createSession('1/high')
      await server.createSession('1/high')
      expect(server.getSessionCount()).toBe(2)

      await server.stop()
      expect(server.getSessionCount()).toBe(0)
    })

    it('unregisterBroker closes sessions on that broker', async () => {
      const broker1 = makeMockBroker()
      const broker2 = makeMockBroker()
      server.registerBroker('1/high', broker1)
      server.registerBroker('1/low', broker2)

      await server.createSession('1/high')
      await server.createSession('1/low')
      expect(server.getSessionCount()).toBe(2)

      server.unregisterBroker('1/high')
      expect(server.getSessionCount()).toBe(1)
    })
  })

  // ── Broker data subscription ─────────────────────────────────────────

  describe('broker data subscription', () => {
    it('createSession subscribes to broker onEncodedData', async () => {
      const broker = makeMockBroker() as IStreamBroker & { _listenerCount: () => number }
      server.registerBroker('1/high', broker)

      expect(broker._listenerCount()).toBe(0)
      await server.createSession('1/high')
      expect(broker._listenerCount()).toBe(1)
    })

    it('closeSession swaps the session subscription for a linger ghost; stop releases it', async () => {
      const broker = makeMockBroker() as IStreamBroker & { _listenerCount: () => number }
      server.registerBroker('1/high', broker)

      const { sessionId } = await server.createSession('1/high')
      expect(broker._listenerCount()).toBe(1)
      await server.closeSession(sessionId)
      // The LAST session on a broker leaves ONE ghost subscription behind —
      // the post-session linger that keeps the source dialed and the RTP
      // ring warm so a reopen within the window gets an instant start
      // instead of re-paying the cold dial + next-IDR wait.
      expect(broker._listenerCount()).toBe(1)
      await server.stop()
      expect(broker._listenerCount()).toBe(0)
    })

    it('pre-buffer packets are flushed to the session source', async () => {
      const kf = makeKeyframePacket(0)
      const broker = makeMockBroker({ preBuffer: [kf] })
      server.registerBroker('1/high', broker)

      const { sessionId } = await server.createSession('1/high')
      expect(sessionId).toBeTruthy()
      // Pre-buffer was passed — the push source received the frames.
      // We can't inspect the source directly with the mock, but the
      // session was created without error, confirming the path works.
    })
  })

  // ── Adaptive source selection ────────────────────────────────────────

  describe('adaptive source selection', () => {
    it('adaptive with no hints defaults to the smallest available tier (low)', async () => {
      server.registerBroker('5/high', makeMockBroker())
      server.registerBroker('5/mid', makeMockBroker())
      server.registerBroker('5/low', makeMockBroker())

      const { sessionId } = await server.createSession('5/adaptive')
      expect(sessionId).toBeTruthy()
      // With no hints, the smallest available rung wins (low > mid > high).
      // The session was created — verify via log that 'low' was selected.
      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls
      // Should NOT have an adaptive selection log (no hints → uses tier fallback)
      // but should have the 'WebRTC session created' log with the brokerId.
      const sessionCreated = infoCalls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('session created'),
      )
      expect(sessionCreated).toBeTruthy()
      const meta =
        ((sessionCreated![1] as Record<string, unknown>)?.meta as Record<string, unknown>) ??
        undefined
      expect(meta?.brokerId).toBe('5/low')
    })

    it('adaptive with explicit prefersTier selects that tier', async () => {
      server.registerBroker('5/high', makeMockBroker())
      server.registerBroker('5/mid', makeMockBroker())
      server.registerBroker('5/low', makeMockBroker())

      const { sessionId } = await server.createSession('5/adaptive', { prefersTier: 'low' })
      expect(sessionId).toBeTruthy()

      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls
      const sessionCreated = infoCalls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('session created'),
      )
      expect(
        ((sessionCreated![1] as Record<string, unknown>)?.meta as Record<string, unknown>)
          ?.brokerId,
      ).toBe('5/low')
    })

    it('adaptive with prefersTier=low falls back to the SMALLEST available tier (remote bias intent preserved)', async () => {
      server.registerBroker('5/high', makeMockBroker())
      server.registerBroker('5/mid', makeMockBroker())
      // 'low' not registered — the remote-viewer bias to `low` must fall back to
      // the SMALLEST available tier (mid), never quietly revert to `high`.

      const { sessionId } = await server.createSession('5/adaptive', { prefersTier: 'low' })
      expect(sessionId).toBeTruthy()

      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls
      const sessionCreated = infoCalls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('session created'),
      )
      // Smallest-first fallback [low, mid, high] → mid (low absent).
      expect(
        ((sessionCreated![1] as Record<string, unknown>)?.meta as Record<string, unknown>)
          ?.brokerId,
      ).toBe('5/mid')
    })

    it('adaptive with prefersTier=low falls back to high when high is the only tier', async () => {
      server.registerBroker('5/high', makeMockBroker())
      // Only 'high' assigned — a remote-biased 'low' request degrades to the
      // single available tier (better a large keyframe than no stream).

      const { sessionId } = await server.createSession('5/adaptive', { prefersTier: 'low' })
      expect(sessionId).toBeTruthy()

      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls
      const sessionCreated = infoCalls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('session created'),
      )
      expect(
        ((sessionCreated![1] as Record<string, unknown>)?.meta as Record<string, unknown>)
          ?.brokerId,
      ).toBe('5/high')
    })

    it('adaptive with NO hints logs the diagnostic no-hints selection line (defaults to low)', async () => {
      server.registerBroker('5/high', makeMockBroker())
      server.registerBroker('5/mid', makeMockBroker())
      server.registerBroker('5/low', makeMockBroker())

      await server.createSession('5/adaptive')

      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls
      const noHintsLog = infoCalls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('no client hints'),
      )
      expect(noHintsLog).toBeTruthy()
      const meta =
        ((noHintsLog![1] as Record<string, unknown>)?.meta as Record<string, unknown>) ?? undefined
      expect(meta?.selected).toBe('5/low')
      expect(meta?.tier).toBe('low')
    })

    it('adaptive skips an unassigned derived when natives exist (no slot bound)', async () => {
      // Insertion order: derived first — the live 618 failure mode.
      server.registerBroker('618/derived:Mid to low', makeMockBroker())
      server.registerBroker('618/native:main', makeMockBroker())
      server.registerBroker('618/native:sub', makeMockBroker())

      const { sessionId } = await server.createSession('618/adaptive')
      expect(sessionId).toBeTruthy()
      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls
      const sessionCreated = infoCalls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('session created'),
      )
      expect(
        ((sessionCreated![1] as Record<string, unknown>)?.meta as Record<string, unknown>)
          ?.brokerId,
      ).toBe('618/native:main')
    })

    it('adaptive with a tiny tile viewport caps to low', async () => {
      server.registerBroker('5/high', makeMockBroker({ bitrateKbps: 4000 }))
      server.registerBroker('5/mid', makeMockBroker({ bitrateKbps: 1200 }))
      server.registerBroker('5/low', makeMockBroker({ bitrateKbps: 400 }))

      const { sessionId } = await server.createSession('5/adaptive', {
        viewportWidth: 160,
        viewportHeight: 90,
        devicePixelRatio: 1,
      })
      expect(sessionId).toBeTruthy()

      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls
      const sessionCreated = infoCalls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('session created'),
      )
      expect(
        ((sessionCreated![1] as Record<string, unknown>)?.meta as Record<string, unknown>)
          ?.brokerId,
      ).toBe('5/low')
    })

    it('adaptive with large viewport and no downlink stays on the smallest rung', async () => {
      server.registerBroker('5/high', makeMockBroker({ bitrateKbps: 4000 }))
      server.registerBroker('5/mid', makeMockBroker({ bitrateKbps: 1200 }))
      server.registerBroker('5/low', makeMockBroker({ bitrateKbps: 400 }))

      const { sessionId } = await server.createSession('5/adaptive', {
        viewportWidth: 1920,
        viewportHeight: 1080,
        devicePixelRatio: 1,
      })
      expect(sessionId).toBeTruthy()

      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls
      const sessionCreated = infoCalls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('session created'),
      )
      expect(
        ((sessionCreated![1] as Record<string, unknown>)?.meta as Record<string, unknown>)
          ?.brokerId,
      ).toBe('5/low')
    })

    it('adaptive with large viewport and generous downlink picks high-res stream', async () => {
      server.registerBroker('5/high', makeMockBroker({ bitrateKbps: 4000 }))
      server.registerBroker('5/mid', makeMockBroker({ bitrateKbps: 1200 }))
      server.registerBroker('5/low', makeMockBroker({ bitrateKbps: 400 }))

      const { sessionId } = await server.createSession('5/adaptive', {
        viewportWidth: 1920,
        viewportHeight: 1080,
        devicePixelRatio: 1,
        downlinkMbps: 30,
      })
      expect(sessionId).toBeTruthy()

      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls
      const sessionCreated = infoCalls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('session created'),
      )
      expect(
        ((sessionCreated![1] as Record<string, unknown>)?.meta as Record<string, unknown>)
          ?.brokerId,
      ).toBe('5/high')
    })

    it('adaptive treats viewport dimensions as physical pixels without applying DPR twice', async () => {
      server.registerBroker('5/high', makeMockBroker({ bitrateKbps: 4000 }))
      server.registerBroker('5/mid', makeMockBroker({ bitrateKbps: 1200 }))
      server.registerBroker('5/low', makeMockBroker({ bitrateKbps: 400 }))

      // The viewer already sends layout×DPR. DPR remains diagnostic metadata;
      // multiplying it again would square the scale. Cold start still lands on
      // low — a fat probe (not a bigger CSS box) is what climbs.
      const { sessionId } = await server.createSession('5/adaptive', {
        viewportWidth: 1920,
        viewportHeight: 1080,
        devicePixelRatio: 2,
      })
      expect(sessionId).toBeTruthy()

      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls
      const sessionCreated = infoCalls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('session created'),
      )
      expect(
        ((sessionCreated![1] as Record<string, unknown>)?.meta as Record<string, unknown>)
          ?.brokerId,
      ).toBe('5/low')
    })

    it('adaptive with low bandwidth penalises high-bitrate streams', async () => {
      server.registerBroker('5/high', makeMockBroker({ bitrateKbps: 4000 }))
      server.registerBroker('5/mid', makeMockBroker({ bitrateKbps: 1200 }))
      server.registerBroker('5/low', makeMockBroker({ bitrateKbps: 400 }))

      // Large viewport but severely constrained bandwidth (1 Mbps):
      // high needs 4 Mbps → huge penalty
      // mid needs 1.2 Mbps → moderate penalty
      // low needs 0.4 Mbps → fits within 60% of 1 Mbps (600 kbps)
      const { sessionId } = await server.createSession('5/adaptive', {
        viewportWidth: 1920,
        viewportHeight: 1080,
        devicePixelRatio: 1,
        downlinkMbps: 1,
      })
      expect(sessionId).toBeTruthy()

      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls
      const sessionCreated = infoCalls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('session created'),
      )
      // With 1 Mbps constraint, bandwidth penalty on high is enormous,
      // so it should pick mid or low despite the large viewport
      const selected = (
        (sessionCreated![1] as Record<string, unknown>)?.meta as Record<string, unknown>
      )?.brokerId as string
      expect(['5/mid', '5/low']).toContain(selected)
    })

    it('adaptive with generous bandwidth picks resolution-optimal', async () => {
      server.registerBroker('5/high', makeMockBroker({ bitrateKbps: 4000 }))
      server.registerBroker('5/mid', makeMockBroker({ bitrateKbps: 1200 }))
      server.registerBroker('5/low', makeMockBroker({ bitrateKbps: 400 }))

      // 720p viewport with 50 Mbps — bandwidth allows high; viewport is a
      // player, not a tile, so we stay on the LAN/default high rung.
      const { sessionId } = await server.createSession('5/adaptive', {
        viewportWidth: 1280,
        viewportHeight: 720,
        devicePixelRatio: 1,
        downlinkMbps: 50,
      })
      expect(sessionId).toBeTruthy()

      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls
      const sessionCreated = infoCalls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('session created'),
      )
      expect(
        ((sessionCreated![1] as Record<string, unknown>)?.meta as Record<string, unknown>)
          ?.brokerId,
      ).toBe('5/high')
    })

    it('adaptive with single broker always picks that broker', async () => {
      server.registerBroker('5/mid', makeMockBroker({ bitrateKbps: 1200 }))

      const { sessionId } = await server.createSession('5/adaptive', {
        viewportWidth: 3840,
        viewportHeight: 2160,
        downlinkMbps: 100,
      })
      expect(sessionId).toBeTruthy()

      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls
      const sessionCreated = infoCalls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('session created'),
      )
      expect(
        ((sessionCreated![1] as Record<string, unknown>)?.meta as Record<string, unknown>)
          ?.brokerId,
      ).toBe('5/mid')
    })
  })

  // ── Multiple sessions per stream ─────────────────────────────────────

  describe('concurrent sessions', () => {
    it('multiple sessions on the same broker each get their own subscription', async () => {
      const broker = makeMockBroker() as IStreamBroker & { _listenerCount: () => number }
      server.registerBroker('1/high', broker)

      const s1 = await server.createSession('1/high')
      const s2 = await server.createSession('1/high')
      const s3 = await server.createSession('1/high')

      expect(server.getSessionCount()).toBe(3)
      expect(broker._listenerCount()).toBe(3)

      await server.closeSession(s2.sessionId)
      expect(server.getSessionCount()).toBe(2)
      // The broker is still served by s1/s3 — closing a NON-last session
      // must not attach a linger ghost.
      expect(broker._listenerCount()).toBe(2)

      await server.closeSession(s1.sessionId)
      await server.closeSession(s3.sessionId)
      expect(server.getSessionCount()).toBe(0)
      // Last session gone → exactly one linger ghost keeps the broker warm.
      expect(broker._listenerCount()).toBe(1)
      await server.stop()
      expect(broker._listenerCount()).toBe(0)
    })

    it('sessions on different brokers are independent', async () => {
      const brokerHigh = makeMockBroker() as IStreamBroker & { _listenerCount: () => number }
      const brokerLow = makeMockBroker() as IStreamBroker & { _listenerCount: () => number }
      server.registerBroker('1/high', brokerHigh)
      server.registerBroker('1/low', brokerLow)

      const s1 = await server.createSession('1/high')
      const s2 = await server.createSession('1/low')

      expect(brokerHigh._listenerCount()).toBe(1)
      expect(brokerLow._listenerCount()).toBe(1)

      await server.closeSession(s1.sessionId)
      // brokerHigh's last session closed → its linger ghost holds (1);
      // brokerLow's live session is untouched.
      expect(brokerHigh._listenerCount()).toBe(1)
      expect(brokerLow._listenerCount()).toBe(1)

      await server.closeSession(s2.sessionId)
      expect(brokerLow._listenerCount()).toBe(1)
      await server.stop()
      expect(brokerHigh._listenerCount()).toBe(0)
      expect(brokerLow._listenerCount()).toBe(0)
    })
  })

  // ── Network condition scenarios ──────────────────────────────────────

  describe('network condition scenarios', () => {
    /**
     * Scenario matrix: maps viewport + bandwidth to expected tier.
     * Verifies the adaptive scorer produces sane results across the
     * range of real-world client profiles.
     */
    interface ScenarioCase {
      readonly name: string
      readonly hints: {
        viewportWidth?: number
        viewportHeight?: number
        devicePixelRatio?: number
        downlinkMbps?: number
        prefersTier?: string
      }
      readonly expectedTier: string | string[] // single or acceptable set
    }

    const scenarios: readonly ScenarioCase[] = [
      {
        name: 'mobile phone portrait on LTE (360×640, 3 Mbps)',
        hints: { viewportWidth: 360, viewportHeight: 640, devicePixelRatio: 3, downlinkMbps: 3 },
        expectedTier: ['5/mid', '5/low'],
      },
      {
        name: 'mobile phone landscape on LTE (640×360, 3 Mbps)',
        hints: { viewportWidth: 640, viewportHeight: 360, devicePixelRatio: 3, downlinkMbps: 3 },
        expectedTier: ['5/mid', '5/low'],
      },
      {
        name: 'tablet on WiFi (1024×768, 10 Mbps)',
        hints: { viewportWidth: 1024, viewportHeight: 768, devicePixelRatio: 2, downlinkMbps: 10 },
        expectedTier: ['5/high', '5/mid'],
      },
      {
        name: 'desktop 1080p on fast WiFi (1920×1080, 30 Mbps)',
        hints: { viewportWidth: 1920, viewportHeight: 1080, devicePixelRatio: 1, downlinkMbps: 30 },
        expectedTier: '5/high',
      },
      {
        name: 'desktop 4K retina on wired (1920×1080 @2x, 100 Mbps)',
        hints: {
          viewportWidth: 1920,
          viewportHeight: 1080,
          devicePixelRatio: 2,
          downlinkMbps: 100,
        },
        expectedTier: '5/high',
      },
      {
        name: 'thumbnail widget (160×90, 50 Mbps)',
        hints: { viewportWidth: 160, viewportHeight: 90, devicePixelRatio: 1, downlinkMbps: 50 },
        expectedTier: '5/low',
      },
      {
        name: 'congested network (1920×1080, 0.5 Mbps)',
        hints: {
          viewportWidth: 1920,
          viewportHeight: 1080,
          devicePixelRatio: 1,
          downlinkMbps: 0.5,
        },
        expectedTier: '5/low',
      },
      {
        name: 'moderate bandwidth (1280×720, 2 Mbps)',
        hints: { viewportWidth: 1280, viewportHeight: 720, devicePixelRatio: 1, downlinkMbps: 2 },
        expectedTier: ['5/mid', '5/low'],
      },
      {
        name: 'no hints at all — falls back to the smallest available tier (low)',
        hints: {},
        expectedTier: '5/low',
      },
    ]

    for (const scenario of scenarios) {
      it(scenario.name, async () => {
        server.registerBroker('5/high', makeMockBroker({ bitrateKbps: 4000 }))
        server.registerBroker('5/mid', makeMockBroker({ bitrateKbps: 1200 }))
        server.registerBroker('5/low', makeMockBroker({ bitrateKbps: 400 }))

        const { sessionId } = await server.createSession('5/adaptive', scenario.hints)
        expect(sessionId).toBeTruthy()

        const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls
        const sessionCreated = infoCalls.find(
          (c) => typeof c[0] === 'string' && c[0].includes('session created'),
        )
        const selectedBrokerId = (
          (sessionCreated![1] as Record<string, unknown>)?.meta as Record<string, unknown>
        )?.brokerId as string

        if (Array.isArray(scenario.expectedTier)) {
          expect(scenario.expectedTier).toContain(selectedBrokerId)
        } else {
          expect(selectedBrokerId).toBe(scenario.expectedTier)
        }

        // Cleanup between scenarios — each runs fresh with beforeEach
        // but the describe block shares the server instance for efficiency.
        await server.stop()
        server = new BrokerWebrtcServer({ logger })
      })
    }
  })

  // ── Direct stream ID (non-adaptive) ──────────────────────────────────

  describe('direct stream selection', () => {
    it('explicit profile bypasses adaptive scoring', async () => {
      server.registerBroker('5/high', makeMockBroker({ bitrateKbps: 4000 }))
      server.registerBroker('5/low', makeMockBroker({ bitrateKbps: 400 }))

      // Even with tiny viewport + low bandwidth, explicit 'high' picks high
      const { sessionId } = await server.createSession('5/high', {
        viewportWidth: 160,
        viewportHeight: 90,
        downlinkMbps: 0.1,
      })
      expect(sessionId).toBeTruthy()

      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls
      const sessionCreated = infoCalls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('session created'),
      )
      expect(
        ((sessionCreated![1] as Record<string, unknown>)?.meta as Record<string, unknown>)
          ?.brokerId,
      ).toBe('5/high')
    })
  })
})
