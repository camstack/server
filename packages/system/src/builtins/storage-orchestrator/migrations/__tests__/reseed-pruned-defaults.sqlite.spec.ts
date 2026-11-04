/**
 * The one-shot repair for the 2026-11-01 prune (D1006), on the REAL records engine.
 *
 * The prune deleted `<type>:default` and, in the build that shipped it, left the type's seed
 * marker behind: "seeded once, no row" reads as an operator's delete, so nothing ever
 * re-created the row. The repair is safe to run on that shape alone because the service
 * refuses to delete or disable the last enabled location of a type, so an operator cannot
 * produce "marker, zero rows" through the UI.
 */
import type { ISettingsStoreProvider, StorageLocationDeclaration } from '@camstack/types'
import { createRecordsAccess, defineAddonMigrations } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeRecordsWorld } from '../../../sqlite-storage/__tests__/support/records-world.js'
import { SqliteLocationStore } from '../../location-store.js'
import { storageOrchestratorRecordKinds } from '../../record-kinds.js'
import { StorageOrchestratorService } from '../../storage-orchestrator.service.js'
import { ADDON_MIGRATIONS } from '../index.js'

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }
const RECORDINGS: StorageLocationDeclaration = {
  id: 'recordings',
  displayName: 'Recordings',
  cardinality: 'multi',
  access: 'local-path',
  defaultRoot: 'media',
}
const LOGS: StorageLocationDeclaration = {
  id: 'logs',
  displayName: 'Logs',
  cardinality: 'single',
  access: 'local-path',
}
const NOT_USED = {} as unknown as ISettingsStoreProvider

const registry = (declared: readonly StorageLocationDeclaration[]) => ({
  cardinalityOf: (id: string) => declared.find((d) => d.id === id)?.cardinality ?? null,
  accessOf: () => 'local-path' as const,
  list: () => declared,
})

async function boot(declared: readonly StorageLocationDeclaration[]) {
  const world = makeRecordsWorld()
  await world.provider.init()
  const records = createRecordsAccess({
    owner: 'storage-orchestrator',
    transport: world.transportFor('storage-orchestrator'),
    secrets: null,
  })
  await records.declare(storageOrchestratorRecordKinds)
  const store = new SqliteLocationStore(
    NOT_USED,
    SqliteLocationStore.recordStoresOf(records),
    SqliteLocationStore.seedMarkersOf(records),
  )
  const input = {
    providerId: 'filesystem-storage',
    basePath: '/data',
    mediaBasePath: '/media',
    declarations: declared,
  }
  /** A fresh process over the same file: what a restart sees. */
  const restart = async () => {
    const svc = new StorageOrchestratorService(logger as never, () => [], null)
    await svc.attachStore(store)
    svc.setRegistry(registry(declared))
    return svc
  }
  const run = (svc: StorageOrchestratorService) => {
    const entry = ADDON_MIGRATIONS[0]
    if (entry === undefined || !('procedure' in entry)) throw new Error('procedure entry missing')
    return entry.procedure({ reseed: () => svc.reseedPrunedDefaults(input) })
  }
  return { store, input, restart, run }
}

describe('reseed-pruned-defaults (real SQLite)', () => {
  it('re-seeds a type with a marker, zero rows and a declaration, onto the media root', async () => {
    const { store, input, restart, run } = await boot([RECORDINGS, LOGS])
    // The state the bug left: both seeded once, the prune took recordings:default only.
    const first = await restart()
    first.seedDefaults(input)
    await new Promise((r) => setTimeout(r, 0))
    await store.delete('recordings:default')

    const svc = await restart()
    expect(svc.getLocationById('recordings:default')).toBeUndefined()
    expect((await store.loadSeededTypes()).includes('recordings')).toBe(true)

    const outcome = await run(svc)
    expect(outcome.outcome).toBe('done')
    expect(outcome.summary).toEqual({ types: ['recordings'] })
    expect(svc.getLocationById('recordings:default')?.config['basePath']).toContain('/media')
    expect(JSON.stringify(logger.info.mock.calls)).toContain('seed-marker-without-rows')
    // Persisted, not only in memory.
    await new Promise((r) => setTimeout(r, 0))
    expect((await store.loadAll()).some((l) => l.id === 'recordings:default')).toBe(true)
  })

  it('leaves a type that still has its row untouched', async () => {
    const { store, input, restart, run } = await boot([RECORDINGS, LOGS])
    const first = await restart()
    first.seedDefaults(input)
    await new Promise((r) => setTimeout(r, 0))
    await store.delete('recordings:default')
    const svc = await restart()
    const logsBefore = svc.getLocationById('logs:default')
    await run(svc)
    expect(svc.getLocationById('logs:default')).toEqual(logsBefore)
    expect(svc.listLocations().filter((l) => l.type === 'logs')).toHaveLength(1)
  })

  it('cannot see an operator delete: the service refuses to remove the last location of a type', async () => {
    const { input, restart } = await boot([RECORDINGS])
    const svc = await restart()
    svc.seedDefaults(input)
    await expect(svc.deleteLocation('recordings:default')).rejects.toThrow(/only location/)
    expect(() =>
      svc.upsertLocation({ ...svc.getLocationById('recordings:default')!, enabled: false }),
    ).toThrow(/last enabled location/)
    expect(svc.getLocationById('recordings:default')).toBeDefined()
  })

  it('is a no-op on a second run', async () => {
    const { store, input, restart, run } = await boot([RECORDINGS])
    const first = await restart()
    first.seedDefaults(input)
    await new Promise((r) => setTimeout(r, 0))
    await store.delete('recordings:default')
    const svc = await restart()
    expect((await run(svc)).outcome).toBe('done')
    const again = await run(svc)
    expect(again.outcome).toBe('already-done')
    expect(svc.listLocations().filter((l) => l.type === 'recordings')).toHaveLength(1)
  })

  it('is offered through the ledger catalogue as tolerate', () => {
    const bound = defineAddonMigrations(ADDON_MIGRATIONS, { reseed: () => [] })
    expect(bound).toHaveLength(1)
    expect(ADDON_MIGRATIONS[0]!.meta.onFailure).toBe('tolerate')
  })
})
