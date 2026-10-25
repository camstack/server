/**
 * A deleted camera must stop serving its last JPEG (S1).
 *
 * The snapshot cache had no eviction on device removal, so a deleted device
 * kept answering with the frame it happened to hold when it went away —
 * indefinitely, because the stale-serving contract ("keep the UI from going
 * blank") has no upper bound on age.
 *
 * Two paths, per D8/D11: the `DeviceUnregistered` event is the fast one, and
 * because events are lossy telemetry the stale-serve path re-checks existence
 * as the reconcile backstop.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  EventCategory,
  snapshotCapability,
  type AddonContext,
  type CapabilityDefinition,
  type EventFilter,
  type InferProvider,
  type IScopedLogger,
  type SystemEvent,
} from '@camstack/types'
import { SnapshotAddon } from '../snapshot.addon.js'
import { freshSnapshotDataDir } from './scratch-data-dir.js'

type ISnapshotProvider = InferProvider<typeof snapshotCapability>

const DELETED = 3217

function makeLogger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger
}

interface Harness {
  readonly ctx: AddonContext
  readonly logger: IScopedLogger
  readonly emit: (event: SystemEvent) => void
  readonly getDevice: ReturnType<typeof vi.fn>
  readonly nativeCalls: () => number
  readonly setNative: (value: { base64: string; contentType: string } | null) => void
  readonly failNative: (err: Error | null) => void
}

interface HarnessOptions {
  /** `null` → device-manager answers "no such device". */
  readonly deviceRow?: Record<string, unknown> | null
  /** Throw instead of answering — the read FAILED, which is not a deletion. */
  readonly lookupThrows?: boolean
}

function makeHarness(opts: HarnessOptions = {}): Harness {
  const logger = makeLogger()
  const handlers = new Map<string, Set<(event: SystemEvent) => void>>()
  let nativeValue: { base64: string; contentType: string } | null = {
    base64: 'RlJBTUU=',
    contentType: 'image/jpeg',
  }
  let nativeError: Error | null = null
  let nativeCalls = 0

  const getDevice = vi.fn(async ({ deviceId }: { deviceId: number }) => {
    if (opts.lookupThrows) throw new Error('device-manager unreachable')
    if (opts.deviceRow === null) return null
    return (
      opts.deviceRow ?? {
        id: deviceId,
        name: 'test-cam',
        features: [],
        disabled: false,
        online: true,
      }
    )
  })

  const addonStore: Record<string, unknown> = {}
  const ctx = {
    id: 'snapshot',
    logger,
    eventBus: {
      emit: vi.fn(),
      subscribe: (filter: EventFilter, handler: (event: SystemEvent) => void) => {
        const cat =
          typeof filter === 'object' && 'category' in filter && typeof filter.category === 'string'
            ? filter.category
            : '*'
        const set = handlers.get(cat) ?? new Set()
        set.add(handler)
        handlers.set(cat, set)
        return () => {
          handlers.get(cat)?.delete(handler)
        }
      },
    },
    addonConfig: {},
    dataDir: freshSnapshotDataDir(),
    kernel: { localNodeId: 'hub', devices: {} as never },
    settings: {
      // A REAL store, not a write-swallower. The wrapper reads back the link
      // secret it just wrote to prove the store is answering; a fake that
      // accepts a write and then reports empty is indistinguishable from a
      // settings store that is down, and would make every test look like the
      // degraded path.
      readAddonStore: vi.fn(async () => ({ ...addonStore })),
      writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
        Object.assign(addonStore, patch)
      }),
      readDeviceStore: vi.fn(async () => ({})),
      writeDeviceStore: vi.fn(async () => undefined),
      getSection: vi.fn(async () => ({})),
      setSection: vi.fn(async () => undefined),
    },
    api: {
      deviceManager: { getDevice: { query: getDevice } },
      pipelineOrchestrator: {
        getIngestOwner: { query: vi.fn(async () => ({ ownerNodeId: 'hub' })) },
      },
      streamBroker: {
        getAllRtspEntries: { query: vi.fn(async () => []) },
        listAllProfileSlots: { query: vi.fn(async () => []) },
      },
    } as never,
    getNativeProvider: vi.fn((cap: CapabilityDefinition) => {
      if (cap.name !== 'snapshot') return null
      return {
        getSnapshot: vi.fn(async () => {
          nativeCalls += 1
          if (nativeError) throw nativeError
          return nativeValue
        }),
        invalidateCache: vi.fn(async () => undefined),
      }
    }),
    fetchDevice: vi.fn(async () => ({ deviceId: DELETED, state: {} })),
  } as unknown as AddonContext

  return {
    ctx,
    logger,
    emit: (event) => {
      for (const h of handlers.get(event.category) ?? []) h(event)
    },
    getDevice,
    nativeCalls: () => nativeCalls,
    setNative: (value) => {
      nativeValue = value
    },
    failNative: (err) => {
      nativeError = err
    },
  }
}

