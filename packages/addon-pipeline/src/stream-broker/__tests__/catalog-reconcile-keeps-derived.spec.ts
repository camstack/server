/**
 * `reconcileDeviceCatalog` must NOT retract derived streams.
 *
 * Live bug (618 "bedroom", 2026-07-16): the catalog reconcile sweep
 * retracts any registered cam-stream absent from the provider's
 * `stream-catalog` pull — but a provider catalog only ever contains PHYSICAL
 * streams, never the broker-owned synthetic `derived:*` entries. So a derived
 * materialized at boot (or by 56bf5c63's settings-patch reconcile) survived
 * only until the next catalog reconcile tick, which swept it as "no longer in
 * the catalog": the derived vanished from every stream selector, and a later
 * subscriber-path `ensureBrokerForId` recreated its broker WITHOUT the
 * transcode feeder — a push broker that never receives data ("push source
 * stalled — no data received" on play).
 *
 * Derived lifecycle belongs to the deviceOverrides reconcile
 * (`reconcileDerivedStreams`) exclusively; the catalog sweep must skip them.
 *
 * Harness: same manager/RTSP/api stubs as `atomic-catalog-publish.spec.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'
import type { AddonApi, CamStreamDescriptor, IScopedLogger } from '@camstack/types'

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

function makeApi(descriptors: readonly CamStreamDescriptor[]): AddonApi {
  return {
    deviceManager: {
      listAll: {
        query: vi.fn(async () => [{ id: DEVICE, type: 'camera', isCamera: true, disabled: false }]),
      },
    },
    streamCatalog: {
      getCatalog: { query: vi.fn(async () => descriptors) },
    },
  } as unknown as AddonApi
}

const DEVICE = 108

/**
 * A catalog omission retracts only when a pull at least one reconcile
 * interval later agrees (D689): pull twice, a full interval apart.
 */
async function reconcileTwiceAnIntervalApart(manager: StreamBrokerManager): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    await manager.reconcileDeviceCatalog(DEVICE)
    vi.setSystemTime(Date.now() + 30_000)
    await manager.reconcileDeviceCatalog(DEVICE)
  } finally {
    vi.useRealTimers()
  }
}

const CATALOG: readonly CamStreamDescriptor[] = [
  {
    camStreamId: 'native:main',
    kind: 'pull-rtsp',
    url: 'rtsp://x/main',
    resolution: { width: 2560, height: 1440 },
  },
  {
    camStreamId: 'native:sub',
    kind: 'pull-rtsp',
    url: 'rtsp://x/sub',
    resolution: { width: 640, height: 360 },
  },
]

function streamIds(manager: StreamBrokerManager): string[] {
  return manager.getCameraStreamsForDevice(DEVICE).map((s) => s.camStreamId)
}

