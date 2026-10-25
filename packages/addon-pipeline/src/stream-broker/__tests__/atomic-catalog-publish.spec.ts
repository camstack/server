/**
 * Atomic catalog publish — rank ONCE, order-invariant, no transient reshuffle.
 *
 * Guards the behavior introduced by `publishCatalog` (commit "atomic
 * publishCatalog — rank profiles once over the full catalog"):
 * `reconcileDeviceCatalog` upserts the FULL source set, ranks the profiles a
 * SINGLE time, then publishes — so subscribers never observe an intermediate,
 * wrong profile assignment.
 *
 * The worst-case catalog feeds the SOURCE streams with `main` NOT first
 * (ext → main → sub). On the OLD per-descriptor `publishCameraStream` loop the
 * broker re-ranked + emitted after every stream, so after publishing `ext`
 * alone it would persist + emit `mid → native:ext` (one stream → `mid`), and
 * after publishing `ext` + `main` it would emit an intermediate `high → ...`
 * snapshot reflecting a partial catalog. Concretely the loop produced at least
 * one transient `onProfileSlotsChanged` where `high`'s `sourceCamStreamId` was
 * `native:ext` (ext briefly the largest seen stream) before `main` arrived and
 * displaced it. This test asserts NO such transient emit reaches subscribers
 * and that the cold catalog emits exactly ONCE.
 *
 * Harness: mirrors startup-catalog-reconcile.spec.ts exactly — same manager
 * construction (`makeManager`), same RTSP stubs, same `streamCatalog.getCatalog`
 * provider stub. It additionally wires a recording event-bus stub
 * (`setEventBus`) so the `camera-streams.onProfileSlotsChanged` emits are
 * observable per-emit, and validates each captured payload cast-free via the
 * shared `ProfileSlotSchema`.
 */

import type {
  AddonApi,
  CamStreamDescriptor,
  EventFilter,
  IEventBus,
  IScopedLogger,
  ProfileSlot,
  SystemEvent,
} from '@camstack/types'
import { ProfileSlotSchema } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'

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

/**
 * Stub out the RTSP layer so publish paths don't try to bind a real port.
 * Mirrors startup-catalog-reconcile.spec.ts.
 */
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

function makeManager(): StreamBrokerManager {
  const manager = new StreamBrokerManager(makeLogger())
  stubRtsp(manager)
  return manager
}

/**
 * A recording event bus. Captures every emitted `SystemEvent` in order so the
 * test can replay the exact sequence subscribers observed. `subscribe`/
 * `getRecent` are provided for the listeners `setEventBus` wires up internally
 * (placeholder state sources) — they record nothing relevant here.
 */
function makeRecordingEventBus(): { bus: IEventBus; emitted: SystemEvent[] } {
  const emitted: SystemEvent[] = []
  const bus: IEventBus = {
    emit: (event: SystemEvent) => {
      emitted.push(event)
    },
    subscribe: (_filter: EventFilter, _handler: (event: SystemEvent) => void) => () => {},
    getRecent: (_filter?: EventFilter, _limit?: number): readonly SystemEvent[] => [],
  }
  return { bus, emitted }
}

/**
 * Build a fake AddonApi whose `streamCatalog.getCatalog` returns the supplied
 * descriptors for the device. Same shape as startup-catalog-reconcile.spec.ts.
 */
function makeApi(descriptors: readonly CamStreamDescriptor[]): AddonApi {
  return {
    deviceManager: {
      listAll: {
        query: vi.fn(async () => [{ id: 7, type: 'camera', isCamera: true, disabled: false }]),
      },
    },
    streamCatalog: {
      getCatalog: { query: vi.fn(async () => descriptors) },
    },
  } as unknown as AddonApi
}

// ── Catalog fixtures (worst-case order: main NOT first) ──────────────

const DEVICE_ID = 7

const EXT: CamStreamDescriptor = {
  camStreamId: 'native:ext',
  kind: 'pull-rtsp',
  url: 'rtsp://x/ext',
  resolution: { width: 1280, height: 720 },
}
const MAIN: CamStreamDescriptor = {
  camStreamId: 'native:main',
  kind: 'pull-rtsp',
  url: 'rtsp://x/main',
  resolution: { width: 3840, height: 2160 },
}
const SUB: CamStreamDescriptor = {
  camStreamId: 'native:sub',
  kind: 'pull-rtsp',
  url: 'rtsp://x/sub',
  resolution: { width: 640, height: 360 },
}

// Worst case for the old per-stream loop: the largest stream (main) is NOT
// published first, so a per-descriptor loop would briefly rank `ext` (then the
// largest seen) into `high` before `main` arrives and displaces it.
const WORST_CASE_ORDER: readonly CamStreamDescriptor[] = [EXT, MAIN, SUB]

const ProfileSlotsPayloadSchema = z.object({
  deviceId: z.number(),
  profileSlots: z.array(ProfileSlotSchema),
})

function profileSlotsFromEvent(event: SystemEvent): readonly ProfileSlot[] | null {
  if (event.category !== 'camera-streams.onProfileSlotsChanged') return null
  const parsed = ProfileSlotsPayloadSchema.safeParse(event.data)
  return parsed.success ? parsed.data.profileSlots : null
}

function slotFor(
  slots: readonly ProfileSlot[],
  profile: 'high' | 'mid' | 'low',
): ProfileSlot | undefined {
  return slots.find((s) => s.profile === profile)
}