async function initProvider(addon: SnapshotAddon, ctx: AddonContext): Promise<ISnapshotProvider> {
  const result = await addon.initialize(ctx)
  const list = (Array.isArray(result) ? result : (result?.providers ?? [])) as ReadonlyArray<{
    readonly provider: ISnapshotProvider
  }>
  const first = list[0]
  if (!first) throw new Error('no provider registered')
  return first.provider
}

function deviceUnregistered(deviceId: number): SystemEvent {
  return {
    id: 'evt-1',
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.DeviceUnregistered,
    data: { deviceId, providerId: 'provider-test', parentDeviceId: null },
  } as unknown as SystemEvent
}

describe('SnapshotAddon — cache eviction on device removal (S1)', () => {
  let addon: SnapshotAddon

  beforeEach(() => {
    addon = new SnapshotAddon()
  })

  it('drops the cached frame when DeviceUnregistered fires', async () => {
    const h = makeHarness()
    const provider = await initProvider(addon, h.ctx)

    expect(await provider.getSnapshot({ deviceId: DELETED })).not.toBeNull()
    expect(h.nativeCalls()).toBe(1)

    h.emit(deviceUnregistered(DELETED))

    // A cache hit would have answered without touching the native again.
    h.setNative(null)
    expect(await provider.getSnapshot({ deviceId: DELETED })).toBeNull()
    expect(h.nativeCalls()).toBe(2)
  })

  it('logs the eviction at info, tagged with the deviceId', async () => {
    const h = makeHarness()
    await initProvider(addon, h.ctx)
    h.emit(deviceUnregistered(DELETED))
    expect(h.logger.info).toHaveBeenCalledWith(
      'snapshot: dropped cache for removed device',
      expect.objectContaining({ tags: { deviceId: DELETED } }),
    )
  })

  it('does not serve a STALE frame for a device that no longer exists', async () => {
    // The reconcile backstop: the event above is lossy telemetry, so a stale
    // hit past `staleTtlMs` re-asks whether the device is still there.
    const h = makeHarness()
    const provider = await initProvider(addon, h.ctx)
    expect(await provider.getSnapshot({ deviceId: DELETED })).not.toBeNull()

    h.getDevice.mockResolvedValue(null)
    h.failNative(new Error('camera gone'))

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 120_000) // > staleTtlMs (60s)
      expect(await provider.getSnapshot({ deviceId: DELETED })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
    expect(h.logger.info).toHaveBeenCalledWith(
      'snapshot: dropped cache for removed device',
      expect.objectContaining({ tags: { deviceId: DELETED } }),
    )
  })

  it('KEEPS serving a stale frame for a device that still exists', async () => {
    // The "keep the UI from going blank" contract is deliberate and unchanged
    // for a live camera that is merely unreachable.
    const h = makeHarness()
    const provider = await initProvider(addon, h.ctx)
    const fresh = await provider.getSnapshot({ deviceId: DELETED })
    expect(fresh).not.toBeNull()

    h.failNative(new Error('camera unreachable'))

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 120_000)
      expect(await provider.getSnapshot({ deviceId: DELETED })).toEqual(fresh)
    } finally {
      vi.useRealTimers()
    }
  })

  it('KEEPS serving a stale frame when the existence read FAILS (D49)', async () => {
    const h = makeHarness()
    const provider = await initProvider(addon, h.ctx)
    const fresh = await provider.getSnapshot({ deviceId: DELETED })
    expect(fresh).not.toBeNull()

    h.getDevice.mockRejectedValue(new Error('device-manager unreachable'))
    h.failNative(new Error('camera unreachable'))

    vi.useFakeTimers()
    try {
      vi.setSystemTime(Date.now() + 120_000)
      expect(await provider.getSnapshot({ deviceId: DELETED })).toEqual(fresh)
    } finally {
      vi.useRealTimers()
    }
  })
})
