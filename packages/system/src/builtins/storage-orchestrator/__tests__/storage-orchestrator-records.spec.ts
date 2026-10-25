import type {
  AddonContext,
  IScopedLogger,
  ISettingsStoreProvider,
  IStorageProviderImpl,
  RecordsAccess,
  StorageLocationDeclaration,
} from '@camstack/types'
import { createRecordsAccess, normalizeNodeId, storageCapability } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { SqliteDrainStateStore } from '../drain-state-store.js'
import { SqliteLocationStore } from '../location-store.js'
import { storageOrchestratorRecordKinds } from '../record-kinds.js'
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
  return impl as unknown as IStorageProviderImpl
}

async function bootOrchestrator(options: {
  readonly localNodeId: string
  readonly records?: RecordsAccess
  readonly dataStoreEngine?: ISettingsStoreProvider | null
}): Promise<{ declareMock: ReturnType<typeof vi.fn> }> {
  const declareMock = vi.fn(async () => {
    throw new Error("Service 'records.records.declareKinds' is not found.")
  })
  const records =
    options.records ??
    ({
      declare: declareMock,
    } as unknown as RecordsAccess)
  const collections: Record<string, readonly unknown[]> = {
    'storage-provider': [makeProvider()],
    ...(options.dataStoreEngine !== null
      ? { 'data-store-provider': [options.dataStoreEngine ?? makeInMemoryEngine()] }
      : {}),
    'storage-evictable': [],
  }
  const ctx = {
    logger: makeLogger(),
    nodeDataDir: '/tmp/camstack-test-data',
    records,
    kernel: {
      localNodeId: options.localNodeId,
      capabilityRegistry: {
        getCollection: (name: string): readonly unknown[] => collections[name] ?? [],
      },
      listStorageLocationDeclarations: (): readonly (readonly StorageLocationDeclaration[])[] => [
        DECLARATIONS,
      ],
    },
  }
  const addon = new StorageOrchestratorAddon()
  const result = await addon.initialize(ctx as unknown as AddonContext)
  const registrations =
    result && 'providers' in result && result.providers ? result.providers : undefined
  const entry = registrations?.find((r) => r.capability.name === storageCapability.name)
  if (!entry) throw new Error('storage capability was not registered')
  return { declareMock }
}

function makeInMemoryEngine(): ISettingsStoreProvider {
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
  return engine as unknown as ISettingsStoreProvider
}

