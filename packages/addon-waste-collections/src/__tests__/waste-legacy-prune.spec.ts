/**
 * The records are the only store: a source still in the legacy `sources` setting (migration not
 * landed) is NOT served. Deleting a source that also sits there must not let the migration copy it
 * into a record when it lands. The legacy setting
 * itself is never written: the deletion is remembered as a tombstone instead (D986, P10).
 */
import {
  type AddonContext,
  integrationInstancesCapability,
  makeInMemoryRecords,
  type SecretsAccess,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { wasteSourcePortsOver } from '../migrations/ports.js'
import { WasteCollectionsAddon } from '../waste-collections.addon.js'
import { plainWasteSourceKind } from '../waste-source-record-kinds.js'

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
  withTags: () => noopLogger,
}

const LEGACY = [
  {
    id: 'home',
    label: 'Home',
    module: 'ics',
    args: { url: 'https://example.com/h.ics' },
    enabled: true,
  },
  {
    id: 'cabin',
    label: 'Cabin',
    module: 'ics',
    args: { url: 'https://example.com/c.ics' },
    enabled: true,
  },
]

type World = ReturnType<typeof makeInMemoryRecords>

async function boot(
  world: World = makeInMemoryRecords('waste-collections'),
  secrets: SecretsAccess = world.secrets,
  legacy: readonly unknown[] = LEGACY,
) {
  const settings = { store: { sources: structuredClone(legacy) } as Record<string, unknown> }
  const context = {
    id: 'waste-collections',
    logger: noopLogger,
    eventBus: { emit: () => undefined, subscribe: () => () => undefined, getRecent: () => [] },
    settings: {
      readAddonStore: async () => structuredClone(settings.store),
      readAddonStoreResult: async () => ({ kind: 'value', value: structuredClone(settings.store) }),
      writeAddonStore: async (patch: Record<string, unknown>) => {
        settings.store = { ...settings.store, ...structuredClone(patch) }
      },
      readDeviceStore: async () => ({}),
      writeDeviceStore: async () => undefined,
    },
    dataDir: '/nonexistent',
    kernel: { localNodeId: 'hub' },
    // The migration engine is unreachable: the step reports "not declared" and stays pending.
    api: {
      migrations: {
        declareOwner: {
          mutate: async () => {
            throw new Error('engine down')
          },
        },
        startMigration: { mutate: async () => undefined },
        finishMigration: { mutate: async () => undefined },
      },
    },
    // The ports are built from the migration API only (planning#447): the addon's own settings
    // store, its records and its keychain, over the same doubles the context carries.
    migrationApi: {
      settings: {
        read: async () => ({ store: structuredClone(settings.store) }),
        write: async () => ({}),
        deleteKeys: async () => ({ removed: [] }),
      },
      secrets: {
        resolve: async ({ refs }: { refs: string[] }) => ({
          values: Object.fromEntries(refs.map((ref) => [ref, null])),
        }),
      },
      log: { info: async () => ({}), warn: async () => ({}) },
      records: {
        kind: (definition: Parameters<typeof world.records.kind>[0]) => {
          const h = world.records.kind(definition)
          return {
            get: ({ id }: { id: string }) => h.get(id),
            getResolved: ({ id }: { id: string }) => h.getResolved(id),
            put: ({ ifRev, ...row }: { ifRev?: number; id: string; data: never }) =>
              h.put(row, ifRev === undefined ? undefined : { ifRev }),
            query: (q: { limit?: number }) => h.query({ limit: q.limit ?? 100 }),
          }
        },
      },
    },
    records: world.records,
    secrets,
    deps: {
      ensurePython: async () => {
        throw new Error('no python in this spec')
      },
    },
  }
  const addon = new WasteCollectionsAddon()
  const result = await addon.initialize(context as unknown as AddonContext)
  const holder =
    result === undefined
      ? undefined
      : result.providers?.find((p) => p.capability.name === integrationInstancesCapability.name)
  return { addon, settings, holder }
}

describe('a delete of a pending legacy row is remembered, not written into the settings', () => {
  it('an unmigrated legacy row is not served; deleting the instance remembers it and leaves the setting alone', async () => {
    const { addon, settings, holder } = await boot()
    expect(addon.configuredSources()).toEqual([])
    const provider = holder?.provider
    if (typeof provider !== 'object' || provider === null || !('deleteInstance' in provider)) {
      throw new Error('the addon registered no integration-instances provider')
    }
    if (typeof provider.deleteInstance !== 'function') throw new Error('no deleteInstance')
    await provider.deleteInstance({ id: 'cabin' })
    const legacy = settings.store['sources'] as { id: string }[]
    expect(legacy.map((r) => r.id)).toEqual(['home', 'cabin'])
    expect(settings.store['deletedLegacySourceIds']).toEqual(['cabin'])
  })

  it('a boot whose credentials cannot be sealed stays on the plain kind and still serves them; the next boot seals', async () => {
    const world = makeInMemoryRecords('waste-collections')
    await world.records.declare({ 'waste-source': plainWasteSourceKind })
    await world.records.kind(plainWasteSourceKind).put({
      id: 'home',
      data: { name: 'Home', module: 'junker_app', args: { city: 'Torino', password: 'hunter2' } },
    })
    const locked: SecretsAccess = {
      ...world.secrets,
      put: async () => {
        throw new Error('keychain locked')
      },
    }
    const first = await boot(world, locked, [])
    expect(first.addon.configuredSources().map((s) => s.args['password'])).toEqual(['hunter2'])

    const second = await boot(world, world.secrets, [])
    expect(second.addon.configuredSources().map((s) => s.args['password'])).toEqual(['hunter2'])
    expect(JSON.stringify([...world.tables.values()])).not.toContain('hunter2')
  })

  it('deleting a source never rewrites the legacy setting, so a plaintext credential in it is not touched either way', async () => {
    const withPassword = (id: string) => ({
      id,
      label: id,
      module: 'junker_app',
      args: { city: 'Torino', password: `hunter2-${id}` },
      enabled: true,
    })
    const seed = [withPassword('home'), withPassword('cabin')]
    const { addon, settings, holder } = await boot(
      makeInMemoryRecords('waste-collections'),
      undefined,
      seed,
    )
    const provider = holder?.provider
    if (typeof provider !== 'object' || provider === null || !('deleteInstance' in provider)) {
      throw new Error('the addon registered no integration-instances provider')
    }
    if (typeof provider.deleteInstance !== 'function') throw new Error('no deleteInstance')
    await provider.deleteInstance({ id: 'cabin' })
    expect(settings.store['sources']).toEqual(seed)
    expect(addon.configuredSources()).toEqual([])
  })

  it('the migration ports never offer a deleted legacy row to the copy', async () => {
    const world = makeInMemoryRecords('waste-collections')
    const api = {
      settings: { read: async () => ({ store: { sources: structuredClone(LEGACY) } }) },
      secrets: { resolve: async () => ({ values: {} }) },
      log: { info: async () => ({}), warn: async () => ({}) },
      records: { kind: () => world.records.kind(plainWasteSourceKind) },
    }
    const ports = wasteSourcePortsOver(
      api as unknown as Parameters<typeof wasteSourcePortsOver>[0],
      plainWasteSourceKind,
      new Set(['cabin']),
    )
    const answer = await ports.readStored('sources')
    if (answer.kind !== 'present') throw new Error('the legacy rows were not served')
    expect((answer.value as { id: string }[]).map((r) => r.id)).toEqual(['home'])
  })
})