// ── Tests ────────────────────────────────────────────────────────────

describe('atomic catalog publish', () => {
  let manager: StreamBrokerManager

  beforeEach(() => {
    manager = makeManager()
  })

  afterEach(async () => {
    await manager.destroyAll()
  })

  it('ranks the full catalog once: high→main, mid→ext, low→sub regardless of pull order', async () => {
    manager.setApiAccess(makeApi(WORST_CASE_ORDER))

    await manager.reconcileDeviceCatalog(DEVICE_ID)

    const slots = manager.getProfileSlotsForDevice(DEVICE_ID)
    expect(slotFor(slots, 'high')?.sourceCamStreamId).toBe('native:main')
    expect(slotFor(slots, 'mid')?.sourceCamStreamId).toBe('native:ext')
    expect(slotFor(slots, 'low')?.sourceCamStreamId).toBe('native:sub')
  })

  it('produces an identical final mapping when the catalog is fed in a different order (order-invariant)', async () => {
    // Reverse order — sub, main, ext. The ranking is by pixel count, so the
    // final mapping must be byte-for-byte identical to the worst-case order.
    manager.setApiAccess(makeApi([SUB, MAIN, EXT]))

    await manager.reconcileDeviceCatalog(DEVICE_ID)

    const slots = manager.getProfileSlotsForDevice(DEVICE_ID)
    expect(slotFor(slots, 'high')?.sourceCamStreamId).toBe('native:main')
    expect(slotFor(slots, 'mid')?.sourceCamStreamId).toBe('native:ext')
    expect(slotFor(slots, 'low')?.sourceCamStreamId).toBe('native:sub')
  })

  it('never emits a transient wrong assignment to subscribers and publishes exactly once', async () => {
    const { bus, emitted } = makeRecordingEventBus()
    manager.setEventBus(bus)
    manager.setApiAccess(makeApi(WORST_CASE_ORDER))

    await manager.reconcileDeviceCatalog(DEVICE_ID)

    // Collect every profile-slots snapshot that reached subscribers.
    const slotEmits = emitted
      .map(profileSlotsFromEvent)
      .filter((slots): slots is readonly ProfileSlot[] => slots !== null)

    // (a) NO emitted snapshot ever points `high` at the wrong intermediate
    //     source (`native:ext` — what the per-stream loop briefly assigned).
    for (const slots of slotEmits) {
      expect(slotFor(slots, 'high')?.sourceCamStreamId).not.toBe('native:ext')
    }

    // (b) The cold catalog ranks + assigns once → exactly ONE
    //     assignment-changing `onProfileSlotsChanged` emit (atomic publish),
    //     not one-per-stream.
    expect(slotEmits).toHaveLength(1)

    // (c) That single snapshot already carries the correct final mapping.
    const finalSlots = slotEmits[0]!
    expect(slotFor(finalSlots, 'high')?.sourceCamStreamId).toBe('native:main')
    expect(slotFor(finalSlots, 'mid')?.sourceCamStreamId).toBe('native:ext')
    expect(slotFor(finalSlots, 'low')?.sourceCamStreamId).toBe('native:sub')
  })

  it('serializes unregister behind an in-flight catalog pull, then republishes without losing slots', async () => {
    const getCatalog = vi.fn(async () => WORST_CASE_ORDER)
    manager.setApiAccess({
      ...makeApi(WORST_CASE_ORDER),
      streamCatalog: { getCatalog: { query: getCatalog } },
    } as unknown as AddonApi)
    await manager.reconcileDeviceCatalog(DEVICE_ID)
    await manager.assignProfile({
      deviceId: DEVICE_ID,
      profile: 'high',
      camStreamId: 'native:main',
    })
    await manager.assignProfile({
      deviceId: DEVICE_ID,
      profile: 'mid',
      camStreamId: 'native:ext',
    })
    await manager.assignProfile({
      deviceId: DEVICE_ID,
      profile: 'low',
      camStreamId: 'native:sub',
    })

    let finishPull!: (catalog: readonly CamStreamDescriptor[]) => void
    getCatalog.mockImplementationOnce(
      () =>
        new Promise<readonly CamStreamDescriptor[]>((resolve) => {
          finishPull = resolve
        }),
    )
    const inFlightPull = manager.reconcileDeviceCatalog(DEVICE_ID)
    await vi.waitFor(() => expect(getCatalog).toHaveBeenCalledTimes(2))

    const unregister = manager.retractDevice(DEVICE_ID, { preserveAssignments: true })
    const reregister = manager.reconcileDeviceCatalog(DEVICE_ID)
    await Promise.resolve()

    expect(await manager.getBroker({ brokerId: `${DEVICE_ID}/native:main` })).not.toBeNull()

    finishPull(WORST_CASE_ORDER)
    await Promise.all([inFlightPull, unregister, reregister])

    const slots = manager.getProfileSlotsForDevice(DEVICE_ID)
    expect(slotFor(slots, 'high')?.sourceCamStreamId).toBe('native:main')
    expect(slotFor(slots, 'mid')?.sourceCamStreamId).toBe('native:ext')
    expect(slotFor(slots, 'low')?.sourceCamStreamId).toBe('native:sub')
    expect(await manager.getBroker({ brokerId: `${DEVICE_ID}/native:main` })).not.toBeNull()
  })
})
