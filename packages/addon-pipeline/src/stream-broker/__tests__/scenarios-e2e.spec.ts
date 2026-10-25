/**
 * End-to-end scenarios — C8 of the profile-slot refactor.
 *
 * Exercises the public cap surface (`publishCameraStream`,
 * `assignProfile`, `unassignProfile`, `retractCameraStream`,
 * `restartProfile`) in combinations that mirror what a provider addon
 * would drive at runtime. Complements `profile-broker.spec.ts` (which
 * covers individual transitions) with scenario flows that span
 * multiple mutations + assertions.
 *
 * Also exercises the `WebrtcSessionProvider` facade end-to-end against
 * a mock webrtc-collection provider to prove the profile → streamId
 * resolution path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventCategory } from '@camstack/types'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager'
import { WebrtcSessionProvider, CameraStreamsProvider } from '../device-scoped-providers'
import type { IScopedLogger, IEventBus, EventFilter, SystemEvent } from '@camstack/types'

// ── Fakes ────────────────────────────────────────────────────────────

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

function makeEventBus(): { bus: IEventBus; captured: SystemEvent[] } {
  const captured: SystemEvent[] = []
  const handlers = new Map<string, Set<(event: SystemEvent) => void>>()
  const bus: IEventBus = {
    emit(event: SystemEvent) {
      captured.push(event)
      const set = handlers.get(event.category)
      if (set) for (const h of set) h(event)
    },
    subscribe(filter: EventFilter, handler: (event: SystemEvent) => void) {
      const cat =
        typeof filter === 'object' && 'category' in filter && typeof filter.category === 'string'
          ? filter.category
          : '*'
      const existing = handlers.get(cat) ?? new Set()
      existing.add(handler)
      handlers.set(cat, existing)
      return () => {
        handlers.get(cat)?.delete(handler)
      }
    },
    getRecent() {
      return captured as readonly SystemEvent[]
    },
  }
  return { bus, captured }
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

/** Simulate what a provider addon does on `onInitialize`. */
async function publishPullCam(
  manager: StreamBrokerManager,
  deviceId: number,
  streams: ReadonlyArray<{
    id: string
    url: string
    resolution?: { width: number; height: number }
  }>,
): Promise<void> {
  for (const s of streams) {
    await manager.publishCameraStream({
      deviceId,
      camStreamId: s.id,
      kind: 'pull-rtsp',
      url: s.url,
      ...(s.resolution ? { resolution: s.resolution } : {}),
    })
  }
}

