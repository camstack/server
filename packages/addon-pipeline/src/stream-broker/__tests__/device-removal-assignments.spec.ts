/**
 * A PERMANENT device removal must not leave the deleted camera behind in the
 * broker's profile-slot map (A3), and a boot must not rehydrate a slot for a
 * device the registry no longer knows (A4).
 *
 * Both halves were live: deleting cameras 3217/3218 left them in
 * `listAllProfileSlots` forever — the DeviceUnregistered handler retracted the
 * streams with `preserveAssignments: true`, and the surviving `assignments`
 * entry was written straight back into the persisted `profileMap` blob, so the
 * deleted ids came back at every boot.
 */

import type { AddonApi, EventFilter, IEventBus, IScopedLogger, SystemEvent } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { retractRemovedDevice, subscribeDeviceRemoval } from '../device-removal.js'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager'

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

function makeEventBus(): IEventBus {
  const handlers = new Map<string, Set<(event: SystemEvent) => void>>()
  const bus: IEventBus = {
    emit(event: SystemEvent) {
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
      return []
    },
  }
  return bus
}

/** Minimal RTSP stand-ins so publish paths never bind a real port. */
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

interface DeviceRow {
  readonly id: number
  readonly type: string
  readonly isCamera: boolean
  readonly disabled: boolean
}

/** Fake `ctx.api` exposing only what the prune reads. */
function makeApi(listAll: () => Promise<readonly DeviceRow[]>): AddonApi {
  return {
    deviceManager: { listAll: { query: vi.fn(listAll) } },
  } as unknown as AddonApi
}

function cameraRow(id: number): DeviceRow {
  return { id, type: 'camera', isCamera: true, disabled: false }
}

function makeManager(): StreamBrokerManager {
  const manager = new StreamBrokerManager(makeLogger())
  manager.setEventBus(makeEventBus())
  stubRtsp(manager)
  return manager
}

const DELETED = 3217
const ALIVE = 101

// ── A3: permanent removal purges the assignments ─────────────────────

describe('retractDevice — permanent removal (A3)', () => {
  let manager: StreamBrokerManager

  beforeEach(() => {
    manager = makeManager()
  })

  it('drops the deleted device from listAllProfileSlots', async () => {
    await manager.publishCameraStream({
      deviceId: DELETED,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://main',
    })
    expect((await manager.listAllProfileSlots()).some((s) => s.deviceId === DELETED)).toBe(true)

    await manager.retractDevice(DELETED, { preserveAssignments: true, purgeAssignments: true })

    expect((await manager.listAllProfileSlots()).some((s) => s.deviceId === DELETED)).toBe(false)
  })

  it('persists the pruned profile map so the deletion survives a reboot', async () => {
    await manager.publishCameraStream({
      deviceId: DELETED,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://main',
    })
    await manager.publishCameraStream({
      deviceId: ALIVE,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://alive',
    })
    const persist = vi.fn()
    manager.setProfileMapPersister(persist)

    await manager.retractDevice(DELETED, { preserveAssignments: true, purgeAssignments: true })

    expect(persist).toHaveBeenCalled()
    const lastCall = persist.mock.calls.at(-1)
    if (!lastCall) throw new Error('persister never called')
    const persisted = lastCall[0] as ReadonlyMap<number, unknown>
    expect(persisted.has(DELETED)).toBe(false)
    expect(persisted.has(ALIVE)).toBe(true)
  })

  it('purges a device whose cam-streams are already gone', async () => {
    // The stream teardown and the meta removal are separate events: by the
    // time DeviceUnregistered lands the catalog reconcile may already have
    // retracted every stream, leaving ONLY the orphan assignment behind.
    await manager.publishCameraStream({
      deviceId: DELETED,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://main',
    })
    await manager.retractCameraStream({ deviceId: DELETED, camStreamId: 'native:main' })
    expect((await manager.listAllProfileSlots()).some((s) => s.deviceId === DELETED)).toBe(true)

    await manager.retractDevice(DELETED, { preserveAssignments: true, purgeAssignments: true })

    expect((await manager.listAllProfileSlots()).some((s) => s.deviceId === DELETED)).toBe(false)
  })

  it('a provider-restart retract (no purge) still keeps the operator slot choices', async () => {
    await manager.publishCameraStream({
      deviceId: ALIVE,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://main',
    })
    await manager.assignProfile({ deviceId: ALIVE, profile: 'high', camStreamId: 'native:main' })

    await manager.retractDevice(ALIVE, { preserveAssignments: true })

    const slots = await manager.listAllProfileSlots()
    expect(slots.find((s) => s.deviceId === ALIVE && s.profile === 'high')?.sourceCamStreamId).toBe(
      'native:main',
    )
  })
})

