/**
 * `setEnsureAdaptiveTierBrokerHook` — the Task 4 delicate wiring.
 *
 * `setupSessionForBroker` optionally awaits an injected hook, for ADAPTIVE
 * streams only, right after `resolveHints` is computed and BEFORE
 * `resolveBrokerId` runs. The hook lets the manager ensure a remote node's
 * adaptive-tier broker is registered locally before resolution looks it up
 * (Task 3's `ensureRemoteAdaptiveTierBroker`).
 *
 * These tests guard the four contracts from the task brief:
 *  (a) hook UNSET → behaviour unchanged (regression guard).
 *  (b) hook set + NON-adaptive (pinned) stream → hook NEVER called.
 *  (c) hook set + adaptive stream + a recorded `adaptiveIntent` → hook
 *      called with the intent's `prefersTier`.
 *  (d) hook set + adaptive stream + no intent → hook called with
 *      `hints.prefersTier ?? 'low'`.
 *
 * Does NOT touch `AdaptiveController` / `switchSessionTier` / `startAdaptive`
 * / `selectBestBroker` — `handleOffer`'s `sessionId` opt is used only to
 * plant a pre-existing `adaptiveIntent` entry directly on the private map
 * (mirroring the private-field access pattern already used in
 * `webrtc-server-late-wiring.spec.ts`), never by driving a real tier switch.
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

// ── Minimal AdaptiveSession mock (avoids loading werift) ──────────────────
// Mirrors broker-webrtc-server.spec.ts's mock, plus a `handleOffer` stub —
// needed here because intent-path tests (c) drive the WHEP-style
// `handleOffer` flow (the only public entry point that accepts a
// caller-supplied `sessionId`, which `adaptiveIntent` is keyed by).
vi.mock('../webrtc/session.js', () => {
  class MockAdaptiveSession {
    static readonly ADAPTIVE_LOW_MTU = 900
    static readonly H264_REPACKETIZER_MTU = 1100
    readonly sessionId: string
    readonly deviceId: number
    readonly source: AsyncGenerator<unknown>
    onClosed: (() => void) | null = null
    onConnected: (() => void) | null = null
    forceRelayOnly = false
    pendingRenegotiation: { target: unknown; epoch: number } | null = null
    private _closed = false

    constructor(options: { sessionId: string; deviceId: number; source: AsyncGenerator<unknown> }) {
      this.sessionId = options.sessionId
      this.deviceId = options.deviceId
      this.source = options.source
    }

    readNominatedPair() {
      return null
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

    forwardSourceRtpVideo(_rtp: Buffer) {
      /* no-op */
    }

    async createOffer() {
      return { sdp: `v=0\r\no=- ${this.sessionId} 0 IN IP4 127.0.0.1\r\n`, type: 'offer' as const }
    }

    async handleOffer(
      _clientOffer: { sdp: string; type: 'offer' },
      _opts?: { nonTrickle?: boolean },
    ) {
      return { sdp: `v=0\r\no=- ${this.sessionId} 0 IN IP4 127.0.0.1\r\n`, type: 'answer' as const }
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

// ── Helpers ─────────────────────────────────────────────────────────────

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

function makeMockBroker(bitrateKbps = 2000): IStreamBroker {
  const listeners = new Set<(packet: EncodedPacket) => void>()
  const stats: BrokerStats = {
    status: 'streaming',
    inputFps: 30,
    encodedSubscribers: 0,
    uptimeMs: 60_000,
    bitrateKbps,
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
  return {
    getStats: () => stats,
    getPreBuffer: () => [],
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
    updateConsumerAttributionBySession: (): boolean => true,
    getSdpParameterSets: (): ReadonlyArray<Buffer> | null => null,
    onSdpParameterSets: (_cb: (ps: ReadonlyArray<Buffer>) => void): Unsubscribe => {
      return () => {
        /* no-op */
      }
    },
    onSourceRestart: (_cb: (reason: string) => void): Unsubscribe => {
      return () => {
        /* no-op */
      }
    },
    getSourceType: (): string | null => 'rtsp',
    isRtpSource: (): boolean => true,
  } as unknown as IStreamBroker
}

/** Reach the private `adaptiveIntent` map the same way the late-wiring
 * spec reaches other private fields — a narrow `unknown` cast, never a
 * production cast. Used only to PLANT a pre-existing intent; the
 * tier-switch machinery that normally writes it is never exercised. */
function plantAdaptiveIntent(
  server: BrokerWebrtcServer,
  sessionId: string,
  prefersTier: 'high' | 'mid' | 'low',
): void {
  const map = (
    server as unknown as {
      adaptiveIntent: Map<string, { prefersTier: string; forceTranscodeDown: boolean }>
    }
  ).adaptiveIntent
  map.set(sessionId, { prefersTier, forceTranscodeDown: false })
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('BrokerWebrtcServer — setEnsureAdaptiveTierBrokerHook', () => {
  let logger: IScopedLogger
  let server: BrokerWebrtcServer

  beforeEach(() => {
    logger = makeLogger()
    server = new BrokerWebrtcServer({ logger })
    server.setProfileTierResolver((brokerId) => {
      const idx = brokerId.lastIndexOf('/')
      if (idx < 0) return null
      const tail = brokerId.slice(idx + 1)
      if (tail === 'high' || tail === 'mid' || tail === 'low') return tail
      return null
    })
  })

  afterEach(async () => {
    await server.stop()
  })

  it('(a) hook UNSET — adaptive resolution is unchanged (regression guard)', async () => {
    server.registerBroker('5/high', makeMockBroker())
    server.registerBroker('5/mid', makeMockBroker())

    const { sessionId } = await server.createSession('5/adaptive')
    expect(sessionId).toBeTruthy()

    const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls
    const created = infoCalls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('session created'),
    )
    const meta = (created?.[1] as Record<string, unknown>)?.meta as Record<string, unknown>
    expect(meta?.brokerId).toBe('5/mid')
  })

  it('(b) hook set + NON-adaptive (pinned) stream — hook is NEVER called', async () => {
    const hook = vi.fn().mockResolvedValue(undefined)
    server.setEnsureAdaptiveTierBrokerHook(hook)
    server.registerBroker('5/high', makeMockBroker())

    await server.createSession('5/high')

    expect(hook).not.toHaveBeenCalled()
  })

  it('(c) hook set + adaptive stream + intent present — called with intent.prefersTier', async () => {
    const hook = vi.fn().mockResolvedValue(undefined)
    server.setEnsureAdaptiveTierBrokerHook(hook)
    server.registerBroker('5/high', makeMockBroker())
    server.registerBroker('5/low', makeMockBroker())

    const sessionId = 'preexisting-session-1'
    plantAdaptiveIntent(server, sessionId, 'low')

    await server.handleOffer('5/adaptive', 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n', undefined, {
      sessionId,
    })

    expect(hook).toHaveBeenCalledWith(5, 'low')
  })

  it('(d) hook set + adaptive stream + no intent — called with hints.prefersTier ?? "high"', async () => {
    const hook = vi.fn().mockResolvedValue(undefined)
    server.setEnsureAdaptiveTierBrokerHook(hook)
    server.registerBroker('5/mid', makeMockBroker())

    await server.createSession('5/adaptive', { prefersTier: 'mid' })

    expect(hook).toHaveBeenCalledWith(5, 'mid')
  })

  it('(d) hook set + adaptive stream + no intent + no hints — called with "low"', async () => {
    const hook = vi.fn().mockResolvedValue(undefined)
    server.setEnsureAdaptiveTierBrokerHook(hook)
    server.registerBroker('5/high', makeMockBroker())

    await server.createSession('5/adaptive')

    expect(hook).toHaveBeenCalledWith(5, 'low')
  })

  it('a rejected hook surfaces as a session-setup error, not an unhandled rejection', async () => {
    const hook = vi.fn().mockRejectedValue(new Error('remote node unreachable'))
    server.setEnsureAdaptiveTierBrokerHook(hook)
    server.registerBroker('5/high', makeMockBroker())

    await expect(server.createSession('5/adaptive')).rejects.toThrow(/remote node unreachable/)
  })
})