async function publishPushCam(
  manager: StreamBrokerManager,
  deviceId: number,
  streams: ReadonlyArray<{
    id: string
    resolution?: { width: number; height: number }
  }>,
): Promise<void> {
  for (const s of streams) {
    await manager.publishCameraStream({
      deviceId,
      camStreamId: s.id,
      kind: 'push-annexb',
      ...(s.resolution ? { resolution: s.resolution } : {}),
    })
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('StreamBrokerManager — end-to-end scenarios', () => {
  let manager: StreamBrokerManager

  beforeEach(() => {
    manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
  })

  describe('MultiCam (mixed pull + push, N=5)', () => {
    it('auto-assigns the top-3 by resolution across kinds', async () => {
      const { bus, captured } = makeEventBus()
      manager.setEventBus(bus)

      // 3 pull streams + 2 push streams. The broker does NOT know the
      // "kind" ranking — only pixel count. We expect the top-3 pixels
      // to win the high/mid/low slots regardless of kind.
      await publishPullCam(manager, 1, [
        { id: 'pull-4k', url: 'rtsp://pull-4k', resolution: { width: 3840, height: 2160 } },
        { id: 'pull-1080', url: 'rtsp://pull-1080', resolution: { width: 1920, height: 1080 } },
        { id: 'pull-720', url: 'rtsp://pull-720', resolution: { width: 1280, height: 720 } },
      ])
      await publishPushCam(manager, 1, [
        // push-1080 ties with pull-1080 at 2.07M pixels. The ranker
        // breaks ties by publish order ascending — push-1080 was
        // published AFTER pull-1080, so pull-1080 wins the mid slot.
        { id: 'push-1080', resolution: { width: 1920, height: 1080 } },
        { id: 'push-480', resolution: { width: 640, height: 480 } },
      ])

      const slots = manager.getProfileSlotsForDevice(1)
      // Top-3 pixel ranking across all 5 entries, tie-broken by order:
      //   pull-4k (8.3M, order 1) → high
      //   pull-1080 (2.07M, order 2) → mid (beats push-1080 on order)
      //   push-1080 (2.07M, order 4) → low (ties pull-1080, loses order
      //     tiebreak → takes 3rd rank → low slot)
      expect(slots.find((s) => s.profile === 'high')!.sourceCamStreamId).toBe('pull-4k')
      expect(slots.find((s) => s.profile === 'mid')!.sourceCamStreamId).toBe('pull-1080')
      expect(slots.find((s) => s.profile === 'low')!.sourceCamStreamId).toBe('push-1080')

      // `low` backs push-1080 (push-kind) — exactly one demand event
      // fires at the moment it was promoted into an assigned slot.
      const demand = captured.filter(
        (e) => e.category === EventCategory.StreamBrokerOnCamStreamDemand,
      )
      expect(demand).toHaveLength(1)
      expect(demand[0]!.data).toMatchObject({ deviceId: 1, camStreamId: 'push-1080' })

      // The camera-streams cap surface reports all 5 streams in
      // insertion order — the unassigned push streams don't disappear.
      const allCamStreams = manager.getCameraStreamsForDevice(1)
      expect(allCamStreams.map((s) => s.camStreamId)).toEqual([
        'pull-4k',
        'pull-1080',
        'pull-720',
        'push-1080',
        'push-480',
      ])
    })

    it('operator manually promotes a push stream → demand event', async () => {
      const { bus, captured } = makeEventBus()
      manager.setEventBus(bus)

      await publishPullCam(manager, 2, [
        { id: 'pull-1080', url: 'rtsp://pull-1080', resolution: { width: 1920, height: 1080 } },
      ])
      await publishPushCam(manager, 2, [
        { id: 'push-4k', resolution: { width: 3840, height: 2160 } },
      ])

      // After the second publish the auto-rerank places push-4k (8.3M
      // pixels) on `high` and the 1080p pull on `low`. The explicit
      // `assignProfile` below is a no-op for the map but flips auto=false
      // so later publishes can't reshuffle.
      await manager.assignProfile({ deviceId: 2, profile: 'high', camStreamId: 'push-4k' })

      const slots = manager.getProfileSlotsForDevice(2)
      expect(slots.find((s) => s.profile === 'high')!.sourceCamStreamId).toBe('push-4k')
      expect(slots.find((s) => s.profile === 'low')!.sourceCamStreamId).toBe('pull-1080')
      expect(slots.find((s) => s.profile === 'mid')!.sourceCamStreamId).toBeNull()

      // push-4k transitioned from 0 consumers to 1 (auto-assign to high)
      // at the second publish — one demand event, not two.
      const demand = captured.filter(
        (e) => e.category === EventCategory.StreamBrokerOnCamStreamDemand,
      )
      expect(demand).toHaveLength(1)
      expect(demand[0]!.data).toMatchObject({
        deviceId: 2,
        camStreamId: 'push-4k',
        profile: 'high',
      })
    })
  })

  describe('mid-session reassignment', () => {
    it('assignProfile + unassignProfile updates slots without touching brokers', async () => {
      await publishPullCam(manager, 3, [
        { id: 'a', url: 'rtsp://a', resolution: { width: 1920, height: 1080 } },
        { id: 'b', url: 'rtsp://b', resolution: { width: 640, height: 480 } },
      ])
      // After auto-assign: high=a, low=b. Each published cam stream
      // owns its broker for as long as the source is published.
      const beforeA = await manager.getBroker({ brokerId: '3/a' })
      const beforeB = await manager.getBroker({ brokerId: '3/b' })
      expect(beforeA).not.toBeNull()
      expect(beforeB).not.toBeNull()

      // Swap: promote `b` to high, unassign `a` from low entirely.
      // Brokers are decoupled from the profile map — both stay alive.
      await manager.assignProfile({ deviceId: 3, profile: 'high', camStreamId: 'b' })
      await manager.unassignProfile({ deviceId: 3, profile: 'low' })

      const afterA = await manager.getBroker({ brokerId: '3/a' })
      const afterB = await manager.getBroker({ brokerId: '3/b' })
      expect(afterA).not.toBeNull()
      expect(afterB).not.toBeNull()
      expect(afterA).toBe(beforeA)
      expect(afterB).toBe(beforeB)

      const slots = manager.getProfileSlotsForDevice(3)
      expect(slots.find((s) => s.profile === 'high')!.sourceCamStreamId).toBe('b')
      expect(slots.find((s) => s.profile === 'low')!.sourceCamStreamId).toBeNull()
    })
  })

  describe('retraction of an active slot', () => {
    it('retract of the only assigned slot destroys its broker and emits idle for push-kind', async () => {
      const { bus, captured } = makeEventBus()
      manager.setEventBus(bus)

      await publishPushCam(manager, 4, [{ id: 'only', resolution: { width: 1920, height: 1080 } }])
      expect(await manager.getBroker({ brokerId: '4/only' })).not.toBeNull()

      await manager.retractCameraStream({ deviceId: 4, camStreamId: 'only' })
      expect(await manager.getBroker({ brokerId: '4/only' })).toBeNull()

      const idle = captured.filter((e) => e.category === EventCategory.StreamBrokerOnCamStreamIdle)
      expect(idle).toHaveLength(1)
      expect(idle[0]!.data).toMatchObject({ deviceId: 4, camStreamId: 'only' })
    })

    it('retract of a pull slot tears down the broker without emitting demand/idle', async () => {
      const { bus, captured } = makeEventBus()
      manager.setEventBus(bus)

      await publishPullCam(manager, 5, [{ id: 'only', url: 'rtsp://only' }])
      expect(await manager.getBroker({ brokerId: '5/only' })).not.toBeNull()

      await manager.retractCameraStream({ deviceId: 5, camStreamId: 'only' })
      expect(await manager.getBroker({ brokerId: '5/only' })).toBeNull()

      expect(
        captured.filter((e) => e.category === EventCategory.StreamBrokerOnCamStreamDemand),
      ).toHaveLength(0)
      expect(
        captured.filter((e) => e.category === EventCategory.StreamBrokerOnCamStreamIdle),
      ).toHaveLength(0)
    })
  })

  describe('restartProfile', () => {
    it('rebuilds the broker atomically without side-effects on other slots', async () => {
      await publishPullCam(manager, 6, [
        { id: 'hi', url: 'rtsp://hi', resolution: { width: 1920, height: 1080 } },
        { id: 'lo', url: 'rtsp://lo', resolution: { width: 640, height: 480 } },
      ])
      const beforeHi = await manager.getBroker({ brokerId: '6/hi' })
      const beforeLo = await manager.getBroker({ brokerId: '6/lo' })
      expect(beforeHi).not.toBeNull()
      expect(beforeLo).not.toBeNull()

      await manager.restartProfile({ deviceId: 6, profile: 'high' })
      const afterHi = await manager.getBroker({ brokerId: '6/hi' })
      const afterLo = await manager.getBroker({ brokerId: '6/lo' })
      expect(afterHi).not.toBeNull()
      expect(afterHi).not.toBe(beforeHi)
      // The low cam stream must be untouched — same broker instance.
      expect(afterLo).toBe(beforeLo)
    })
  })

  describe('persistence round-trip', () => {
    it('assignment survives manager restart via profileMap persister', async () => {
      const persisted = new Map<
        number,
        { map: Record<string, string | undefined>; auto: boolean }
      >()

      // First boot: operator manually assigns.
      manager.setProfileMapPersister((assignments) => {
        persisted.clear()
        for (const [deviceId, a] of assignments) {
          persisted.set(deviceId, { map: { ...a.map }, auto: a.auto })
        }
      })
      await publishPullCam(manager, 10, [
        { id: 'a', url: 'rtsp://a' },
        { id: 'b', url: 'rtsp://b' },
      ])
      // Auto-assign of 2 streams → {high: a, low: b}. Operator promotes
      // `b` to high AND explicitly clears low so the persisted layout
      // is a single {high: b} slot.
      await manager.assignProfile({ deviceId: 10, profile: 'high', camStreamId: 'b' })
      await manager.unassignProfile({ deviceId: 10, profile: 'low' })

      // Simulate restart: new manager, reload persisted map.
      const reloaded = new StreamBrokerManager(makeLogger())
      stubRtsp(reloaded)
      reloaded.loadPersistedProfileMap(
        new Map([...persisted.entries()].map(([k, v]) => [k, { map: v.map, auto: v.auto }])),
      )
      await publishPullCam(reloaded, 10, [
        { id: 'a', url: 'rtsp://a' },
        { id: 'b', url: 'rtsp://b' },
      ])
      const slots = reloaded.getProfileSlotsForDevice(10)
      expect(slots.find((s) => s.profile === 'high')!.sourceCamStreamId).toBe('b')
      // auto=false after the manual assign → subsequent publishes don't
      // reshuffle. 'a' is NOT auto-assigned to any profile on reload.
      const assignedIds = slots
        .filter((s) => s.sourceCamStreamId !== null)
        .map((s) => s.sourceCamStreamId)
      expect(assignedIds).toEqual(['b'])
    })
  })
})

describe('WebrtcSessionProvider — delegates to BrokerWebrtcServer', () => {
  function makeMockServer() {
    return {
      createSession: vi.fn().mockResolvedValue({ sessionId: 'sess-1', sdpOffer: 'offer-1' }),
      handleAnswer: vi.fn().mockResolvedValue(undefined),
      closeSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as import('../webrtc/broker-webrtc-server.js').BrokerWebrtcServer
  }

  function makeMockManager(
    slots: Array<{ profile: string; sourceCamStreamId: string | null; codec?: string }>,
  ) {
    const slotByCam = new Map(
      slots
        .filter(
          (s): s is { profile: string; sourceCamStreamId: string; codec?: string } =>
            s.sourceCamStreamId !== null,
        )
        .map((s) => [s.sourceCamStreamId, s]),
    )
    const profileBoundCams = [...slotByCam.keys()]
    return {
      getProfileSlotsForDevice: vi.fn().mockReturnValue(
        slots.map((s) => ({
          deviceId: 20,
          profile: s.profile,
          brokerId: s.sourceCamStreamId ? `20/${s.sourceCamStreamId}` : `20/${s.profile}`,
          sourceCamStreamId: s.sourceCamStreamId,
          status: 'streaming',
          codec: s.codec,
        })),
      ),
      getCameraStreamsForDevice: vi.fn().mockReturnValue(
        profileBoundCams.map((camStreamId) => ({
          camStreamId,
          deviceId: 20,
          kind: 'pull-rtsp',
          codec: slotByCam.get(camStreamId)?.codec,
          label: camStreamId,
        })),
      ),
      // listStreams hits getBroker per published cam stream to pull live stats.
      getBroker: vi.fn().mockImplementation(async ({ brokerId }: { brokerId: string }) => {
        const camStreamId = brokerId.slice(brokerId.indexOf('/') + 1)
        const slot = slotByCam.get(camStreamId)
        if (!slot) return null
        return {
          getStats: () => ({
            status: 'streaming',
            inputFps: 30,
            bitrateKbps: 2000,
            codec: slot.codec ?? null,
          }),
        }
      }),
      isStreamingDebug: vi.fn().mockReturnValue(false),
      getStreamWebrtcParams: vi.fn().mockReturnValue(undefined),
      getCameraStreamProbedParams: vi.fn().mockReturnValue(undefined),
    } as unknown as import('../stream-broker/stream-broker-manager.js').StreamBrokerManager
  }

  it('createSession with profile target resolves to the bound camStreamId brokerId', async () => {
    const server = makeMockServer()
    const mgr = makeMockManager([{ profile: 'high', sourceCamStreamId: 'a' }])
    const session = new WebrtcSessionProvider(server, mgr)

    const result = await session.createSession({
      deviceId: 20,
      target: { kind: 'profile', profile: 'high' },
    })
    expect(result).toEqual({ sessionId: 'sess-1', sdpOffer: 'offer-1' })
    expect(server.createSession).toHaveBeenCalledWith(
      '20/a',
      undefined,
      expect.objectContaining({ streamingDebug: false, relayOnly: false }),
    )
  })

  it('createSession adaptive routes to `${deviceId}/adaptive`', async () => {
    const server = makeMockServer()
    const mgr = makeMockManager([{ profile: 'mid', sourceCamStreamId: 'only' }])
    const session = new WebrtcSessionProvider(server, mgr)

    await session.createSession({ deviceId: 20, target: { kind: 'adaptive' } })
    expect(server.createSession).toHaveBeenCalledWith(
      '20/adaptive',
      undefined,
      expect.objectContaining({ streamingDebug: false, relayOnly: false }),
    )
  })

  it('createSession with cam-stream target routes by camStreamId directly', async () => {
    const server = makeMockServer()
    const mgr = makeMockManager([{ profile: 'high', sourceCamStreamId: 'a' }])
    const session = new WebrtcSessionProvider(server, mgr)

    await session.createSession({
      deviceId: 20,
      target: { kind: 'cam-stream', camStreamId: 'native:main' },
    })
    expect(server.createSession).toHaveBeenCalledWith(
      '20/native:main',
      undefined,
      expect.objectContaining({ streamingDebug: false, relayOnly: false }),
    )
  })

  it('listStreams returns adaptive + per-profile entries + per-cam-stream entries', async () => {
    const server = makeMockServer()
    const mgr = makeMockManager([
      { profile: 'high', sourceCamStreamId: 'a', codec: 'h264' },
      { profile: 'mid', sourceCamStreamId: null },
      { profile: 'low', sourceCamStreamId: 'b', codec: 'h264' },
    ])
    const session = new WebrtcSessionProvider(server, mgr)

    const streams = await session.listStreams({ deviceId: 20 })
    expect(streams.map((s) => s.id)).toEqual([
      'adaptive',
      'profile:high',
      'profile:low',
      'stream:a',
      'stream:b',
    ])
    expect(streams[0]!.target).toEqual({ kind: 'adaptive' })
    expect(streams[1]!.target).toEqual({ kind: 'profile', profile: 'high' })
    expect(streams[3]!.target).toEqual({ kind: 'cam-stream', camStreamId: 'a' })
  })

  it('listStreams returns empty for device with no assigned profiles', async () => {
    const server = makeMockServer()
    const mgr = makeMockManager([
      { profile: 'high', sourceCamStreamId: null },
      { profile: 'mid', sourceCamStreamId: null },
      { profile: 'low', sourceCamStreamId: null },
    ])
    const session = new WebrtcSessionProvider(server, mgr)

    const streams = await session.listStreams({ deviceId: 20 })
    expect(streams).toEqual([])
  })
})

describe('CameraStreamsProvider — end-to-end against manager state', () => {
  it('getCameraStreams + getBrokerStreams reflect every publish/assign mutation immediately', async () => {
    const manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    const facade = new CameraStreamsProvider(manager)

    // Empty state
    expect(await facade.getCameraStreams({ deviceId: 30 })).toEqual([])
    expect(await facade.getBrokerStreams({ deviceId: 30 })).toEqual([])

    await publishPullCam(manager, 30, [
      { id: 'a', url: 'rtsp://a', resolution: { width: 1920, height: 1080 } },
      { id: 'b', url: 'rtsp://b', resolution: { width: 640, height: 480 } },
    ])

    const cams = await facade.getCameraStreams({ deviceId: 30 })
    expect(cams.map((c) => c.camStreamId)).toEqual(['a', 'b'])

    const slots = await facade.getBrokerStreams({ deviceId: 30 })
    expect(slots.find((s) => s.profile === 'high')!.sourceCamStreamId).toBe('a')
    expect(slots.find((s) => s.profile === 'low')!.sourceCamStreamId).toBe('b')

    // Retract one cam stream → facade view shrinks.
    await manager.retractCameraStream({ deviceId: 30, camStreamId: 'a' })
    const camsAfter = await facade.getCameraStreams({ deviceId: 30 })
    expect(camsAfter.map((c) => c.camStreamId)).toEqual(['b'])
  })
})
