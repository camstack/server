/**
 * A seed never runs while the store it seeds is not authoritative (D49, D315).
 *
 * Prod 2026-10-19: the hub seeded `recordings:default` & co. at boot, 38 s
 * BEFORE the storage-locations kind held the operator's rows; the seeded rows
 * shadowed the operator's own and the volume probe failed for 36 h.
 */
import type {
  AddonContext,
  IScopedLogger,
  ISettingsStoreProvider,
  IStorageProviderImpl,
  StorageLocation,
  StorageLocationDeclaration,
} from '@camstack/types'
import { createRecordsAccess } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import type { ILocationStore } from '../location-store.js'
import { storageOrchestratorRecordKinds } from '../record-kinds.js'
import { StorageOrchestratorAddon } from '../storage-orchestrator.addon.js'
import { StorageOrchestratorService } from '../storage-orchestrator.service.js'

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never
const DECLS = [{ id: 'recordings', displayName: 'R', cardinality: 'multi' }] as const

function seed(svc: StorageOrchestratorService) {
  svc.setRegistry({ cardinalityOf: () => 'multi', accessOf: () => 'local-path', list: () => [] })
  return svc.seedDefaults({
    providerId: 'filesystem-storage',
    basePath: '/data',
    declarations: DECLS,
  })
}

const operatorRow: StorageLocation = {
  id: 'recordings:main',
  type: 'recordings',
  displayName: 'Operator',
  providerId: 'filesystem-storage',
  config: { basePath: '/mnt/real' },
  isSystem: false,
  createdAt: 1,
  updatedAt: 1,
  mode: 'active',
}

function storeOf(load: () => Promise<readonly StorageLocation[]>): ILocationStore {
  return { loadAll: load, upsert: async () => {}, delete: async () => {} }
}

describe('seedDefaults waits for an answered store read', () => {
  it('(b) a store that has not answered (read failed) -> no seed', async () => {
    const svc = new StorageOrchestratorService(logger, () => [], null)
    svc.setStoreRequiredForSeed(true)
    await expect(
      svc.attachStore(storeOf(async () => Promise.reject(new Error('db busy')))),
    ).rejects.toThrow('db busy')
    expect(seed(svc)).toEqual({ added: 0, deferred: 'store-not-answered' })
    expect(svc.listLocations()).toEqual([])
  })

  it('(c) an ANSWERED empty store -> seeds', async () => {
    const svc = new StorageOrchestratorService(logger, () => [], null)
    svc.setStoreRequiredForSeed(true)
    await svc.attachStore(storeOf(async () => []))
    expect(seed(svc).added).toBe(1)
    expect(svc.getLocationById('recordings:default')).toBeDefined()
  })

  it('an answered store that holds a location of the type -> no seed, operator row kept', async () => {
    const svc = new StorageOrchestratorService(logger, () => [], null)
    svc.setStoreRequiredForSeed(true)
    await svc.attachStore(storeOf(async () => [operatorRow]))
    expect(seed(svc).added).toBe(0)
    expect(svc.listLocations().map((l) => l.id)).toEqual(['recordings:main'])
  })

  it('a node with no store by design still seeds in memory', () => {
    const svc = new StorageOrchestratorService(logger, () => [], null)
    expect(seed(svc).added).toBe(1)
  })

  it('a seeded row is born with the node pin a created row gets (provider classified)', () => {
    const svc = new StorageOrchestratorService(logger, () => [], null)
    svc.setNodeLocalResolver(() => true)
    seed(svc)
    const row = svc.getLocationById('recordings:default')
    expect(row?.nodeId).toBe('hub')
    expect(row?.mode).toBe('active')
  })

  it('an unclassified provider defers the seed instead of birthing a pin-less row', () => {
    const svc = new StorageOrchestratorService(logger, () => [], null)
    svc.setNodeLocalResolver(() => undefined)
    expect(seed(svc)).toEqual({ added: 0, deferred: 'provider-unclassified' })
    expect(svc.listLocations()).toEqual([])
  })
})

