/**
 * `EventCategory.StorageLocationsChanged` — the doorbell that did not exist.
 *
 * The failure (D387): the operator added a second `recordings` location in the
 * admin UI and the recorder never noticed. It resolves its location set at
 * boot, on a storage migration, and on a hand-called `rescanStorage` — nothing
 * else — so the new 4 TB disk was not in the placement pool, not a write
 * target, and not in the census until `recording.rescanStorage` was called by
 * hand.
 *
 * Asserted through the CAP SURFACE the admin UI actually calls, not the
 * service: the emit lives in the cap dispatch, and a helper nobody reaches is
 * a doorbell nobody rings.
 */
import type {
  AddonContext,
  IEventBus,
  IScopedLogger,
  ISettingsStoreProvider,
  IStorageCapProvider,
  IStorageProviderImpl,
  StorageLocationDeclaration,
  SystemEvent,
} from '@camstack/types'
import { EventCategory, storageCapability } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StorageOrchestratorAddon } from '../storage-orchestrator.addon.js'

const PROVIDER_ID = 'filesystem-storage'

const DECLARATIONS: readonly StorageLocationDeclaration[] = [
  { id: 'recordings', displayName: 'Recordings', cardinality: 'multi', access: 'local-path' },
]

function makeLogger(): IScopedLogger {
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
    withTags: vi.fn(),
  }
  logger.child.mockReturnValue(logger)
  logger.withTags.mockReturnValue(logger)
  // Documented type boundary: the addon reaches only these six.
  return logger as unknown as IScopedLogger
}

function makeProvider(): IStorageProviderImpl {
  const impl = {
    getProviderInfo: async () => ({
      providerId: PROVIDER_ID,
      displayName: 'Local filesystem',
      configSchema: { sections: [] },
      nodeLocal: true,
      shouldSaveDiskSpace: false,
    }),
    testLocation: async () => ({ ok: true }),
  }
  // Documented type boundary: only these two are reached on the paths here.
  return impl as unknown as IStorageProviderImpl
}

function makeEngine(): ISettingsStoreProvider {
  const rows = new Map<string, unknown>()
  const engine = {
    declareCollection: async () => {},
    query: async () => [...rows.values()],
    insert: async ({ record }: { record: { id: string } }) => {
      rows.set(record.id, record)
    },
    deleteWhere: async ({ filter }: { filter: { where?: Record<string, unknown> } }) => {
      const id = filter.where?.['id']
      if (typeof id === 'string' && rows.delete(id)) return { deleted: 1 }
      return { deleted: 0 }
    },
  }
  // Documented type boundary: `SqliteLocationStore` calls exactly these four.
  return engine as unknown as ISettingsStoreProvider
}

interface Harness {
  readonly addon: StorageOrchestratorAddon
  readonly storage: IStorageCapProvider
  readonly emitted: SystemEvent[]
  readonly logger: IScopedLogger
}

/** Boot the real addon. `withBus: false` reproduces a host that injects none. */
async function boot(withBus: boolean): Promise<Harness> {
  const emitted: SystemEvent[] = []
  const bus = {
    emit: (event: SystemEvent) => {
      emitted.push(event)
    },
    subscribe: () => () => {},
  }
  const logger = makeLogger()
  const collections: Record<string, readonly unknown[]> = {
    'storage-provider': [makeProvider()],
    'data-store-provider': [makeEngine()],
    'storage-evictable': [],
  }
  const ctx = {
    logger,
    nodeDataDir: '/tmp/camstack-test-data',
    // Documented type boundary: only `emit` and `subscribe` are reached.
    ...(withBus ? { eventBus: bus as unknown as IEventBus } : {}),
    kernel: {
      localNodeId: 'hub',
      capabilityRegistry: {
        getCollection: (name: string): readonly unknown[] => collections[name] ?? [],
      },
      listStorageLocationDeclarations: (): readonly (readonly StorageLocationDeclaration[])[] => [
        DECLARATIONS,
      ],
    },
  }
  const addon = new StorageOrchestratorAddon()
  // Documented type boundary: `AddonContext` is the kernel's full injection
  // surface; the orchestrator reads the handful of fields assembled above.
  const result = await addon.initialize(ctx as unknown as AddonContext)
  const registrations =
    result && 'providers' in result && result.providers ? result.providers : undefined
  const entry = registrations?.find((r) => r.capability.name === storageCapability.name)
  if (!entry) throw new Error('storage capability was not registered')
  // Documented type boundary: the registration erases the provider type.
  return { addon, storage: entry.provider as IStorageCapProvider, emitted, logger }
}

const NEW_DISK = {
  id: 'recordings:recordings-high-4tb',
  type: 'recordings',
  displayName: '4 TB recordings',
  providerId: PROVIDER_ID,
  config: { basePath: '/recordings-2' },
  isSystem: false,
}

function locationEvents(events: readonly SystemEvent[]): readonly SystemEvent[] {
  return events.filter((e) => e.category === EventCategory.StorageLocationsChanged)
}

describe('the storage cap announces a change to the location SET (D387)', () => {
  let harness: Harness | null = null

  afterEach(async () => {
    await harness?.addon.shutdown()
    harness = null
  })

  it('rings the doorbell when a location is created', async () => {
    harness = await boot(true)
    await harness.storage.upsertLocation(NEW_DISK)

    const rung = locationEvents(harness.emitted)
    expect(rung).toHaveLength(1)
    expect(rung[0]?.data).toMatchObject({
      locationId: NEW_DISK.id,
      locationType: 'recordings',
      reason: 'upsert',
    })
  })

  it('rings it again when the same location is EDITED — enabled, drained, renamed', async () => {
    harness = await boot(true)
    await harness.storage.upsertLocation(NEW_DISK)
    await harness.storage.upsertLocation({ ...NEW_DISK, enabled: true })

    expect(locationEvents(harness.emitted)).toHaveLength(2)
  })

  it('rings it when a location is deleted, and names the type it had', async () => {
    harness = await boot(true)
    await harness.storage.upsertLocation(NEW_DISK)
    await harness.storage.deleteLocation({ id: NEW_DISK.id, force: true })

    const rung = locationEvents(harness.emitted)
    expect(rung).toHaveLength(2)
    expect(rung[1]?.data).toMatchObject({
      locationId: NEW_DISK.id,
      locationType: 'recordings',
      reason: 'delete',
    })
  })

  it('a bus that will not take the event never fails the upsert — the row IS saved', async () => {
    harness = await boot(false)

    const saved = await harness.storage.upsertLocation(NEW_DISK)

    expect(saved.id).toBe(NEW_DISK.id)
    // And it says so: a silent swallow reads as "the doorbell rang".
    expect(harness.logger.warn).toHaveBeenCalled()
  })
})