describe('DeviceUnregistered — the addon registration drives a PURGING retract (A3, D685)', () => {
  it('retracts the streams and purges the slots of the device the event names', async () => {
    const manager = makeManager()
    await manager.publishCameraStream({
      deviceId: DELETED,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://main',
    })
    await manager.publishCameraStream({
      deviceId: ALIVE,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://alive',
    })
    const bus = makeEventBus()
    const logger = makeLogger()
    // The SAME registration `StreamBrokerAddon.onInitialize` performs, with the
    // same deps shape (`deviceRemovalDeps`).
    subscribeDeviceRemoval(
      (filter, handler) => {
        bus.subscribe(filter, handler)
      },
      () => ({
        retractDevice: async (deviceId, opts) => {
          await manager.retractDevice(deviceId, opts)
        },
        logger,
      }),
    )

    bus.emit({
      id: 'evt-1',
      timestamp: new Date(),
      source: { type: 'core', id: 'device-manager' },
      category: EventCategory.DeviceUnregistered,
      data: { deviceId: DELETED },
    })
    await vi.waitFor(async () => {
      expect(manager.getCameraStreamsForDevice(DELETED)).toEqual([])
    })

    const slots = await manager.listAllProfileSlots()
    expect(slots.some((s) => s.deviceId === DELETED)).toBe(false)
    expect(manager.getCameraStreamsForDevice(ALIVE)).toHaveLength(1)
  })

  it('logs, and does not throw, when the retract fails', async () => {
    const logger = makeLogger()

    await expect(
      retractRemovedDevice(DELETED, {
        retractDevice: vi.fn().mockRejectedValue(new Error('boom')),
        logger,
      }),
    ).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      'device retract failed',
      expect.objectContaining({ tags: { deviceId: DELETED } }),
    )
  })
})

// ── A4: boot-time reconcile of the persisted profile map ─────────────

describe('loadPersistedProfileMap — boot prune (A4)', () => {
  let manager: StreamBrokerManager

  beforeEach(() => {
    manager = makeManager()
  })

  it('drops persisted entries whose device no longer exists', async () => {
    const persist = vi.fn()
    manager.setProfileMapPersister(persist)
    manager.setApiAccess(
      makeApi(async () => [cameraRow(ALIVE)]),
      'hub',
    )

    await manager.loadPersistedProfileMap(
      new Map([
        [ALIVE, { map: { high: 'native:main' }, auto: false }],
        [DELETED, { map: { high: 'native:main' }, auto: false }],
      ]),
    )

    const deviceIds = new Set((await manager.listAllProfileSlots()).map((s) => s.deviceId))
    expect(deviceIds.has(ALIVE)).toBe(true)
    expect(deviceIds.has(DELETED)).toBe(false)
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('prunes NOTHING when the device enumeration fails (D49)', async () => {
    const persist = vi.fn()
    manager.setProfileMapPersister(persist)
    manager.setApiAccess(
      makeApi(async () => {
        throw new Error('deviceManager unreachable')
      }),
      'hub',
    )

    await manager.loadPersistedProfileMap(
      new Map([[DELETED, { map: { high: 'native:main' }, auto: false }]]),
    )

    const deviceIds = new Set((await manager.listAllProfileSlots()).map((s) => s.deviceId))
    expect(deviceIds.has(DELETED)).toBe(true)
    expect(persist).not.toHaveBeenCalled()
  })

  it('prunes NOTHING when the enumeration comes back EMPTY (D49)', async () => {
    // Empty list + assignments present = device restore has probably not run.
    // Believing it would wipe the whole fleet's slot map on one bad boot.
    const persist = vi.fn()
    manager.setProfileMapPersister(persist)
    manager.setApiAccess(
      makeApi(async () => []),
      'hub',
    )

    await manager.loadPersistedProfileMap(
      new Map([
        [ALIVE, { map: { high: 'native:main' }, auto: false }],
        [DELETED, { map: { high: 'native:main' }, auto: false }],
      ]),
    )

    const deviceIds = new Set((await manager.listAllProfileSlots()).map((s) => s.deviceId))
    expect(deviceIds.has(ALIVE)).toBe(true)
    expect(deviceIds.has(DELETED)).toBe(true)
    expect(persist).not.toHaveBeenCalled()
  })

  it('prunes NOTHING when there is no api access yet', async () => {
    const persist = vi.fn()
    manager.setProfileMapPersister(persist)

    await manager.loadPersistedProfileMap(
      new Map([[DELETED, { map: { high: 'native:main' }, auto: false }]]),
    )

    const deviceIds = new Set((await manager.listAllProfileSlots()).map((s) => s.deviceId))
    expect(deviceIds.has(DELETED)).toBe(true)
    expect(persist).not.toHaveBeenCalled()
  })
})
