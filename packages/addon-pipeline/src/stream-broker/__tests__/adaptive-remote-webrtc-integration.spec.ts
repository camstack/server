/**
 * Slice 3b Task 5 — integration + leak-regression coverage for the adaptive
 * remote-owned WebRTC path wired by Tasks 1-4:
 *
 *   `resolveTierSlot` (T1) → `remoteBrokerTiers` tier-matching (T2) →
 *   `StreamBrokerManager.ensureRemoteAdaptiveTierBroker` (T3) →
 *   `BrokerWebrtcServer.setEnsureAdaptiveTierBrokerHook` wiring (T4).
 *
 * Every prior task's spec exercises ONE layer at a time with the rest
 * mocked out:
 *   - `ensure-remote-adaptive-tier-broker.spec.ts` calls the manager method
 *     directly, never through a real `BrokerWebrtcServer`.
 *   - `broker-webrtc-server-adaptive-tier-hook.spec.ts` calls the real
 *     server with a bare `vi.fn()` hook, never the manager's real
 *     `ensureRemoteAdaptiveTierBroker`.
 *   - `device-scoped-providers.spec.ts`'s "cross-node ingest wiring" block
 *     exercises the real manager end-to-end but with a FULLY MOCKED
 *     `BrokerWebrtcServer` (`createSession: vi.fn()`), and only for
 *     PINNED (`profile`/`cam-stream`) targets — `ensureBrokerForWebrtcSession`
 *     early-returns for `camStreamId === undefined`, i.e. it never touches
 *     the adaptive gap at all.
 *
 * This file is the first spec to wire a REAL `StreamBrokerManager` to a
 * REAL `BrokerWebrtcServer` (only `../webrtc/session.js`'s `AdaptiveSession`
 * is faked, to avoid loading werift — mirrors the Task 4 hook spec) and
 * drive an ADAPTIVE target through the actual `WebrtcSessionProvider`
 * facade entry point, proving the full hook chain resolves a remote-owned
 * device's adaptive stream end-to-end instead of throwing
 * `"No broker for stream"`.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import type {
  AddonApi,
  BrokerStats,
  EncodedPacket,
  IScopedLogger,
  Unsubscribe,
} from '@camstack/types'
import { nodePin } from '@camstack/types'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'
import { WebrtcSessionProvider } from '../device-scoped-providers.js'
import { BrokerWebrtcServer } from '../webrtc/broker-webrtc-server.js'
import type { IStreamBrokerWithSourceProvider } from '../webrtc/remote-encoded-source-broker.js'

// ── Fake the AdaptiveSession werift wrapper (mirrors
// broker-webrtc-server-adaptive-tier-hook.spec.ts's mock verbatim) so the
// real `BrokerWebrtcServer` can run its full session-setup logic (broker
// resolution, the adaptive-tier hook, codec/warm-up detection, subscription
// wiring) without ever touching werift/ICE. ───────────────────────────────
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

// ── Shared helpers (mirror device-scoped-providers.spec.ts /
// ensure-remote-adaptive-tier-broker.spec.ts's fakes) ──────────────────────

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

function stubRtsp(manager: StreamBrokerManager): void {
  ;(manager as unknown as { rtspProvider: unknown }).rtspProvider = {
    getEntry: vi.fn((brokerId: string) => ({
      brokerId,
      url: `rtsp://host/${brokerId}`,
      mutedUrl: '',
      enabled: true,
    })),
    getInternalEntry: vi.fn((brokerId: string) => ({
      brokerId,
      url: `rtsp://host/${brokerId}`,
      mutedUrl: '',
      enabled: true,
    })),
    setEnabled: vi.fn(),
    isEnabled: vi.fn(() => true),
    setTokenPersister: vi.fn(),
    setEnabledPersister: vi.fn(),
    getAllEntries: vi.fn(() => []),
    regenerateToken: vi.fn(),
    getRtspPort: vi.fn(() => 8554),
    persistTokens: vi.fn(),
  }
  ;(manager as unknown as { rtspServer: unknown }).rtspServer = {
    registerRestreamer: vi.fn(),
    unregisterRestreamer: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getPort: vi.fn(() => 8554),
    loadEnabled: vi.fn(),
  }
}

/**
 * Fake inner broker satisfying BOTH surfaces the real path needs:
 *  - `IStreamBrokerWithSourceProvider` (`setSourceProvider`/`onDemandChange`)
 *    — what `RemoteEncodedSourceBroker`/the manager's teardown wiring call.
 *  - The full `IStreamBroker` session-setup surface the REAL
 *    `BrokerWebrtcServer.createSession` calls while resolving codec/warm-up
 *    (`getStats().codec` truthy so the 2.5s real-timer warm-up wait never
 *    fires — mirrors `broker-webrtc-server-adaptive-tier-hook.spec.ts`'s
 *    `makeMockBroker`).
 */