describe('reconcileDeviceCatalog × derived streams', () => {
  let manager: StreamBrokerManager

  beforeEach(() => {
    manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    manager.setApiAccess(makeApi(CATALOG))
  })

  afterEach(async () => {
    await manager.destroyAll()
  })

  it('a materialized derived SURVIVES a catalog reconcile that (by nature) lacks it', async () => {
    await manager.reconcileDeviceCatalog(DEVICE)
    await manager.publishCameraStream({
      deviceId: DEVICE,
      camStreamId: 'derived:sub-cropped',
      kind: 'derived',
      source: { kind: 'profile', profile: 'low' },
      encodeProfile: {
        video: { codec: 'h264', width: 640, height: 360 },
        audio: 'passthrough',
      },
    })
    expect(streamIds(manager)).toContain('derived:sub-cropped')

    // The poll-cadence reconcile tick: the provider catalog still only lists
    // the physical streams. The derived must NOT be swept.
    await manager.reconcileDeviceCatalog(DEVICE)

    expect(streamIds(manager)).toContain('derived:sub-cropped')
    // …while a genuinely-removed PHYSICAL stream still gets retracted.
    expect(streamIds(manager)).toContain('native:main')
  })

  it('the sweep still retracts a physical stream that left the catalog', async () => {
    await manager.reconcileDeviceCatalog(DEVICE)
    expect(streamIds(manager)).toContain('native:sub')

    manager.setApiAccess(makeApi([CATALOG[0]!])) // sub disappears from the catalog
    await reconcileTwiceAnIntervalApart(manager)

    expect(streamIds(manager)).not.toContain('native:sub')
    expect(streamIds(manager)).toContain('native:main')
  })

  it('a plugin-restart catalog drop does NOT empty manual high/mid while a derived keeps low', async () => {
    // Live 618, 2026-08-16: operator assigned `derived:Mid to low` to `low`
    // (`assignProfile` locks auto=false). Hikvision plugin restart published a
    // transient partial catalog; reconcile retracted native:main / native:slot-3
    // and CLEARED those slots. The derived (broker-owned) survived on low.
    // Natives came back, auto stayed false, high/mid stayed unassigned, and
    // the derived (source = mid) had nothing to transcode — 0 packets, "streaming".
    const full: readonly CamStreamDescriptor[] = [
      {
        camStreamId: 'native:main',
        kind: 'pull-rtsp',
        url: 'rtsp://x/main',
        resolution: { width: 2560, height: 1440 },
      },
      {
        camStreamId: 'native:slot-3',
        kind: 'pull-rtsp',
        url: 'rtsp://x/slot3',
        resolution: { width: 1280, height: 720 },
      },
      {
        camStreamId: 'native:sub',
        kind: 'pull-rtsp',
        url: 'rtsp://x/sub',
        resolution: { width: 640, height: 360 },
      },
    ]
    manager.setApiAccess(makeApi(full))
    await manager.reconcileDeviceCatalog(DEVICE)
    await manager.publishCameraStream({
      deviceId: DEVICE,
      camStreamId: 'derived:Mid to low',
      kind: 'derived',
      source: { kind: 'profile', profile: 'mid' },
      encodeProfile: {
        video: { codec: 'h264', width: 640, height: 360 },
        audio: 'passthrough',
      },
    })
    await manager.assignProfile({
      deviceId: DEVICE,
      profile: 'low',
      camStreamId: 'derived:Mid to low',
    })
    const before = manager.getProfileSlotsForDevice(DEVICE)
    expect(before.find((s) => s.profile === 'high')?.sourceCamStreamId).toBe('native:main')
    expect(before.find((s) => s.profile === 'mid')?.sourceCamStreamId).toBe('native:slot-3')
    expect(before.find((s) => s.profile === 'low')?.sourceCamStreamId).toBe('derived:Mid to low')

    // Transient catalog: only sub. Physical main/slot-3 disappear — for long
    // enough (two pulls an interval apart, D689) that they ARE retracted.
    manager.setApiAccess(makeApi([full[2]!]))
    await reconcileTwiceAnIntervalApart(manager)
    expect(streamIds(manager)).not.toContain('native:main')

    const during = manager.getProfileSlotsForDevice(DEVICE)
    expect(during.find((s) => s.profile === 'high')?.sourceCamStreamId).toBe('native:main')
    expect(during.find((s) => s.profile === 'mid')?.sourceCamStreamId).toBe('native:slot-3')
    expect(during.find((s) => s.profile === 'low')?.sourceCamStreamId).toBe('derived:Mid to low')

    manager.setApiAccess(makeApi(full))
    await manager.reconcileDeviceCatalog(DEVICE)
    const after = manager.getProfileSlotsForDevice(DEVICE)
    expect(after.find((s) => s.profile === 'high')?.sourceCamStreamId).toBe('native:main')
    expect(after.find((s) => s.profile === 'mid')?.sourceCamStreamId).toBe('native:slot-3')
    expect(after.find((s) => s.profile === 'low')?.sourceCamStreamId).toBe('derived:Mid to low')
  })

  it('heals empty high/mid after auto=false when a derived still holds low', async () => {
    // Live 1438 / 618, 2026-08-17: assignProfile(derived → low) locks auto=false.
    // A catalog wipe (or a persisted empty map) leaves high/mid unassigned even
    // though native:main / native:slot-3 are back. Empty slots must refill from
    // unused natives without kicking the derived off low.
    const full: readonly CamStreamDescriptor[] = [
      {
        camStreamId: 'native:main',
        kind: 'pull-rtsp',
        url: 'rtsp://x/main',
        resolution: { width: 2560, height: 1440 },
      },
      {
        camStreamId: 'native:slot-3',
        kind: 'pull-rtsp',
        url: 'rtsp://x/slot3',
        resolution: { width: 1280, height: 720 },
      },
      {
        camStreamId: 'native:sub',
        kind: 'pull-rtsp',
        url: 'rtsp://x/sub',
        resolution: { width: 640, height: 360 },
      },
    ]
    manager.setApiAccess(makeApi(full))
    await manager.reconcileDeviceCatalog(DEVICE)
    await manager.publishCameraStream({
      deviceId: DEVICE,
      camStreamId: 'derived:Mid to low',
      kind: 'derived',
      source: { kind: 'profile', profile: 'mid' },
      encodeProfile: {
        video: { codec: 'h264', width: 640, height: 360 },
        audio: 'passthrough',
      },
    })
    await manager.assignProfile({
      deviceId: DEVICE,
      profile: 'low',
      camStreamId: 'derived:Mid to low',
    })
    await manager.unassignProfile({ deviceId: DEVICE, profile: 'high' })
    await manager.unassignProfile({ deviceId: DEVICE, profile: 'mid' })
    expect(
      manager.getProfileSlotsForDevice(DEVICE).find((s) => s.profile === 'high')?.sourceCamStreamId,
    ).toBeNull()

    await manager.reconcileDeviceCatalog(DEVICE)
    const slots = manager.getProfileSlotsForDevice(DEVICE)
    expect(slots.find((s) => s.profile === 'high')?.sourceCamStreamId).toBe('native:main')
    expect(slots.find((s) => s.profile === 'mid')?.sourceCamStreamId).toBe('native:slot-3')
    expect(slots.find((s) => s.profile === 'low')?.sourceCamStreamId).toBe('derived:Mid to low')
  })

  it('heals a fully empty auto=false map when natives republish', async () => {
    const full: readonly CamStreamDescriptor[] = [
      {
        camStreamId: 'native:main',
        kind: 'pull-rtsp',
        url: 'rtsp://x/main',
        resolution: { width: 2560, height: 1440 },
      },
      {
        camStreamId: 'native:slot-3',
        kind: 'pull-rtsp',
        url: 'rtsp://x/slot3',
        resolution: { width: 1280, height: 720 },
      },
      {
        camStreamId: 'native:sub',
        kind: 'pull-rtsp',
        url: 'rtsp://x/sub',
        resolution: { width: 640, height: 360 },
      },
    ]
    manager.setApiAccess(makeApi(full))
    await manager.loadPersistedProfileMap(new Map([[DEVICE, { map: {}, auto: false }]]))
    await manager.reconcileDeviceCatalog(DEVICE)
    const slots = manager.getProfileSlotsForDevice(DEVICE)
    expect(slots.find((s) => s.profile === 'high')?.sourceCamStreamId).toBe('native:main')
    expect(slots.find((s) => s.profile === 'mid')?.sourceCamStreamId).toBe('native:slot-3')
    expect(slots.find((s) => s.profile === 'low')?.sourceCamStreamId).toBe('native:sub')
  })

  it('does not park a derived on a slot when it is the only stream at first rank', async () => {
    // Live 618 after the empty-slot heal shipped: derived materialized at
    // boot BEFORE the catalog natives, autoEligible=false left the pool
    // empty, and the "rank ineligible streams anyway" fallback put the
    // transcode on a profile. Natives then filled around it. Never auto-rank
    // a derived.
    const full: readonly CamStreamDescriptor[] = [
      {
        camStreamId: 'native:main',
        kind: 'pull-rtsp',
        url: 'rtsp://x/main',
        resolution: { width: 2560, height: 1440 },
      },
      {
        camStreamId: 'native:slot-3',
        kind: 'pull-rtsp',
        url: 'rtsp://x/slot3',
        resolution: { width: 1280, height: 720 },
      },
      {
        camStreamId: 'native:sub',
        kind: 'pull-rtsp',
        url: 'rtsp://x/sub',
        resolution: { width: 640, height: 360 },
      },
    ]
    await manager.loadPersistedProfileMap(new Map([[DEVICE, { map: {}, auto: false }]]))
    await manager.publishCameraStream({
      deviceId: DEVICE,
      camStreamId: 'derived:Mid to low',
      kind: 'derived',
      source: { kind: 'profile', profile: 'mid' },
      encodeProfile: {
        video: { codec: 'h264', width: 640, height: 360 },
        audio: 'passthrough',
      },
    })
    expect(
      manager.getProfileSlotsForDevice(DEVICE).every((s) => s.sourceCamStreamId === null),
    ).toBe(true)

    manager.setApiAccess(makeApi(full))
    await manager.reconcileDeviceCatalog(DEVICE)
    const slots = manager.getProfileSlotsForDevice(DEVICE)
    expect(slots.find((s) => s.profile === 'high')?.sourceCamStreamId).toBe('native:main')
    expect(slots.find((s) => s.profile === 'mid')?.sourceCamStreamId).toBe('native:slot-3')
    expect(slots.find((s) => s.profile === 'low')?.sourceCamStreamId).toBe('native:sub')
  })
})