describe('(a) the hub does not wire persistence or seed while the kind cannot be declared', () => {
  it('stays store-less and seeds nothing until the declaration succeeds', async () => {
    let pending = true
    const world = makeRecordsWorld()
    await world.provider.init()
    const records = createRecordsAccess({
      owner: 'storage-orchestrator',
      transport: world.transportFor('storage-orchestrator'),
      secrets: null,
    })
    const realDeclare = records.declare.bind(records)
    const declare = vi.spyOn(records, 'declare').mockImplementation(async (kinds) => {
      if (pending && declare.mock.calls.length > 1) throw new Error('records: engine not ready')
      return realDeclare(kinds)
    })
    const put = vi.spyOn(records.kind(storageOrchestratorRecordKinds.locations), 'put')
    const engine = {
      declareCollection: async () => {},
      query: async () => [],
    } as unknown as ISettingsStoreProvider
    const collections: Record<string, unknown[]> = {
      'storage-provider': [
        {
          getProviderInfo: async () => ({
            providerId: 'filesystem-storage',
            displayName: 'fs',
            configSchema: { sections: [] },
            nodeLocal: true,
            shouldSaveDiskSpace: false,
          }),
        } as unknown as IStorageProviderImpl,
      ],
      'storage-evictable': [],
    }
    const log = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
    }
    log.child.mockReturnValue(log)
    log.withTags.mockReturnValue(log)
    const listeners: Array<(e: { data: unknown }) => void> = []
    const decls: readonly StorageLocationDeclaration[] = [
      { id: 'recordings', displayName: 'R', cardinality: 'multi', access: 'local-path' },
    ]
    const ctx = {
      logger: log as unknown as IScopedLogger,
      nodeDataDir: '/tmp/seed-wait',
      records,
      eventBus: {
        subscribe: (_f: unknown, cb: (e: { data: unknown }) => void) => {
          listeners.push(cb)
          return () => {}
        },
      },
      kernel: {
        localNodeId: 'hub',
        capabilityRegistry: {
          getCollection: (n: string): readonly unknown[] => collections[n] ?? [],
        },
        listStorageLocationDeclarations: () => [decls],
      },
    }
    const addon = new StorageOrchestratorAddon()
    await addon.initialize(ctx as unknown as AddonContext)
    // the engine registers late (as on a real boot) while the declaration fails
    collections['data-store-provider'] = [engine]
    for (const l of listeners) l({ data: { capability: 'storage-provider' } })
    await vi.waitFor(() => expect(declare.mock.calls.length).toBeGreaterThan(1))
    await new Promise((r) => setTimeout(r, 20))
    expect(put).not.toHaveBeenCalled()

    pending = false
    for (const l of listeners) l({ data: { capability: 'storage-provider' } })
    await vi.waitFor(() => expect(put).toHaveBeenCalled())
  })
})

describe('an operator delete of a seeded default sticks', () => {
  function memoryStore(rows: StorageLocation[], seeded: string[]) {
    return {
      rows,
      seeded,
      loadAll: async () => [...rows],
      upsert: async (l: StorageLocation) => void rows.push(l),
      delete: async (id: string) =>
        void rows.splice(
          rows.findIndex((r) => r.id === id),
          1,
        ),
      loadSeededTypes: async () => [...seeded],
      markTypeSeeded: async (t: string) => void seeded.push(t),
    }
  }
  async function boot(store: ReturnType<typeof memoryStore>) {
    const svc = new StorageOrchestratorService(logger, () => [], null)
    svc.setStoreRequiredForSeed(true)
    await svc.attachStore(store)
    return svc
  }

  it('fresh install seeds and remembers; delete + reboot does not re-seed', async () => {
    const store = memoryStore([], [])
    const first = await boot(store)
    expect(seed(first).added).toBe(1)
    await vi.waitFor(() => expect(store.seeded).toEqual(['recordings']))
    // the operator adds their own row, then deletes the seeded default
    store.rows.length = 0
    store.rows.push(operatorRow)
    const second = await boot(store)
    expect(seed(second).added).toBe(0)
    store.rows.length = 0 // operator deletes everything of the type
    const third = await boot(store)
    expect(seed(third).added).toBe(0)
    expect(third.listLocations()).toEqual([])
  })

  it('an install older than the memory is not re-seeded for a type it lacks', async () => {
    const other = { ...operatorRow, id: 'logs:main', type: 'logs' as const }
    const store = memoryStore([other], [])
    const svc = await boot(store)
    expect(seed(svc).added).toBe(0)
    expect(svc.getLocationById('recordings:default')).toBeUndefined()
    await vi.waitFor(() => expect(store.seeded).toContain('recordings'))
  })
})
