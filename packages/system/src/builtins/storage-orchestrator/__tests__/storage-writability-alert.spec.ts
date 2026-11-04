/**
 * The orchestrator RAISES the alert when a declared type has nowhere to write,
 * and clears it when a writable location exists again — through the cap surface
 * the admin UI calls, so a monitor nobody triggers would fail here.
 *
 * (Harness shared in shape with storage-locations-changed-event.spec.ts.)
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
  StorageLocationDeclarer,
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

function makeEngine(preloaded: readonly { id: string; data: unknown }[]): ISettingsStoreProvider {
  const rows = new Map<string, unknown>(preloaded.map((r) => [r.id, r]))
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
async function boot(
  withBus: boolean,
  preloaded: readonly { id: string; data: unknown }[],
): Promise<Harness> {
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
    'data-store-provider': [makeEngine(preloaded)],
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
      listStorageLocationDeclarers: (): StorageLocationDeclarer[] => [
        {
          addonId: 'recorder',
          packageName: '@camstack/addon-recorder',
          loaded: true,
          declarations: [...DECLARATIONS],
        },
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

const FINDING = 'storage:no-writable-location:recordings'

function findings(events: readonly SystemEvent[]) {
  return events
    .filter(
      (e) =>
        e.category === EventCategory.SystemLivenessFailed ||
        e.category === EventCategory.SystemLivenessRecovered,
    )
    .map((e) => ({ category: e.category, findingId: e.data['findingId'] }))
}

describe('the orchestrator alerts when a declared type has no writable location', () => {
  let harness: Harness | null = null

  afterEach(async () => {
    await harness?.addon.shutdown()
    harness = null
  })

  // The shape of a hub hit by the 2026-11-01 prune: other types' rows exist, the
  // seed memory does not cover `recordings`, so nothing re-creates its default.
  it('raises when a declared type has no row, resolves when a writable one is added', async () => {
    harness = await boot(true, [
      {
        id: 'logs:default',
        data: {
          id: 'logs:default',
          type: 'logs',
          display_name: 'Logs',
          provider_id: PROVIDER_ID,
          config: { basePath: '/data/logs' },
          is_default: 0,
          is_system: 0,
          created_at: 1,
          updated_at: 1,
        },
      },
    ])
    await vi.waitFor(() => expect(findings(harness!.emitted)).toHaveLength(1))
    expect(findings(harness.emitted)).toEqual([
      { category: EventCategory.SystemLivenessFailed, findingId: FINDING },
    ])
    const raised = harness.emitted.find((e) => e.data['findingId'] === FINDING)
    expect(raised?.data['href']).toBe('/system/storage')

    await harness.storage.upsertLocation({
      id: 'recordings:main',
      type: 'recordings',
      displayName: 'Main',
      providerId: PROVIDER_ID,
      config: { basePath: '/recordings' },
      isSystem: false,
    })
    expect(findings(harness.emitted)).toEqual([
      { category: EventCategory.SystemLivenessFailed, findingId: FINDING },
      { category: EventCategory.SystemLivenessRecovered, findingId: FINDING },
    ])
  })
})
