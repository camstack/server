/**
 * Unit tests for `StorageOrchestratorService` persistence wiring
 * (Task 6 of the storage-unification refactor).
 *
 * Drive the service through a fake `ILocationStore` (in-memory
 * Map-backed) so we cover the contract without needing a real SQLite
 * file. The real `SqliteLocationStore` is exercised end-to-end by
 * the addon's boot path once Task 7 lands.
 */

import type { IScopedLogger, StorageLocation } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ILocationStore } from '../location-store.js'
import { StorageOrchestratorService } from '../storage-orchestrator.service.js'

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

interface FakeLocationStore extends ILocationStore {
  readonly rows: Map<string, StorageLocation>
  readonly upsertCalls: StorageLocation[]
  readonly deleteCalls: string[]
}

function makeFakeStore(seed: readonly StorageLocation[] = []): FakeLocationStore {
  const rows = new Map<string, StorageLocation>(seed.map((l) => [l.id, l]))
  const upsertCalls: StorageLocation[] = []
  const deleteCalls: string[] = []
  return {
    rows,
    upsertCalls,
    deleteCalls,
    async loadAll() {
      return [...rows.values()]
    },
    async upsert(loc) {
      upsertCalls.push(loc)
      rows.set(loc.id, loc)
    },
    async delete(id) {
      deleteCalls.push(id)
      rows.delete(id)
    },
  }
}

