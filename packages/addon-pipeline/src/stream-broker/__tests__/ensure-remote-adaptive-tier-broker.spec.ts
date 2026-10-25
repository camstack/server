/**
 * `StreamBrokerManager.ensureRemoteAdaptiveTierBroker(deviceId, preferredTier)`
 * (Slice 3b Task 3) — lazily ensure a remote adapter exists for a device's
 * PREFERRED tier's camStream, for adaptive per-tier consumers that don't yet
 * have a session-pinned camStreamId.
 *
 * Mirrors the `WebrtcSessionProvider — cross-node ingest wiring` describe
 * block in `device-scoped-providers.spec.ts` (real `StreamBrokerManager` +
 * mocked `AddonApi` + `setRemoteEncodedBrokerFactory` fake inner broker) but
 * exercises the manager method directly rather than through the WebRTC
 * session facade.
 */
import { describe, it, expect, vi } from 'vitest'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'
import type { AddonApi, CamProfile, IScopedLogger } from '@camstack/types'
import { nodePin } from '@camstack/types'
import type { IStreamBrokerWithSourceProvider } from '../webrtc/remote-encoded-source-broker.js'

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

/** Fake inner broker with a controllable `onDemandChange` observer. */
function makeFakeInnerBroker(): {
  broker: IStreamBrokerWithSourceProvider
  fireDemand: (active: boolean) => void
} {
  let observer: ((active: boolean) => void) | null = null
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
  } as unknown as IStreamBrokerWithSourceProvider
  return { broker, fireDemand: (active: boolean) => observer?.(active) }
}

function makeFakeWebrtcServer(): {
  server: import('../webrtc/broker-webrtc-server.js').BrokerWebrtcServer
  registerBroker: ReturnType<typeof vi.fn>
  unregisterBroker: ReturnType<typeof vi.fn>
} {
  const registerBroker = vi.fn()
  const unregisterBroker = vi.fn()
  const server = {
    createSession: vi.fn(),
    registerBroker,
    unregisterBroker,
    setProfileTierResolver: vi.fn(),
    setStreamOriginResolver: vi.fn(),
    setEgressTranscodeProvider: vi.fn(),
    setEnsureAdaptiveTierBrokerHook: vi.fn(),
    handleAnswer: vi.fn(),
    closeSession: vi.fn(),
  } as unknown as import('../webrtc/broker-webrtc-server.js').BrokerWebrtcServer
  return { server, registerBroker, unregisterBroker }
}

function getRemoteBrokerTiers(manager: StreamBrokerManager): ReadonlyMap<string, CamProfile> {
  return (manager as unknown as { remoteBrokerTiers: Map<string, CamProfile> }).remoteBrokerTiers
}