describe('storage-orchestrator — records path', () => {
  it('does not declare legacy storage_locations or storage_drain_state', async () => {
    const declared: string[] = []
    const legacy = {
      declareCollection: async ({ collection }: { collection: string }) => {
        declared.push(collection)
      },
      query: async () => [],
      insert: async () => {},
      deleteWhere: async () => {},
      set: async () => {},
      get: async () => null,
      update: async () => {},
      delete: async () => {},
    }
    const world = makeRecordsWorld()
    await world.provider.init()
    const records = createRecordsAccess({
      owner: 'storage-orchestrator',
      transport: world.transportFor('storage-orchestrator'),
      secrets: null,
    })
    await records.declare(storageOrchestratorRecordKinds)
    const locations = new SqliteLocationStore(
      legacy as unknown as ISettingsStoreProvider,
      SqliteLocationStore.recordStoresOf(records),
    )
    const drain = new SqliteDrainStateStore(
      legacy as unknown as ISettingsStoreProvider,
      SqliteDrainStateStore.recordStoresOf(records),
    )
    await locations.upsert({
      id: 'recordings:default',
      type: 'recordings',
      displayName: 'Default',
      providerId: 'filesystem',
      config: { basePath: '/mnt/rec' },
      isSystem: true,
      createdAt: 1,
      updatedAt: 2,
    })
    await drain.save({
      locationId: 'recordings:default',
      startedAtMs: 100,
      startBytes: 1,
      capBytes: 2,
      lastPeerBytes: null,
      lastSweepMs: 200,
      observedGrowthBytes: 0,
      observedElapsedMs: 0,
    })
    expect(declared).toEqual([])
    expect((await locations.loadAll())[0]?.id).toBe('recordings:default')
    expect((await drain.load())[0]?.locationId).toBe('recordings:default')
  })

  it('throws when records-path upsert body fails schema validation', async () => {
    const legacy = {
      declareCollection: async () => {},
      query: async () => [],
      insert: async () => {},
      deleteWhere: async () => {},
      set: async () => {},
      get: async () => null,
      update: async () => {},
      delete: async () => {},
    }
    const world = makeRecordsWorld()
    await world.provider.init()
    const records = createRecordsAccess({
      owner: 'storage-orchestrator',
      transport: world.transportFor('storage-orchestrator'),
      secrets: null,
    })
    await records.declare(storageOrchestratorRecordKinds)
    const locationsKind = SqliteLocationStore.recordStoresOf(records)
    const locations = new SqliteLocationStore(
      legacy as unknown as ISettingsStoreProvider,
      locationsKind,
    )
    const putSpy = vi.spyOn(locationsKind, 'put')
    await expect(
      locations.upsert({
        id: 'recordings:default',
        type: 'INVALID' as 'recordings',
        displayName: 'Default',
        providerId: 'filesystem',
        config: { basePath: '/mnt/rec' },
        isSystem: true,
        createdAt: 1,
        updatedAt: 2,
      }),
    ).rejects.toThrow()
    expect(putSpy).not.toHaveBeenCalled()
  })

  it('throws when records-path save body fails schema validation', async () => {
    const legacy = {
      declareCollection: async () => {},
      query: async () => [],
      insert: async () => {},
      deleteWhere: async () => {},
      set: async () => {},
      get: async () => null,
      update: async () => {},
      delete: async () => {},
    }
    const world = makeRecordsWorld()
    await world.provider.init()
    const records = createRecordsAccess({
      owner: 'storage-orchestrator',
      transport: world.transportFor('storage-orchestrator'),
      secrets: null,
    })
    await records.declare(storageOrchestratorRecordKinds)
    const drainKind = SqliteDrainStateStore.recordStoresOf(records)
    const drain = new SqliteDrainStateStore(legacy as unknown as ISettingsStoreProvider, drainKind)
    const putSpy = vi.spyOn(drainKind, 'put')
    const badState = {
      locationId: 'recordings:default',
      startedAtMs: 'not-a-number',
      startBytes: 1,
      capBytes: 2,
      lastPeerBytes: null,
      lastSweepMs: 200,
      observedGrowthBytes: 0,
      observedElapsedMs: 0,
    }
    await expect(
      drain.save(badState as unknown as Parameters<typeof drain.save>[0]),
    ).rejects.toThrow()
    expect(putSpy).not.toHaveBeenCalled()
  })
})

describe('storage-orchestrator — records declare on boot', () => {
  it('does not call records.declare on a non-hub node even when ctx.records is present', async () => {
    const { declareMock } = await bootOrchestrator({
      localNodeId: 'agent-win-1',
      dataStoreEngine: null,
    })
    expect(declareMock).not.toHaveBeenCalled()
  })

  it('calls records.declare on the hub when ctx.records is present', async () => {
    const world = makeRecordsWorld()
    await world.provider.init()
    const records = createRecordsAccess({
      owner: 'storage-orchestrator',
      transport: world.transportFor('storage-orchestrator'),
      secrets: null,
    })
    const declareSpy = vi.spyOn(records, 'declare')
    await bootOrchestrator({ localNodeId: 'hub', records })
    expect(declareSpy).toHaveBeenCalledOnce()
    expect(declareSpy.mock.calls[0]?.[0]).toEqual(storageOrchestratorRecordKinds)
  })

  it('calls records.declare when localNodeId is a forked hub runner id', async () => {
    const world = makeRecordsWorld()
    await world.provider.init()
    const records = createRecordsAccess({
      owner: 'storage-orchestrator',
      transport: world.transportFor('storage-orchestrator'),
      secrets: null,
    })
    const declareSpy = vi.spyOn(records, 'declare')
    await bootOrchestrator({ localNodeId: 'hub/storage-orchestrator', records })
    expect(normalizeNodeId('hub/storage-orchestrator')).toBe('hub')
    expect(declareSpy).toHaveBeenCalledOnce()
  })
})