function makeFakeInnerBroker(): {
  broker: IStreamBrokerWithSourceProvider
  fireDemand: (active: boolean) => void
} {
  let observer: ((active: boolean) => void) | null = null
  const listeners = new Set<(packet: EncodedPacket) => void>()
  const sourceRestartListeners = new Set<(reason: string) => void>()
  const stats: BrokerStats = {
    status: 'streaming',
    inputFps: 30,
    encodedSubscribers: 0,
    uptimeMs: 60_000,
    bitrateKbps: 2000,
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
  const broker = {
    deviceId: 'fake',
    status: 'streaming',
    suspended: false,
    setSourceProvider: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onDemandChange: vi.fn((cb: (active: boolean) => void) => {
      observer = cb
      return () => {
        if (observer === cb) observer = null
      }
    }),
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
    onSourceRestart: (cb: (reason: string) => void): Unsubscribe => {
      sourceRestartListeners.add(cb)
      return () => {
        sourceRestartListeners.delete(cb)
      }
    },
    getSourceType: (): string | null => 'rtsp',
    isRtpSource: (): boolean => true,
  } as unknown as IStreamBrokerWithSourceProvider
  return { broker, fireDemand: (active: boolean) => observer?.(active) }
}

describe('Adaptive WebRTC — remote-owned integration + leak regression (Slice 3b Task 5)', () => {
  let server: BrokerWebrtcServer | undefined

  afterEach(async () => {
    await server?.stop()
    server = undefined
  })

  it('integration: adaptive createSession for a REMOTE-owned device resolves through the real hook to a registered tier broker (never "No broker for stream")', async () => {
    const manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    const getIngestOwner = vi
      .fn()
      .mockResolvedValue({ ownerNodeId: 'agent-a', reachableHost: '10.0.0.9' })
    const listAllProfileSlots = vi.fn().mockResolvedValue([
      {
        deviceId: 921,
        profile: 'high',
        brokerId: '921/high',
        sourceCamStreamId: 'main-high',
        status: 'ready',
      },
    ])
    const getStreamWithCodec = vi.fn().mockResolvedValue({
      url: 'rtsp://10.0.0.9:8554/tok-high',
      videoCodec: 'H264',
      audioCodec: 'none',
      resolution: { width: 1920, height: 1080 },
      transcoded: false,
      encoder: 'copy',
      pipelineKey: 'pk-921-high',
    })
    const releaseStreamWithCodec = vi.fn().mockResolvedValue({ released: true, refcount: 0 })
    const api = {
      pipelineOrchestrator: { getIngestOwner: { query: getIngestOwner } },
      streamBroker: {
        listAllProfileSlots: { query: listAllProfileSlots },
        getStreamWithCodec: { mutate: getStreamWithCodec },
        releaseStreamWithCodec: { mutate: releaseStreamWithCodec },
      },
    } as unknown as AddonApi
    manager.setApiAccess(api, 'hub')

    const { broker: fakeInnerBroker } = makeFakeInnerBroker()
    manager.setRemoteEncodedBrokerFactory(() => fakeInnerBroker)

    server = new BrokerWebrtcServer({ logger: makeLogger() })
    const registerBrokerSpy = vi.spyOn(server, 'registerBroker')
    manager.setWebrtcServer(server)

    const facade = new WebrtcSessionProvider(server, manager)

    const result = await facade.createSession({
      deviceId: 921,
      target: { kind: 'adaptive' },
    })

    expect(result.sessionId).toBeTruthy()
    expect(typeof result.sdpOffer).toBe('string')
    expect(getIngestOwner).toHaveBeenCalled()
    expect(listAllProfileSlots).toHaveBeenCalledWith(undefined, nodePin('agent-a'))
    expect(getStreamWithCodec).toHaveBeenCalledTimes(1)
    expect(getStreamWithCodec).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 921, profile: 'high' }),
      nodePin('agent-a'),
    )
    // The tier's adapter is registered with the REAL server under the
    // camStreamId-keyed brokerId — this is what makes `resolveBrokerId`
    // succeed instead of throwing "No broker for stream".
    expect(registerBrokerSpy).toHaveBeenCalledWith('921/main-high', fakeInnerBroker)
  })

  it('leak-regression: a single-tier adaptive session constructs EXACTLY ONE RemoteEncodedSourceBroker for the device, never eager-fans-out to the other tiers', async () => {
    const manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    const getIngestOwner = vi
      .fn()
      .mockResolvedValue({ ownerNodeId: 'agent-a', reachableHost: '10.0.0.9' })
    // All THREE tiers are assigned+ready on the owner — if the adaptive
    // hook ever regressed to eager-all-tiers construction (the leak class
    // this test guards against), every one of them would get acquired.
    const listAllProfileSlots = vi.fn().mockResolvedValue([
      {
        deviceId: 922,
        profile: 'high',
        brokerId: '922/high',
        sourceCamStreamId: 'main-high',
        status: 'ready',
      },
      {
        deviceId: 922,
        profile: 'mid',
        brokerId: '922/mid',
        sourceCamStreamId: 'main-mid',
        status: 'ready',
      },
      {
        deviceId: 922,
        profile: 'low',
        brokerId: '922/low',
        sourceCamStreamId: 'main-low',
        status: 'ready',
      },
    ])
    const getStreamWithCodec = vi.fn().mockResolvedValue({
      url: 'rtsp://10.0.0.9:8554/tok-low',
      videoCodec: 'H264',
      audioCodec: 'none',
      resolution: { width: 640, height: 360 },
      transcoded: false,
      encoder: 'copy',
      pipelineKey: 'pk-922-low',
    })
    const releaseStreamWithCodec = vi.fn().mockResolvedValue({ released: true, refcount: 0 })
    const api = {
      pipelineOrchestrator: { getIngestOwner: { query: getIngestOwner } },
      streamBroker: {
        listAllProfileSlots: { query: listAllProfileSlots },
        getStreamWithCodec: { mutate: getStreamWithCodec },
        releaseStreamWithCodec: { mutate: releaseStreamWithCodec },
      },
    } as unknown as AddonApi
    manager.setApiAccess(api, 'hub')

    let factoryCalls = 0
    const { broker: fakeInnerBroker } = makeFakeInnerBroker()
    manager.setRemoteEncodedBrokerFactory(() => {
      factoryCalls += 1
      return fakeInnerBroker
    })

    server = new BrokerWebrtcServer({ logger: makeLogger() })
    manager.setWebrtcServer(server)
    const facade = new WebrtcSessionProvider(server, manager)

    // TWO adaptive sessions for the SAME device (e.g. two viewers, or one
    // viewer reconnecting) both default to the SMALLEST available rung —
    // 'low' since the 2026-08-24 cold-start change (adaptive-tier.ts's
    // `default-low` docblock: the first picture is cheap, the probe/ladder
    // climbs) — no client hint, no prior intent. This is the "session stays
    // on ONE tier for its whole lifetime" invariant: repeated hook
    // resolution for the same tier must never re-construct the adapter.
    const first = await facade.createSession({ deviceId: 922, target: { kind: 'adaptive' } })
    const second = await facade.createSession({ deviceId: 922, target: { kind: 'adaptive' } })

    expect(first.sessionId).toBeTruthy()
    expect(second.sessionId).toBeTruthy()
    expect(second.sessionId).not.toBe(first.sessionId)

    // Exactly ONE `RemoteEncodedSourceBroker` (proxy: exactly one inner-
    // broker factory invocation, since `createEntry` calls it once per
    // adapter and the manager's `remoteBrokerAdapters` map only ever
    // constructs one adapter per brokerId) across BOTH sessions.
    expect(factoryCalls).toBe(1)
    expect(getStreamWithCodec).toHaveBeenCalledTimes(1)
    // The ONLY tier ever acquired is the cold-start default 'low' —
    // mid/high are NEVER queried, guarding the eager-all-tiers regression
    // explicitly.
    expect(getStreamWithCodec).toHaveBeenCalledWith(
      expect.objectContaining({ profile: 'low' }),
      nodePin('agent-a'),
    )
    for (const otherTier of ['mid', 'high'] as const) {
      expect(getStreamWithCodec).not.toHaveBeenCalledWith(
        expect.objectContaining({ profile: otherTier }),
        expect.anything(),
      )
    }
  })

  /**
   * Manager-level tier-switch simulation. A REAL close-and-recreate
   * downgrade (new `AdaptiveController` tick → `switchSessionTier` →
   * intent-carrying re-offer with the same sessionId, per the task brief)
   * needs a real `AdaptiveController` driven by its own timers ticking
   * inside `BrokerWebrtcServer` — heavy machinery this suite intentionally
   * does NOT fake superficially. Instead this drives the exact manager-level
   * primitives a real downgrade bottoms out in — TWO
   * `ensureRemoteAdaptiveTierBroker` calls for different tiers of the SAME
   * device, then the OLD tier's own `onDemandChange(false)` edge (which is
   * what a real session close-and-recreate ultimately fires once the old
   * broker's last subscriber leaves) — and asserts the leak-safety
   * contract: the OLD tier's restream is released exactly once, the NEW
   * tier's is never touched by that release, and nothing is released
   * before the demand-drop actually happens.
   *
   * The full live AdaptiveController-driven ladder (real ticks, real
   * close-and-recreate re-offer) is validated live in slice 5 — see the
   * Task 5 report.
   */
  it('tier-switch simulation: downgrading to a new tier ensures the new tier and tears down the OLD one exactly once, never prematurely', async () => {
    const manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    const getIngestOwner = vi
      .fn()
      .mockResolvedValue({ ownerNodeId: 'agent-a', reachableHost: '10.0.0.9' })
    const listAllProfileSlots = vi.fn().mockResolvedValue([
      {
        deviceId: 923,
        profile: 'high',
        brokerId: '923/high',
        sourceCamStreamId: 'main-high',
        status: 'ready',
      },
      {
        deviceId: 923,
        profile: 'low',
        brokerId: '923/low',
        sourceCamStreamId: 'main-low',
        status: 'ready',
      },
    ])
    const getStreamWithCodec = vi.fn().mockImplementation(
      async (input: { profile: string }) =>
        ({
          url: `rtsp://10.0.0.9:8554/tok-${input.profile}`,
          videoCodec: 'H264',
          audioCodec: 'none',
          resolution: { width: 1920, height: 1080 },
          transcoded: false,
          encoder: 'copy',
          pipelineKey: `pk-923-${input.profile}`,
        }) as const,
    )
    const releaseStreamWithCodec = vi.fn().mockResolvedValue({ released: true, refcount: 0 })
    const api = {
      pipelineOrchestrator: { getIngestOwner: { query: getIngestOwner } },
      streamBroker: {
        listAllProfileSlots: { query: listAllProfileSlots },
        getStreamWithCodec: { mutate: getStreamWithCodec },
        releaseStreamWithCodec: { mutate: releaseStreamWithCodec },
      },
    } as unknown as AddonApi
    manager.setApiAccess(api, 'hub')

    const highBroker = makeFakeInnerBroker()
    const lowBroker = makeFakeInnerBroker()
    manager.setRemoteEncodedBrokerFactory((deps) =>
      deps.brokerId.endsWith('/high') ? highBroker.broker : lowBroker.broker,
    )

    server = new BrokerWebrtcServer({ logger: makeLogger() })
    const registerBrokerSpy = vi.spyOn(server, 'registerBroker')
    const unregisterBrokerSpy = vi.spyOn(server, 'unregisterBroker')
    manager.setWebrtcServer(server)

    // Original session lands on 'high'.
    await manager.ensureRemoteAdaptiveTierBroker(923, 'high')
    expect(registerBrokerSpy).toHaveBeenCalledWith('923/main-high', highBroker.broker)
    expect(releaseStreamWithCodec).not.toHaveBeenCalled()

    // Downgrade: a re-offer prefers 'low'. The new tier is ensured while
    // the old one is STILL registered — nothing torn down yet, because the
    // old session's demand hasn't dropped.
    await manager.ensureRemoteAdaptiveTierBroker(923, 'low')
    expect(registerBrokerSpy).toHaveBeenCalledWith('923/main-low', lowBroker.broker)
    expect(releaseStreamWithCodec).not.toHaveBeenCalled()
    expect(unregisterBrokerSpy).not.toHaveBeenCalledWith('923/main-high')

    // The OLD (high) broker's last subscriber leaves — its own
    // onDemandChange(false) edge is what a real close-and-recreate
    // ultimately fires once the recreated session no longer references it.
    highBroker.fireDemand(false)
    await vi.waitFor(() => {
      expect(releaseStreamWithCodec).toHaveBeenCalledTimes(1)
    })
    expect(releaseStreamWithCodec).toHaveBeenCalledWith(
      { pipelineKey: 'pk-923-high' },
      nodePin('agent-a'),
    )
    expect(unregisterBrokerSpy).toHaveBeenCalledWith('923/main-high')
    // The NEW tier is untouched by the old tier's teardown.
    expect(unregisterBrokerSpy).not.toHaveBeenCalledWith('923/main-low')
    expect(releaseStreamWithCodec).not.toHaveBeenCalledWith(
      { pipelineKey: 'pk-923-low' },
      nodePin('agent-a'),
    )
  })
})
