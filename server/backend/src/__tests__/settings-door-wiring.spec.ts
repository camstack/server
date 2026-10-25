/**
 * `wireSettingsDoor` — the addon registry's `settings-store` wiring — replays
 * the persisted capability preferences once the door's boot read settles
 * (D675, review M3). A provider that registered BEFORE the read (the default
 * won then, because the preference was unknown) ends active on the stored
 * choice. Remove the replay from the wiring and this goes red.
 */
import * as path from 'node:path'
import { CapabilityRegistry, SqliteSettingsBackend } from '@camstack/system'
import type { IScopedLogger, ISettingsStoreProvider } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigService } from '../core/config/config.service.js'
import { wireSettingsDoor } from '../core/addon/settings-door-wiring.js'

const NO_CONFIG_FILE = path.join(__dirname, 'no-such-config.yaml')
const engines: SqliteSettingsBackend[] = []

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const engine of engines.splice(0)) await engine.shutdown()
})

const silent: IScopedLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silent,
  withTags: () => silent,
}

function doorOver(engine: SqliteSettingsBackend): ISettingsStoreProvider {
  const refuse = (name: string) => async (): Promise<never> => {
    throw new Error(`settings-store.${name} is not part of this test`)
  }
  return {
    query: (input) => engine.query(input),
    get: (input) => engine.get(input),
    set: (input) => engine.set(input),
    deleteWhere: refuse('deleteWhere'),
    upsert: refuse('upsert'),
    insert: refuse('insert'),
    insertMany: refuse('insertMany'),
    upsertMany: refuse('upsertMany'),
    transact: refuse('transact'),
    update: refuse('update'),
    delete: refuse('delete'),
    updateWhere: refuse('updateWhere'),
    count: refuse('count'),
    aggregate: refuse('aggregate'),
    histogram: refuse('histogram'),
    isEmpty: refuse('isEmpty'),
    declareCollection: refuse('declareCollection'),
  }
}

describe('wireSettingsDoor replays the persisted capability preferences', () => {
  it('a provider registered before the boot read ends active on the stored choice', async () => {
    const engine = new SqliteSettingsBackend(':memory:')
    await engine.initialize()
    engines.push(engine)
    await engine.set({
      collection: 'system-settings',
      key: 'capabilities.singleton.test-decoder',
      value: 'decoder-gpu',
    })
    await engine.set({
      collection: 'system-settings',
      key: 'capabilities.collection.test-relay',
      value: JSON.stringify({ disabled: ['relay-cloud'] }),
    })

    const configService = new ConfigService(NO_CONFIG_FILE)
    const registry = new CapabilityRegistry(silent)
    // The same readers addon-registry.service installs: unreadable → no preference.
    registry.setConfigReader((cap) => {
      try {
        return configService.get<string>(`capabilities.singleton.${cap}`) ?? undefined
      } catch {
        return undefined
      }
    })
    registry.setCollectionConfigReader((cap) => {
      try {
        const raw = configService.get<string>(`capabilities.collection.${cap}`)
        if (typeof raw !== 'string') return undefined
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null || !('disabled' in parsed))
          return undefined
        const list = parsed.disabled
        return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : []
      } catch {
        return undefined
      }
    })
    registry.declareCapability({
      name: 'test-decoder',
      scope: 'system',
      mode: 'singleton',
      methods: {},
    })
    registry.declareCapability({
      name: 'test-relay',
      scope: 'system',
      mode: 'collection',
      methods: {},
    })

    const replayed = wireSettingsDoor({ configService, registry, logger: silent }, doorOver(engine))
    // Registered while the boot read is in flight: the default wins for now.
    registry.registerProvider('test-decoder', 'decoder-cpu', { name: 'cpu' })
    registry.registerProvider('test-decoder', 'decoder-gpu', { name: 'gpu' })
    registry.registerProvider('test-relay', 'relay-cloud', { name: 'cloud' })
    expect(registry.getSingletonAddonId('test-decoder')).toBe('decoder-cpu')

    await replayed
    expect(registry.getSingletonAddonId('test-decoder')).toBe('decoder-gpu')
    const relay = registry.listCapabilities().find((c) => c.name === 'test-relay')
    expect(relay?.disabledProviders).toEqual(['relay-cloud'])
  })
})