function makeLocation(input: {
  id: string
  type: StorageLocation['type']
  providerId: string
}): StorageLocation {
  const now = Date.now()
  return {
    id: input.id,
    type: input.type,
    displayName: input.id,
    providerId: input.providerId,
    config: {},
    isSystem: false,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Wait for any queued microtasks to settle. The orchestrator's
 * upsert/delete fire-and-forget the persistence write via
 * `void store.upsert(...)` — we need a microtask flush before
 * asserting on the fake store.
 */
async function flushAsync(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('StorageOrchestratorService persistence', () => {
  let store: FakeLocationStore
  let service: StorageOrchestratorService

  beforeEach(() => {
    store = makeFakeStore()
    service = new StorageOrchestratorService(makeLogger(), () => [], store)
  })

  it('hydrates from store on initialize()', async () => {
    const seeded = [
      makeLocation({
        id: 'backups:default',
        type: 'backups',
        providerId: 'fs',
      }),
      makeLocation({
        id: 'recordings:default',
        type: 'recordings',
        providerId: 'fs',
      }),
      makeLocation({
        id: 'logs:default',
        type: 'logs',
        providerId: 'fs',
      }),
    ]
    store = makeFakeStore(seeded)
    service = new StorageOrchestratorService(makeLogger(), () => [], store)

    await service.initialize()

    const all = service.listLocations()
    expect(all).toHaveLength(3)
    const ids = new Set(all.map((l) => l.id))
    expect(ids).toEqual(new Set(['backups:default', 'recordings:default', 'logs:default']))
  })

  it('initialize() with no store is a no-op', async () => {
    const noStoreService = new StorageOrchestratorService(makeLogger(), () => [], null)
    await expect(noStoreService.initialize()).resolves.toBeUndefined()
    expect(noStoreService.listLocations()).toHaveLength(0)
  })

  it('upsert persists the new location to the store', async () => {
    service.upsertLocation({
      id: 'backups:nas',
      type: 'backups',
      displayName: 'NAS',
      providerId: 'sftp',
      config: { host: 'nas.local' },
      isSystem: false,
    })
    await flushAsync()

    expect(store.rows.size).toBe(1)
    const persisted = store.rows.get('backups:nas')
    expect(persisted?.providerId).toBe('sftp')
    expect(persisted?.config['host']).toBe('nas.local')
  })

  // Deleted (D383): "upsert with isDefault demotes prior default in-memory AND
  // in store" — upsert no longer demotes siblings; `isDefault` is retired and
  // several enabled locations of a type coexist in the write set by design.
  // `setWriteTargets` is the only verb that moves the write set now, and its
  // enable/disable-together behaviour is covered in
  // `storage-migration-coordinator.spec.ts`.

  /**
   * This spec is about PERSISTENCE — that a delete reaches the store — and it
   * used to seed a single `recordings` location and delete it. That stopped
   * being a legal delete when `deleteLocation` gained its uniqueness guard: a
   * type may never lose its last location. The spec had been red on main ever
   * since, asserting nothing, while the rule it tripped over is covered on
   * purpose in `storage-orchestrator.spec.ts` ("refuses the only enabled
   * location of a type").
   *
   * So it seeds a sibling. The delete is legal, and the assertion is once again
   * about the store rather than about the guard standing in front of it.
   */
  it('delete removes from store', async () => {
    for (const id of ['recordings:scratch', 'recordings:keep']) {
      service.upsertLocation({
        id,
        type: 'recordings',
        displayName: id,
        providerId: 'fs',
        config: {},
        isSystem: false,
        // Explicit: the guard counts ENABLED siblings, and a location that
        // omits the flag does not count as one. The sibling exists to make the
        // delete legal, so it has to be live.
        enabled: true,
      })
    }
    await flushAsync()
    expect(store.rows.size).toBe(2)

    service.setOccupancyProbe(async () => 'empty')
    await service.deleteLocation('recordings:scratch')
    await flushAsync()

    expect(store.rows.size).toBe(1)
    expect(store.rows.has('recordings:keep')).toBe(true)
    expect(store.deleteCalls).toContain('recordings:scratch')
  })

  it('idempotent re-seed after restart: seed -> persist -> reload -> reseed produces same count', async () => {
    // Boot 1 — empty DB. Seed defaults.
    await service.initialize()
    service.seedDefaults({
      providerId: 'fs',
      basePath: '/tmp/r',
      declarations: [
        { id: 'backups', displayName: 'Backups', cardinality: 'multi' },
        { id: 'recordings', displayName: 'Recordings', cardinality: 'multi' },
        { id: 'logs', displayName: 'Logs', cardinality: 'single' },
      ],
    })
    await flushAsync()
    expect(service.listLocations()).toHaveLength(3)
    expect(store.rows.size).toBe(3)

    // Boot 2 — DB hydrates with the same 3 rows. Re-seeding finds
    // every type already present (via hasAnyLocationOfType) and
    // inserts nothing.
    const service2 = new StorageOrchestratorService(makeLogger(), () => [], store)
    await service2.initialize()
    expect(service2.listLocations()).toHaveLength(3)

    service2.seedDefaults({
      providerId: 'fs',
      basePath: '/tmp/r',
      declarations: [
        { id: 'backups', displayName: 'Backups', cardinality: 'multi' },
        { id: 'recordings', displayName: 'Recordings', cardinality: 'multi' },
        { id: 'logs', displayName: 'Logs', cardinality: 'single' },
      ],
    })
    await flushAsync()

    // Still 3 — no second copy of each default got persisted.
    expect(service2.listLocations()).toHaveLength(3)
    expect(store.rows.size).toBe(3)
  })

  it('attachStore (late wiring): hydrates DB over early in-memory seeds AND persists in-memory-only locations', async () => {
    // Boot reality: settings-store cap isn't ready at orchestrator
    // onInitialize, so the service starts WITHOUT a store and seeds
    // defaults in-memory. The store appears later (provider registers).
    const noStore = new StorageOrchestratorService(makeLogger(), () => [])
    expect(noStore.hasStore()).toBe(false)

    // Early in-memory seed: two defaults (basePath-only).
    noStore.seedDefaults({
      providerId: 'fs',
      basePath: '/tmp/r',
      declarations: [
        { id: 'recordings', displayName: 'Recordings', cardinality: 'multi' },
        { id: 'logs', displayName: 'Logs', cardinality: 'single' },
      ],
    })

    // The DB already holds an operator-edited `recordings:default`
    // (minFreePercent set on a prior boot) that must WIN over the
    // freshly-seeded basePath-only copy.
    const dbRecordings = makeLocation({
      id: 'recordings:default',
      type: 'recordings',
      providerId: 'fs',
    })
    const lateStore = makeFakeStore([
      {
        ...dbRecordings,
        config: { basePath: '/tmp/r/recordings', minFreePercent: 2 },
      },
    ])

    await noStore.attachStore(lateStore)

    expect(noStore.hasStore()).toBe(true)
    // DB value wins for the hydrated id (operator config preserved).
    const rec = noStore.listLocations().find((l) => l.id === 'recordings:default')
    expect(rec?.config['minFreePercent']).toBe(2)
    // The in-memory-only default (`logs:default`, absent from the DB) got persisted.
    expect(lateStore.rows.has('logs:default')).toBe(true)
    // Subsequent edits persist normally now the store is wired.
    noStore.upsertLocation({
      ...rec!,
      config: { ...rec!.config, minFreePercent: 5 },
    })
    await flushAsync()
    expect(lateStore.rows.get('recordings:default')?.config['minFreePercent']).toBe(5)
  })

  it('attachStore is idempotent — a second attach with a different store is ignored', async () => {
    const first = makeFakeStore()
    await service.initialize()
    await service.attachStore(first) // already has the ctor store → no-op wire
    expect(service.hasStore()).toBe(true)
  })

  /**
   * The re-entry guard must latch on a SUCCESSFUL hydrate, never on the attempt.
   *
   * `attachStore` used to set `this.locationStore = store` BEFORE awaiting
   * `loadAll()`. A single transient read error then had three compounding
   * effects, none of them logged as data loss:
   *
   *  1. `hasStore()` answered true forever, so the addon's `ensureStoreWired`
   *     gate (`if (service.hasStore()) return`) skipped every later
   *     `capability:provider-registered` retry — nothing ever rehydrated;
   *  2. the service ran for the whole process lifetime on the pre-store SEED
   *     DEFAULTS, which have no `minFreePercent`;
   *  3. every subsequent `upsert` mirrored those seed defaults onto rows it had
   *     never read — silently replacing the operator's persisted
   *     `minFreePercent` on disk.
   *
   * Latching after the load closes all three: a failed hydrate leaves the
   * service store-less, which is the pre-existing in-memory-only mode, and an
   * in-memory-only service writes NOTHING over the operator's rows.
   *
   * Neutralisation check: move the `this.locationStore = store` assignment back
   * above `await store.loadAll()` and this test fails on all three assertions.
   */
  it('attachStore does not latch on a FAILED load — the operator config survives and a retry rehydrates it', async () => {
    const noStore = new StorageOrchestratorService(makeLogger(), () => [])
    noStore.seedDefaults({
      providerId: 'fs',
      basePath: '/tmp/r',
      declarations: [{ id: 'recordings', displayName: 'Recordings', cardinality: 'multi' }],
    })
    // The pre-store seed has no operator config — that is the whole hazard.
    const seeded = noStore.listLocations().find((l) => l.id === 'recordings:default')
    expect(seeded?.config['minFreePercent']).toBeUndefined()

    // What is really on disk: the value the operator set on a previous boot.
    const good = makeFakeStore([
      {
        ...makeLocation({
          id: 'recordings:default',
          type: 'recordings',
          providerId: 'fs',
        }),
        config: { basePath: '/tmp/r/recordings', minFreePercent: 25 },
      },
    ])
    // Same backing rows, but the boot read fails once.
    const flaky: ILocationStore = {
      loadAll: async () => {
        throw new Error('settings store unavailable')
      },
      upsert: good.upsert,
      delete: good.delete,
    }

    await expect(noStore.attachStore(flaky)).rejects.toThrow('settings store unavailable')

    // 1. The guard did not latch, so the addon's retry gate is still open.
    expect(noStore.hasStore()).toBe(false)

    // 2. An ordinary mutation while store-less must not reach the disk the
    //    failed load never read. This is the write that used to destroy the
    //    operator's setting.
    noStore.upsertLocation({
      ...seeded!,
      config: { basePath: '/tmp/r/recordings' },
    })
    await flushAsync()
    expect(good.rows.get('recordings:default')?.config['minFreePercent']).toBe(25)

    // 3. The retry hydrates for real and the operator's value comes back.
    await noStore.attachStore(good)
    expect(noStore.hasStore()).toBe(true)
    expect(
      noStore.listLocations().find((l) => l.id === 'recordings:default')?.config['minFreePercent'],
    ).toBe(25)
  })

  it('does not call store on services constructed without a store', async () => {
    const noStoreService = new StorageOrchestratorService(makeLogger(), () => [], null)
    noStoreService.upsertLocation({
      id: 'backups:default',
      type: 'backups',
      displayName: 'Backups',
      providerId: 'fs',
      config: {},
      isSystem: false,
    })
    await flushAsync()
    // Sanity — original `store` (unused by this service) saw nothing.
    expect(store.rows.size).toBe(0)
    // The location is still in-memory.
    expect(noStoreService.listLocations()).toHaveLength(1)
  })
})
