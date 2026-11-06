/**
 * Deleting a source that also sits in the legacy `sources` setting removes that row too, or it
 * would reappear beside the records (migration pending) or be copied back by the migration.
 */
import { type AddonContext, makeInMemoryRecords, type SecretsAccess } from '@camstack/types'
import { describe, expect, it } from 'vitest'
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
    records: world.records,
    secrets,
    deps: {
      ensurePython: async () => {
        throw new Error('no python in this spec')
      },
    },
  }
  const addon = new WasteCollectionsAddon()
  await addon.initialize(context as unknown as AddonContext)
  return { addon, settings }
}

describe('a delete also removes the legacy row', () => {
  it('deleteSource drops the legacy row, so it neither returns nor is copied back', async () => {
    const { addon, settings } = await boot()
    expect(
      addon
        .configuredSources()
        .map((s) => s.id)
        .toSorted(),
    ).toEqual(['cabin', 'home'])
    await addon.deleteSource({ id: 'cabin' })
    const legacy = settings.store['sources'] as { id: string }[]
    expect(legacy.map((r) => r.id)).toEqual(['home'])
    expect(addon.configuredSources().map((s) => s.id)).toEqual(['home'])
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
})