describe('StreamBrokerManager.ensureRemoteAdaptiveTierBroker (Slice 3b Task 3)', () => {
  it('local owner (this.assignments.has(deviceId)) → zero acquires, no adapter (byte-identical)', async () => {
    const manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    // A locally-owned device already has an assignment map entry.
    await manager.publishCameraStream({
      deviceId: 910,
      camStreamId: 'main',
      kind: 'pull-rtsp',
      url: 'rtsp://910',
    })
    await manager.assignProfile({ deviceId: 910, profile: 'high', camStreamId: 'main' })

    const getIngestOwner = vi.fn()
    const listAllProfileSlots = vi.fn()
    const getStreamWithCodec = vi.fn()
    const api = {
      pipelineOrchestrator: { getIngestOwner: { query: getIngestOwner } },
      streamBroker: {
        listAllProfileSlots: { query: listAllProfileSlots },
        getStreamWithCodec: { mutate: getStreamWithCodec },
      },
    } as unknown as AddonApi
    manager.setApiAccess(api, 'hub')
    const { server, registerBroker } = makeFakeWebrtcServer()
    manager.setWebrtcServer(server)
    // `setWebrtcServer` back-registers every pre-existing LOCAL broker
    // (unrelated to this method) — the device 910 broker published above
    // triggers exactly one such call. Clear it so the assertion below
    // isolates calls made BY `ensureRemoteAdaptiveTierBroker` itself.
    registerBroker.mockClear()

    await manager.ensureRemoteAdaptiveTierBroker(910, 'high')

    expect(getIngestOwner).not.toHaveBeenCalled()
    expect(listAllProfileSlots).not.toHaveBeenCalled()
    expect(getStreamWithCodec).not.toHaveBeenCalled()
    expect(registerBroker).not.toHaveBeenCalled()
  })

  it('remote owner + high slot assigned → one adapter for the high camStreamId, registered, remoteBrokerTiers records "high"', async () => {
    const manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    const getIngestOwner = vi
      .fn()
      .mockResolvedValue({ ownerNodeId: 'agent-a', reachableHost: '10.0.0.9' })
    const listAllProfileSlots = vi.fn().mockResolvedValue([
      {
        deviceId: 911,
        profile: 'high',
        brokerId: '911/high',
        sourceCamStreamId: 'main-high',
        status: 'ready',
      },
      {
        deviceId: 911,
        profile: 'mid',
        brokerId: '911/mid',
        sourceCamStreamId: 'main-mid',
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
      pipelineKey: 'pk-911-high',
    })
    const api = {
      pipelineOrchestrator: { getIngestOwner: { query: getIngestOwner } },
      streamBroker: {
        listAllProfileSlots: { query: listAllProfileSlots },
        getStreamWithCodec: { mutate: getStreamWithCodec },
        releaseStreamWithCodec: {
          mutate: vi.fn().mockResolvedValue({ released: true, refcount: 0 }),
        },
      },
    } as unknown as AddonApi
    manager.setApiAccess(api, 'hub')

    const { broker: fakeInnerBroker } = makeFakeInnerBroker()
    manager.setRemoteEncodedBrokerFactory(() => fakeInnerBroker)

    const { server, registerBroker } = makeFakeWebrtcServer()
    manager.setWebrtcServer(server)

    await manager.ensureRemoteAdaptiveTierBroker(911, 'high')

    expect(listAllProfileSlots).toHaveBeenCalledWith(undefined, nodePin('agent-a'))
    expect(getStreamWithCodec).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 911, profile: 'high' }),
      nodePin('agent-a'),
    )
    expect(registerBroker).toHaveBeenCalledWith('911/main-high', fakeInnerBroker)
    expect(getRemoteBrokerTiers(manager).get('911/main-high')).toBe('high')
  })

  it('high unassigned + mid assigned → falls back to mid (via resolveTierSlot)', async () => {
    const manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    const getIngestOwner = vi
      .fn()
      .mockResolvedValue({ ownerNodeId: 'agent-a', reachableHost: '10.0.0.9' })
    const listAllProfileSlots = vi.fn().mockResolvedValue([
      {
        deviceId: 912,
        profile: 'mid',
        brokerId: '912/mid',
        sourceCamStreamId: 'main-mid',
        status: 'ready',
      },
    ])
    const getStreamWithCodec = vi.fn().mockResolvedValue({
      url: 'rtsp://10.0.0.9:8554/tok-mid',
      videoCodec: 'H264',
      audioCodec: 'none',
      resolution: { width: 640, height: 360 },
      transcoded: false,
      encoder: 'copy',
      pipelineKey: 'pk-912-mid',
    })
    const api = {
      pipelineOrchestrator: { getIngestOwner: { query: getIngestOwner } },
      streamBroker: {
        listAllProfileSlots: { query: listAllProfileSlots },
        getStreamWithCodec: { mutate: getStreamWithCodec },
        releaseStreamWithCodec: {
          mutate: vi.fn().mockResolvedValue({ released: true, refcount: 0 }),
        },
      },
    } as unknown as AddonApi
    manager.setApiAccess(api, 'hub')

    const { broker: fakeInnerBroker } = makeFakeInnerBroker()
    manager.setRemoteEncodedBrokerFactory(() => fakeInnerBroker)

    const { server, registerBroker } = makeFakeWebrtcServer()
    manager.setWebrtcServer(server)

    await manager.ensureRemoteAdaptiveTierBroker(912, 'high')

    expect(getStreamWithCodec).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 912, profile: 'mid' }),
      nodePin('agent-a'),
    )
    expect(registerBroker).toHaveBeenCalledWith('912/main-mid', fakeInnerBroker)
    expect(getRemoteBrokerTiers(manager).get('912/main-mid')).toBe('mid')
  })

  it('no slot assigned at all → returns without throwing, no adapter constructed', async () => {
    const manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    const getIngestOwner = vi
      .fn()
      .mockResolvedValue({ ownerNodeId: 'agent-a', reachableHost: '10.0.0.9' })
    const listAllProfileSlots = vi.fn().mockResolvedValue([])
    const getStreamWithCodec = vi.fn()
    const api = {
      pipelineOrchestrator: { getIngestOwner: { query: getIngestOwner } },
      streamBroker: {
        listAllProfileSlots: { query: listAllProfileSlots },
        getStreamWithCodec: { mutate: getStreamWithCodec },
      },
    } as unknown as AddonApi
    manager.setApiAccess(api, 'hub')
    const { server, registerBroker } = makeFakeWebrtcServer()
    manager.setWebrtcServer(server)

    await expect(manager.ensureRemoteAdaptiveTierBroker(913, 'high')).resolves.toBeUndefined()
    expect(getStreamWithCodec).not.toHaveBeenCalled()
    expect(registerBroker).not.toHaveBeenCalled()
  })

  it('unresolvable owner (no reachableHost) → throws the descriptive error', async () => {
    const manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    const getIngestOwner = vi.fn().mockResolvedValue({ ownerNodeId: 'agent-b' })
    const api = {
      pipelineOrchestrator: { getIngestOwner: { query: getIngestOwner } },
    } as unknown as AddonApi
    manager.setApiAccess(api, 'hub')
    const { server } = makeFakeWebrtcServer()
    manager.setWebrtcServer(server)

    await expect(manager.ensureRemoteAdaptiveTierBroker(914, 'high')).rejects.toThrow(/agent-b/)
  })
})
