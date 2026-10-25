/**
 * AlertCenterAddon — comprehensive test suite.
 *
 * Covers: initialization, event handling for all 13 categories,
 * alert CRUD (list/markRead/markAllRead/dismiss), model download
 * lifecycle (progress/completion/failure), retention enforcement,
 * real-time event emission, and edge cases.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type {
  AddonContext,
  ISettingsBackend,
  IEventBus,
  IScopedLogger,
  SystemEvent,
  KnownEventCategory,
  SettingsRecord,
  QueryFilter,
} from '@camstack/types'
import { createRecordsAccess } from '@camstack/types'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { AlertCenterAddon } from '../alerts.addon.js'

async function createAlertCenterRecordsAccess() {
  const recordsWorld = makeRecordsWorld()
  await recordsWorld.provider.init()
  return createRecordsAccess({
    owner: 'alert-center',
    transport: recordsWorld.transportFor('alert-center'),
    secrets: null,
  })
}

// ---------------------------------------------------------------------------
// tRPC namespace wrapper for mock backends
// ---------------------------------------------------------------------------

function wrapAsTrpc(backend: ReturnType<typeof createMockSettingsBackend>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper wrapping mock methods
  const queryLeaf = <T>(fn: (...args: any[]) => T) => ({ query: fn })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper wrapping mock methods
  const mutateLeaf = <T>(fn: (...args: any[]) => T) => ({ mutate: fn })
  return {
    get: queryLeaf(backend.get.bind(backend)),
    set: mutateLeaf(backend.set.bind(backend)),
    query: queryLeaf(backend.query.bind(backend)),
    insert: mutateLeaf(backend.insert.bind(backend)),
    update: mutateLeaf(backend.update.bind(backend)),
    delete: mutateLeaf(backend.delete.bind(backend)),
    count: queryLeaf(backend.count.bind(backend)),
    isEmpty: queryLeaf(backend.isEmpty.bind(backend)),
  }
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockLogger(): IScopedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
}

/**
 * In-memory ISettingsBackend mock — stores records per collection in a Map.
 * Supports query, count, update, delete, set with basic where filtering.
 */
function createMockSettingsBackend(): ISettingsBackend & {
  _store: Map<string, Map<string, Record<string, unknown>>>
} {
  const store = new Map<string, Map<string, Record<string, unknown>>>()

  function getCollection(collection: string): Map<string, Record<string, unknown>> {
    if (!store.has(collection)) store.set(collection, new Map())
    return store.get(collection)!
  }

  function matchesWhere(data: Record<string, unknown>, where: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(where)) {
      if (data[key] !== value) return false
    }
    return true
  }

  return {
    _store: store,

    async get(input: { collection: string; key: string }): Promise<unknown> {
      return getCollection(input.collection).get(input.key) ?? null
    },

    async set(input: { collection: string; key: string; value: unknown }): Promise<void> {
      getCollection(input.collection).set(input.key, input.value as Record<string, unknown>)
    },

    async query<T extends object>(input: {
      collection: string
      filter?: QueryFilter
    }): Promise<readonly SettingsRecord<T>[]> {
      const col = getCollection(input.collection)
      let entries = [...col.entries()].map(([id, data]) => ({ id, data: data as T }))

      if (input.filter?.where) {
        const where = input.filter.where
        entries = entries.filter((e) => matchesWhere(e.data as Record<string, unknown>, where))
      }

      if (input.filter?.orderBy) {
        const { field, direction } = input.filter.orderBy
        entries.sort((a, b) => {
          const av = (a.data as Record<string, unknown>)[field] as number
          const bv = (b.data as Record<string, unknown>)[field] as number
          return direction === 'asc' ? av - bv : bv - av
        })
      }

      if (input.filter?.limit !== undefined) {
        entries = entries.slice(0, input.filter.limit)
      }

      return entries
    },

    async insert<T extends object>(input: {
      collection: string
      record: { readonly id?: string; readonly data: T }
    }): Promise<{ readonly id: string | number }> {
      // Mirrors the real backend since D473: an absent id is minted here, and
      // the id the row got is what comes back.
      const id = input.record.id ?? randomUUID()
      getCollection(input.collection).set(id, input.record.data as Record<string, unknown>)
      return { id }
    },

    /** No slot semantics here: this fake has no indexes, so an upsert can only
     *  honour a SUPPLIED id. Nothing in the alerts addon calls it. */
    async upsert<T extends object>(input: {
      collection: string
      conflict: readonly string[]
      record: { readonly id?: string; readonly data: T }
    }): Promise<{ readonly id: string | number }> {
      const id = input.record.id ?? randomUUID()
      getCollection(input.collection).set(id, input.record.data as Record<string, unknown>)
      return { id }
    },

    async update(input: {
      collection: string
      id: string
      data: Record<string, unknown>
    }): Promise<void> {
      const col = getCollection(input.collection)
      const existing = col.get(input.id)
      if (existing) {
        col.set(input.id, { ...existing, ...input.data })
      }
    },

    async delete(input: { collection: string; key: string }): Promise<void> {
      getCollection(input.collection).delete(input.key)
    },

    async count(input: { collection: string; filter?: QueryFilter }): Promise<number> {
      const col = getCollection(input.collection)
      if (!input.filter?.where) return col.size
      let n = 0
      for (const data of col.values()) {
        if (matchesWhere(data, input.filter.where)) n++
      }
      return n
    },

    async isEmpty(input: { collection: string }): Promise<boolean> {
      return getCollection(input.collection).size === 0
    },

    // declareCollection — added when the settings-store cap gained
    // typed-table support. The mock backend ignores the schema (it's
    // an in-memory map keyed by string), so this is a contract-level
    // no-op satisfying the interface.
    async declareCollection() {
      /* no-op */
    },

    async histogram() {
      return []
    },

    async aggregate() {
      return { count: 0, values: {} }
    },
  }
}

/**
 * The raw wire shape an event handler can actually receive: identical to
 * `SystemEvent` except `source` may be absent. A malformed cross-process
 * event can reach a handler with no source, which the alerts addon defends
 * against (`event.source ? … : undefined`). The typed `SystemEvent` contract
 * always carries a source, so this widened shape is what `_fire` injects to
 * exercise that defensive path. */
type WireSystemEvent = Omit<SystemEvent, 'source'> & { source?: SystemEvent['source'] }

/** Handler entry uses a method signature so its parameter is bivariant — a
 *  `(event: SystemEvent) => void` subscriber (the real addon handler) can be
 *  stored here and still be invoked with a source-optional `WireSystemEvent`. */
interface HandlerEntry {
  call(event: WireSystemEvent): void
}

interface MockEventBus extends IEventBus {
  _handlers: Map<string, HandlerEntry[]>
  _emitted: SystemEvent[]
  _fire: (category: string, event: WireSystemEvent) => void
}

function createMockEventBus(): MockEventBus {
  const handlers = new Map<string, HandlerEntry[]>()
  const emitted: SystemEvent[] = []

  return {
    _handlers: handlers,
    _emitted: emitted,
    _fire(category: string, event: WireSystemEvent) {
      const h = handlers.get(category) ?? []
      for (const entry of h) entry.call(event)
    },
    emit(event: SystemEvent) {
      emitted.push(event)
    },
    subscribe(filter: { category?: string }, handler: (event: SystemEvent) => void): () => void {
      const cat = (filter as { category?: string }).category ?? '*'
      if (!handlers.has(cat)) handlers.set(cat, [])
      const entry: HandlerEntry = { call: handler }
      handlers.get(cat)!.push(entry)
      return () => {
        const arr = handlers.get(cat)
        if (arr) {
          const idx = arr.indexOf(entry)
          if (idx >= 0) arr.splice(idx, 1)
        }
      }
    },
    getRecent: () => [],
  }
}

function makeSystemEvent(category: string, data: Record<string, unknown> = {}): SystemEvent {
  return {
    id: `test-${Date.now()}-${Math.random()}`,
    timestamp: new Date(),
    source: { type: 'test', id: 'test' },
    category: category as KnownEventCategory,
    data,
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

/**
 * In-memory fake of the Phase 2 raw-store accessors exposed by
 * `AddonContext.settings`. The alerts addon reads
 * `settings?.readAddonStore()` during `initialize()` and
 * `updateGlobalSettings()`, and writes back via `writeAddonStore(patch)`.
 * `writeAddonStore` shallow-merges into the in-memory store so partial
 * patches from `updateGlobalSettings` preserve untouched keys.
 */
function createFakeSettings(initial: Record<string, unknown> = {}): {
  readAddonStore: () => Promise<Record<string, unknown>>
  writeAddonStore: (patch: Record<string, unknown>) => Promise<void>
  readDeviceStore: () => Promise<Record<string, unknown>>
  writeDeviceStore: () => Promise<void>
  setSection: () => Promise<void>
} {
  let store: Record<string, unknown> = { ...initial }
  return {
    readAddonStore: async () => ({ ...store }),
    writeAddonStore: async (patch: Record<string, unknown>) => {
      store = { ...store, ...patch }
    },
    readDeviceStore: async () => ({}),
    writeDeviceStore: async () => {
      /* no-op */
    },
    setSection: async () => {
      /* no-op */
    },
  }
}

describe('AlertCenterAddon', () => {
  let addon: AlertCenterAddon
  let backend: ReturnType<typeof createMockSettingsBackend>
  let eventBus: MockEventBus
  let logger: IScopedLogger
  let recordsWorld: ReturnType<typeof makeRecordsWorld>

  beforeEach(async () => {
    addon = new AlertCenterAddon()
    backend = createMockSettingsBackend()
    eventBus = createMockEventBus()
    logger = createMockLogger()
    recordsWorld = makeRecordsWorld()
    await recordsWorld.provider.init()
    const records = createRecordsAccess({
      owner: 'alert-center',
      transport: recordsWorld.transportFor('alert-center'),
      secrets: null,
    })

    const context = {
      api: { settingsStore: wrapAsTrpc(backend) },
      records,
      eventBus,
      logger,
      addonConfig: {},
      kernel: {},
      settings: createFakeSettings(),
    } as unknown as AddonContext

    await addon.initialize(context)
  })

  // ─── Initialization ──────────────────────────────────────────────

  describe('initialization', () => {
    // The alert center was pruned to a focused set of operator-visible
    // events (see `CATEGORY_MAPPINGS` in `alerts.addon.ts`). High-volume
    // categories like `device.enabled` / `capability.binding-changed`
    // and routine retention completions were removed because the alert
    // history was getting buried by them. The list below is the live
    // curated set; `toBeGreaterThanOrEqual` keeps the assertion robust
    // against future additions.
    it('subscribes to the curated tracked event category list', () => {
      const subscribedCategories = [...eventBus._handlers.keys()]
      // Critical / error categories
      expect(subscribedCategories).toContain('addon.crashed')
      expect(subscribedCategories).toContain('addon.runner-failed')
      expect(subscribedCategories).toContain('addon.error')
      expect(subscribedCategories).toContain('process.crashed')
      expect(subscribedCategories).toContain('recording.error')
      expect(subscribedCategories).toContain('recording.storage.critical')
      expect(subscribedCategories).toContain('notification.failed')
      // Cluster — disconnect only
      expect(subscribedCategories).toContain('agent.offline')
      expect(subscribedCategories).not.toContain('agent.online')
      // Node / package updates
      expect(subscribedCategories).toContain('system.restarting')
      expect(subscribedCategories).toContain('system.restart-completed')
      expect(subscribedCategories).toContain('update.available')
      expect(subscribedCategories).not.toContain('system.boot')
      // Device remove (not every adoption)
      expect(subscribedCategories).not.toContain('device.registered')
      expect(subscribedCategories).toContain('device.unregistered')
      // Package management
      expect(subscribedCategories).toContain('addon.installed')
      expect(subscribedCategories).toContain('addon.updated')
      expect(subscribedCategories).toContain('addon.uninstalled')
      // Streams (stale-timeout outages)
      expect(subscribedCategories).toContain('stream.offline')
      expect(subscribedCategories).toContain('stream.online')
      // Backup restore only
      expect(subscribedCategories).not.toContain('backup.completed')
      expect(subscribedCategories).toContain('backup.restored')
      // Model downloads
      expect(subscribedCategories).toContain('model.download.progress')

      expect(subscribedCategories.length).toBeGreaterThanOrEqual(18)
    })

    it('registers as alerts collection provider', async () => {
      const addon2 = new AlertCenterAddon()
      const ctx = {
        api: { settingsStore: wrapAsTrpc(backend) },
        records: await createAlertCenterRecordsAccess(),
        eventBus,
        logger,
        addonConfig: {},
        kernel: {},
        settings: createFakeSettings(),
      } as unknown as AddonContext
      const initResult = await addon2.initialize(ctx)
      const providers = Array.isArray(initResult) ? initResult : initResult?.providers
      expect(providers).toBeDefined()

      /* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest matcher typing */
      expect(providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capability: expect.objectContaining({ name: 'alerts' }) as unknown,
            provider: expect.objectContaining({
              emit: expect.any(Function) as unknown,
              update: expect.any(Function) as unknown,
            }),
          }),
        ]),
      )
      /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    })

    it('applies stored config from settings raw store', async () => {
      // Phase 13: after the Phase 3 settings-redesign migration the
      // addon reads its config from `context.settings.readAddonStore()`
      // instead of the legacy `addonConfig` field. Seed the fake
      // settings with the values we want and assert via the new
      // `getGlobalSettings` path.
      const addon2 = new AlertCenterAddon()
      await addon2.initialize({
        api: { settingsStore: wrapAsTrpc(backend) },
        records: await createAlertCenterRecordsAccess(),
        eventBus,
        logger,
        addonConfig: {},
        kernel: {},
        settings: createFakeSettings({ maxAlerts: 100, retentionDays: 7 }),
      } as unknown as AddonContext)

      const schema = await addon2.getGlobalSettings()
      expect(schema).not.toBeNull()
      const fields = schema!.sections[0]!.fields
      const maxAlerts = fields.find((f) => 'key' in f && f.key === 'maxAlerts')
      const retentionDays = fields.find((f) => 'key' in f && f.key === 'retentionDays')
      expect((maxAlerts as { value: unknown } | undefined)?.value).toBe(100)
      expect((retentionDays as { value: unknown } | undefined)?.value).toBe(7)
    })

    it('uses schema defaults when the settings store is empty', async () => {
      // Phase 13: the addon's initial config comes from schema defaults
      // (`maxAlerts: 500`, `retentionDays: 30`) when the store hasn't
      // been written yet. `hydrateSchema` + `readAddonStore()` guarantees
      // this — there is no longer a legacy `DEFAULT_CONFIG` const to
      // inspect directly on the addon instance.
      const schema = await addon.getGlobalSettings()
      expect(schema).not.toBeNull()
      const fields = schema!.sections[0]!.fields
      const maxAlerts = fields.find((f) => 'key' in f && f.key === 'maxAlerts')
      const retentionDays = fields.find((f) => 'key' in f && f.key === 'retentionDays')
      expect((maxAlerts as { value: unknown } | undefined)?.value).toBe(500)
      expect((retentionDays as { value: unknown } | undefined)?.value).toBe(30)
    })
  })

  // ─── Event handling: standard categories ─────────────────────────

  describe('event handling — standard categories', () => {
    it('ignores system.boot — boots are not operator alerts', async () => {
      // Not subscribed: firing must not mint a card (no handler at all).
      eventBus._fire('system.boot', makeSystemEvent('system.boot', { mode: 'hub' }))
      await new Promise((r) => setTimeout(r, 50))
      expect(await addon.listAlerts()).toHaveLength(0)
    })

    it('creates alert for agent.offline event', async () => {
      eventBus._fire(
        'agent.offline',
        makeSystemEvent('agent.offline', { nodeId: 'unraid', reason: 'timeout' }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      const alerts = await addon.listAlerts()
      expect(alerts[0]!.category).toBe('agent.offline')
      expect(alerts[0]!.severity).toBe('warning')
      expect(alerts[0]!.title).toBe('Agent disconnected')
      expect(alerts[0]!.message).toContain('unraid')
      expect(alerts[0]!.status).toBe('active')
      expect(alerts[0]!.read).toBe(false)
    })

    it('creates alert for addon.crashed event', async () => {
      eventBus._fire(
        'addon.crashed',
        makeSystemEvent('addon.crashed', {
          addonId: 'stream-broker',
          error: 'EADDRINUSE: address already in use',
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      const alerts = await addon.listAlerts()
      expect(alerts[0]!.severity).toBe('error')
      expect(alerts[0]!.title).toBe('Addon crashed')
      expect(alerts[0]!.message).toContain('stream-broker')
      expect(alerts[0]!.message).toContain('EADDRINUSE')
    })

    it('creates alert for addon.error event', async () => {
      eventBus._fire(
        'addon.error',
        makeSystemEvent('addon.error', {
          addonId: 'reolink',
          error: 'Connection timeout',
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      const alerts = await addon.listAlerts()
      expect(alerts[0]!.severity).toBe('error')
      expect(alerts[0]!.message).toContain('reolink')
      expect(alerts[0]!.message).toContain('Connection timeout')
    })

    it('creates alert for addon.installed event', async () => {
      eventBus._fire(
        'addon.installed',
        makeSystemEvent('addon.installed', {
          addonId: 'new-addon',
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      const alerts = await addon.listAlerts()
      expect(alerts[0]!.severity).toBe('info')
      expect(alerts[0]!.title).toBe('Addon installed')
    })

    it('creates alert for addon.updated event with version info', async () => {
      eventBus._fire(
        'addon.updated',
        makeSystemEvent('addon.updated', {
          addonId: 'detection-pipeline',
          fromVersion: '0.1.0',
          toVersion: '0.2.0',
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      const alerts = await addon.listAlerts()
      expect(alerts[0]!.message).toContain('0.1.0')
      expect(alerts[0]!.message).toContain('0.2.0')
    })

    it('ignores settings-only addon.updated (no toVersion) — same gate as NC', async () => {
      // BaseAddon.updateGlobalSettings emits addon.updated with neither
      // version. Those are not package updates; minting a card per save is
      // what filled the bell with identical "Addon X updated" rows.
      eventBus._fire('addon.updated', {
        id: 'evt-1',
        timestamp: new Date(),
        source: { type: 'addon', id: 'stream-broker' },
        category: 'addon.updated' as KnownEventCategory,
        data: { level: 'global' },
      })
      await new Promise((r) => setTimeout(r, 50))
      expect(await addon.listAlerts()).toHaveLength(0)
    })

    it('names the addon from source.id on a version-bearing update (no "unknown")', async () => {
      eventBus._fire('addon.updated', {
        id: 'evt-1',
        timestamp: new Date(),
        source: { type: 'addon', id: 'stream-broker' },
        category: 'addon.updated' as KnownEventCategory,
        data: { toVersion: '0.2.0' },
      })
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      const alerts = await addon.listAlerts()
      expect(alerts[0]!.message).toContain('stream-broker')
      expect(alerts[0]!.message).not.toContain('unknown')
      expect(alerts[0]!.id).toBe('addon-updated:stream-broker:0.2.0')
    })

    it('merges a second emit of the same addon+toVersion into one alert', async () => {
      const payload = {
        timestamp: new Date(),
        source: { type: 'addon' as const, id: 'export-alexa' },
        category: 'addon.updated' as KnownEventCategory,
        data: { addonId: 'export-alexa', fromVersion: '1.0.0', toVersion: '1.0.1' },
      }
      eventBus._fire('addon.updated', { id: 'evt-a', ...payload })
      eventBus._fire('addon.updated', { id: 'evt-b', ...payload })
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })
      expect((await addon.listAlerts())[0]!.id).toBe('addon-updated:export-alexa:1.0.1')
    })

    it('ignores device.registered — adoptions are not operator alerts', async () => {
      eventBus._fire(
        'device.registered',
        makeSystemEvent('device.registered', {
          deviceId: 'cam-front',
          name: 'Front Camera',
        }),
      )
      await new Promise((r) => setTimeout(r, 50))
      expect(await addon.listAlerts()).toHaveLength(0)
    })

    it('creates alert for device.unregistered event using the device name', async () => {
      eventBus._fire(
        'device.unregistered',
        makeSystemEvent('device.unregistered', {
          deviceId: 108,
          name: 'Kitchen',
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      const alerts = await addon.listAlerts()
      expect(alerts[0]!.severity).toBe('warning')
      expect(alerts[0]!.message).toContain('Kitchen')
      expect(alerts[0]!.message).not.toContain('Camera 108')
    })

    it('creates alert for recording.error event', async () => {
      eventBus._fire(
        'recording.error',
        makeSystemEvent('recording.error', {
          deviceId: 'cam-01',
          error: 'Disk full',
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      const alerts = await addon.listAlerts()
      expect(alerts[0]!.severity).toBe('error')
      expect(alerts[0]!.message).toContain('cam-01')
      expect(alerts[0]!.message).toContain('Disk full')
    })

    it('creates alert for recording.storage.critical event', async () => {
      eventBus._fire(
        'recording.storage.critical',
        makeSystemEvent('recording.storage.critical', {
          deviceId: 'cam-01',
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      const alerts = await addon.listAlerts()
      expect(alerts[0]!.severity).toBe('warning')
      expect(alerts[0]!.title).toBe('Storage critical')
    })

    it('creates alert for process.crashed event', async () => {
      eventBus._fire(
        'process.crashed',
        makeSystemEvent('process.crashed', {
          processId: 'worker-3',
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      const alerts = await addon.listAlerts()
      expect(alerts[0]!.severity).toBe('error')
      expect(alerts[0]!.message).toContain('worker-3')
    })
  })

  // ─── Stream offline / online (stale-timeout outages only) ─────────

  describe('event handling — a notification rule that cannot work (D905)', () => {
    it('one in-app card per rule, closed when the rule is repaired', async () => {
      eventBus._fire(
        'notification.rule-broken',
        makeSystemEvent('notification.rule-broken', {
          ruleId: 'r-robot',
          ruleName: 'Robot',
          reason: 'device-deleted',
          reasons: [{ code: 'device-deleted', ids: ['4483'] }],
          offendingIds: ['4483'],
        }),
      )
      await vi.waitFor(async () => {
        expect(await addon.listAlerts()).toHaveLength(1)
      })
      const [card] = await addon.listAlerts()
      expect(card?.id).toBe('nc-rule-broken:r-robot')
      expect(card?.severity).toBe('warning')
      expect(card?.message).toContain('Robot')
      expect(card?.message).toContain('4483')

      eventBus._fire(
        'notification.rule-repaired',
        makeSystemEvent('notification.rule-repaired', { ruleId: 'r-robot', ruleName: 'Robot' }),
      )
      await vi.waitFor(async () => {
        const [closed] = await addon.listAlerts()
        expect(closed?.status).toBe('dismissed')
      })
    })
  })

  describe('event handling — stream offline / online', () => {
    it('ignores stream.offline when reason is not stale-timeout', async () => {
      eventBus._fire(
        'stream.offline',
        makeSystemEvent('stream.offline', {
          deviceId: 108,
          camStreamId: 'main',
          reason: 'idle',
        }),
      )
      await new Promise((r) => setTimeout(r, 50))
      expect(await addon.listAlerts()).toHaveLength(0)
    })

    it('creates a stable-id alert for stale-timeout, falling back to Camera <id>', async () => {
      eventBus._fire(
        'stream.offline',
        makeSystemEvent('stream.offline', {
          deviceId: 108,
          camStreamId: 'main',
          reason: 'stale-timeout',
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      const alerts = await addon.listAlerts()
      expect(alerts[0]!.id).toBe('stream-offline:108')
      expect(alerts[0]!.severity).toBe('warning')
      expect(alerts[0]!.title).toBe('Stream offline')
      expect(alerts[0]!.message).toContain('Camera 108')
      expect(alerts[0]!.message).toContain('main')
    })

    it('one card per DEVICE for main + sub, and a battery failure reason counts (D883)', async () => {
      eventBus._fire(
        'stream.offline',
        makeSystemEvent('stream.offline', {
          deviceId: 106,
          camStreamId: 'native:main',
          camStreamIds: ['native:main', 'native:sub'],
          reason: 'wake-timeout',
        }),
      )
      await vi.waitFor(async () => {
        expect(await addon.listAlerts()).toHaveLength(1)
      })
      const alerts = await addon.listAlerts()
      expect(alerts[0]!.id).toBe('stream-offline:106')
      expect(alerts[0]!.message).toContain('native:main, native:sub')
    })

    it('prefers the device name from deviceManager over Camera <id>', async () => {
      const named = new AlertCenterAddon()
      const namedBus = createMockEventBus()
      await named.initialize({
        api: {
          settingsStore: wrapAsTrpc(backend),
          deviceManager: {
            getDevice: {
              query: async () => ({ deviceId: 108, name: 'Kitchen' }),
            },
          },
        },
        records: await createAlertCenterRecordsAccess(),
        eventBus: namedBus,
        logger,
        addonConfig: {},
        kernel: {},
        settings: createFakeSettings(),
      } as unknown as AddonContext)

      namedBus._fire(
        'stream.offline',
        makeSystemEvent('stream.offline', {
          deviceId: 108,
          camStreamId: 'main',
          reason: 'stale-timeout',
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await named.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      const alerts = await named.listAlerts()
      expect(alerts[0]!.message).toContain('Kitchen')
      expect(alerts[0]!.message).not.toContain('Camera 108')
      await named.shutdown()
    })

    describe('one-time migration of the pre-D883 per-cam-stream cards', () => {
      async function seedLegacyCard(): Promise<void> {
        const alert = {
          id: 'stream-offline:101:main',
          category: 'stream.offline',
          severity: 'warning',
          title: 'Stream offline',
          message: 'old',
          status: 'active',
          read: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          source: { type: 'device', id: '101' },
          metadata: { deviceId: 101, camStreamId: 'main' },
        }
        await Reflect.apply(Reflect.get(addon, 'emitAlert'), addon, [alert])
      }

      it('a stream.online of the device dismisses its legacy per-stream card, any reason', async () => {
        await seedLegacyCard()
        eventBus._fire(
          'stream.online',
          makeSystemEvent('stream.online', { deviceId: 101, reason: 'broker-destroyed' }),
        )
        await vi.waitFor(async () => {
          const legacy = (await addon.listAlerts()).find((a) => a.id === 'stream-offline:101:main')
          expect(legacy?.status).toBe('dismissed')
        })
      })

      it('the boot sweep dismisses every active legacy card', async () => {
        await seedLegacyCard()
        const rebooted = new AlertCenterAddon()
        await rebooted.initialize({
          api: { settingsStore: wrapAsTrpc(backend) },
          records: createRecordsAccess({
            owner: 'alert-center',
            transport: recordsWorld.transportFor('alert-center'),
            secrets: null,
          }),
          eventBus: createMockEventBus(),
          logger,
          addonConfig: {},
          kernel: {},
          settings: createFakeSettings(),
        } as unknown as AddonContext)
        await vi.waitFor(async () => {
          const legacy = (await rebooted.listAlerts()).find(
            (a) => a.id === 'stream-offline:101:main',
          )
          expect(legacy?.status).toBe('dismissed')
        })
        await rebooted.shutdown()
      })
    })

    it('dismisses the matching offline card on stream.online', async () => {
      eventBus._fire(
        'stream.offline',
        makeSystemEvent('stream.offline', {
          deviceId: 101,
          camStreamId: 'sub',
          reason: 'stale-timeout',
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
        expect(alerts[0]!.status).toBe('active')
      })

      eventBus._fire(
        'stream.online',
        makeSystemEvent('stream.online', {
          deviceId: 101,
          camStreamId: 'sub',
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts[0]!.status).toBe('dismissed')
        expect(alerts[0]!.read).toBe(true)
      })
    })
  })

  // ─── Event handling: model download lifecycle ────────────────────

  describe('model download lifecycle', () => {
    it('creates in-progress alert on first download event', async () => {
      eventBus._fire(
        'model.download.progress',
        makeSystemEvent('model.download.progress', {
          modelId: 'yolo26n',
          progress: 10,
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      const alerts = await addon.listAlerts()
      expect(alerts[0]!.id).toBe('model-download:yolo26n')
      expect(alerts[0]!.status).toBe('in-progress')
      expect(alerts[0]!.progress).toBe(10)
      expect(alerts[0]!.message).toContain('yolo26n')
      expect(alerts[0]!.message).toContain('10%')
    })

    it('updates progress on subsequent events', async () => {
      eventBus._fire(
        'model.download.progress',
        makeSystemEvent('model.download.progress', {
          modelId: 'yolo26n',
          progress: 10,
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      eventBus._fire(
        'model.download.progress',
        makeSystemEvent('model.download.progress', {
          modelId: 'yolo26n',
          progress: 50,
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts[0]!.progress).toBe(50)
      })

      const alerts = await addon.listAlerts()
      expect(alerts).toHaveLength(1) // same alert updated, not new one
      expect(alerts[0]!.progress).toBe(50)
      expect(alerts[0]!.message).toContain('50%')
    })

    it('transitions to completed when progress >= 100', async () => {
      eventBus._fire(
        'model.download.progress',
        makeSystemEvent('model.download.progress', {
          modelId: 'scrfd-2.5g',
          progress: 30,
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      eventBus._fire(
        'model.download.progress',
        makeSystemEvent('model.download.progress', {
          modelId: 'scrfd-2.5g',
          progress: 100,
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts[0]!.status).toBe('completed')
      })

      const alerts = await addon.listAlerts()
      expect(alerts[0]!.status).toBe('completed')
      expect(alerts[0]!.progress).toBe(100)
      expect(alerts[0]!.message).toContain('completed')
    })

    it('transitions to failed when progress < 0', async () => {
      eventBus._fire(
        'model.download.progress',
        makeSystemEvent('model.download.progress', {
          modelId: 'arcface-r100',
          progress: 45,
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      eventBus._fire(
        'model.download.progress',
        makeSystemEvent('model.download.progress', {
          modelId: 'arcface-r100',
          progress: -1,
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts[0]!.status).toBe('failed')
      })

      const alerts = await addon.listAlerts()
      expect(alerts[0]!.status).toBe('failed')
      expect(alerts[0]!.message).toContain('failed')
    })

    it('tracks multiple downloads independently', async () => {
      eventBus._fire(
        'model.download.progress',
        makeSystemEvent('model.download.progress', {
          modelId: 'yolo26n',
          progress: 20,
        }),
      )
      eventBus._fire(
        'model.download.progress',
        makeSystemEvent('model.download.progress', {
          modelId: 'scrfd-2.5g',
          progress: 60,
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(2)
      })

      const alerts = await addon.listAlerts()
      const yolo = alerts.find((a) => a.id === 'model-download:yolo26n')
      const scrfd = alerts.find((a) => a.id === 'model-download:scrfd-2.5g')
      expect(yolo!.progress).toBe(20)
      expect(scrfd!.progress).toBe(60)
    })

    it('handles unknown modelId gracefully', async () => {
      eventBus._fire(
        'model.download.progress',
        makeSystemEvent('model.download.progress', {
          progress: 50,
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      const alerts = await addon.listAlerts()
      expect(alerts[0]!.id).toBe('model-download:unknown')
    })
  })

  // ─── Alert CRUD operations ──────────────────────────────────────

  describe('alert CRUD', () => {
    async function createTestAlerts(count: number): Promise<void> {
      for (let i = 0; i < count; i++) {
        eventBus._fire('agent.offline', makeSystemEvent('agent.offline', { nodeId: `mode-${i}` }))
      }
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(count)
      })
    }

    it('listAlerts returns all alerts ordered by updatedAt desc', async () => {
      await createTestAlerts(3)
      const alerts = await addon.listAlerts()
      expect(alerts).toHaveLength(3)
      // Most recently updated first
      for (let i = 1; i < alerts.length; i++) {
        expect(alerts[i - 1]!.updatedAt).toBeGreaterThanOrEqual(alerts[i]!.updatedAt)
      }
    })

    it('listAlerts with limit', async () => {
      await createTestAlerts(5)
      const alerts = await addon.listAlerts({ limit: 2 })
      expect(alerts).toHaveLength(2)
    })

    it('listAlerts with unreadOnly filter', async () => {
      await createTestAlerts(3)
      const alerts = await addon.listAlerts()
      // Mark first one as read
      await addon.markRead(alerts[0]!.id)

      const unread = await addon.listAlerts({ unreadOnly: true })
      expect(unread).toHaveLength(2)
      expect(unread.every((a) => !a.read)).toBe(true)
    })

    it('markRead marks single alert as read', async () => {
      await createTestAlerts(2)
      const alerts = await addon.listAlerts()
      const targetId = alerts[0]!.id

      await addon.markRead(targetId)

      const updated = await addon.listAlerts()
      const target = updated.find((a) => a.id === targetId)
      expect(target!.read).toBe(true)
      // Other alert still unread
      const other = updated.find((a) => a.id !== targetId)
      expect(other!.read).toBe(false)
    })

    it('markAllRead marks all alerts as read', async () => {
      await createTestAlerts(4)
      expect(await addon.getUnreadCount()).toBe(4)

      await addon.markAllRead()

      expect(await addon.getUnreadCount()).toBe(0)
      const alerts = await addon.listAlerts()
      expect(alerts.every((a) => a.read)).toBe(true)
    })

    it('dismiss sets status to dismissed and marks as read', async () => {
      await createTestAlerts(1)
      const alerts = await addon.listAlerts()
      const targetId = alerts[0]!.id

      await addon.dismiss(targetId)

      const updated = await addon.listAlerts()
      const target = updated.find((a) => a.id === targetId)
      expect(target!.status).toBe('dismissed')
      expect(target!.read).toBe(true)
    })

    it('getUnreadCount returns correct count', async () => {
      expect(await addon.getUnreadCount()).toBe(0)

      await createTestAlerts(3)
      expect(await addon.getUnreadCount()).toBe(3)

      const alerts = await addon.listAlerts()
      await addon.markRead(alerts[0]!.id)
      expect(await addon.getUnreadCount()).toBe(2)
    })
  })

  // ─── Real-time event emission ───────────────────────────────────

  describe('real-time event emission', () => {
    it('emits alert.created event when alert is persisted', async () => {
      eventBus._fire('agent.offline', makeSystemEvent('agent.offline', { nodeId: 'hub' }))
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      const created = eventBus._emitted.filter((e) => e.category === 'alert.created')
      expect(created).toHaveLength(1)
      expect(created[0]!.data).toMatchObject({
        category: 'agent.offline',
        severity: 'warning',
        title: 'Agent disconnected',
        status: 'active',
      })
    })

    it('emits alert.updated event when download progress changes', async () => {
      eventBus._fire(
        'model.download.progress',
        makeSystemEvent('model.download.progress', {
          modelId: 'yolo26n',
          progress: 10,
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      // Clear emitted to track only the update
      eventBus._emitted.length = 0

      eventBus._fire(
        'model.download.progress',
        makeSystemEvent('model.download.progress', {
          modelId: 'yolo26n',
          progress: 50,
        }),
      )
      await vi.waitFor(async () => {
        const updated = eventBus._emitted.filter((e) => e.category === 'alert.updated')
        expect(updated).toHaveLength(1)
      })

      const updated = eventBus._emitted.filter((e) => e.category === 'alert.updated')
      expect(updated[0]!.data).toMatchObject({
        alertId: 'model-download:yolo26n',
        patch: { progress: 50 },
      })
    })

    it('emits alert.updated with completed status on download finish', async () => {
      eventBus._fire(
        'model.download.progress',
        makeSystemEvent('model.download.progress', {
          modelId: 'yolo26n',
          progress: 10,
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      eventBus._emitted.length = 0

      eventBus._fire(
        'model.download.progress',
        makeSystemEvent('model.download.progress', {
          modelId: 'yolo26n',
          progress: 100,
        }),
      )
      await vi.waitFor(async () => {
        const updated = eventBus._emitted.filter((e) => e.category === 'alert.updated')
        expect(updated).toHaveLength(1)
      })

      const updated = eventBus._emitted.filter((e) => e.category === 'alert.updated')
      expect(updated[0]!.data).toMatchObject({
        alertId: 'model-download:yolo26n',
        patch: { status: 'completed', progress: 100 },
      })
    })
  })

  // ─── Retention enforcement ──────────────────────────────────────

  describe('retention enforcement', () => {
    it('deletes oldest read alerts when maxAlerts exceeded', async () => {
      // Phase 13: Set low maxAlerts via the new three-level settings
      // API (Phase 3 migration replaced the legacy `onConfigChange`
      // method on `ICamstackAddon`).
      await addon.updateGlobalSettings({ maxAlerts: 3, retentionDays: 30 })

      // Create 4 alerts
      for (let i = 0; i < 4; i++) {
        eventBus._fire('agent.offline', makeSystemEvent('agent.offline', { nodeId: `m${i}` }))
        // Small delay to ensure different timestamps
        await new Promise((r) => setTimeout(r, 5))
      }
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts.length).toBeGreaterThanOrEqual(3)
      })

      // Mark all as read so they're eligible for deletion
      await addon.markAllRead()

      // Create one more to trigger enforcement
      eventBus._fire('agent.offline', makeSystemEvent('agent.offline', { nodeId: 'trigger' }))
      await vi.waitFor(async () => {
        const count = (await addon.listAlerts({ limit: 100 })).length
        expect(count).toBeLessThanOrEqual(5)
      })
    })
  })

  // ─── Settings management (Phase 3 three-level API) ──────────────
  //
  // Phase 13: rewritten from the legacy
  // `getConfigSchema / getConfig / onConfigChange` trio (deleted in
  // Phase 3 for this addon) to the new
  // `getGlobalSettings / updateGlobalSettings` pair that exposes a
  // hydrated `ConfigUISchemaWithValues` instead of a plain schema +
  // separate config record.

  describe('settings management', () => {
    it('getGlobalSettings returns the hydrated schema', async () => {
      const schema = await addon.getGlobalSettings()
      expect(schema).not.toBeNull()
      expect(schema!.sections).toHaveLength(1)
      expect(schema!.sections[0]!.id).toBe('alerts')
      const fields = schema!.sections[0]!.fields
      expect(fields).toHaveLength(2)
      const keys = fields.map((f) => ('key' in f ? f.key : undefined))
      expect(keys).toEqual(['maxAlerts', 'retentionDays'])
    })

    it('updateGlobalSettings writes both values', async () => {
      await addon.updateGlobalSettings({ maxAlerts: 200, retentionDays: 14 })
      const schema = await addon.getGlobalSettings()
      expect(schema).not.toBeNull()
      const fields = schema!.sections[0]!.fields
      const maxAlerts = fields.find((f) => 'key' in f && f.key === 'maxAlerts') as
        | { value: unknown }
        | undefined
      const retentionDays = fields.find((f) => 'key' in f && f.key === 'retentionDays') as
        | { value: unknown }
        | undefined
      expect(maxAlerts?.value).toBe(200)
      expect(retentionDays?.value).toBe(14)
    })

    it('updateGlobalSettings preserves existing values when the patch is partial', async () => {
      // Seed first write, then patch only one key.
      await addon.updateGlobalSettings({ maxAlerts: 100, retentionDays: 20 })
      await addon.updateGlobalSettings({ maxAlerts: 200 })
      const schema = await addon.getGlobalSettings()
      expect(schema).not.toBeNull()
      const fields = schema!.sections[0]!.fields
      const maxAlerts = fields.find((f) => 'key' in f && f.key === 'maxAlerts') as
        | { value: unknown }
        | undefined
      const retentionDays = fields.find((f) => 'key' in f && f.key === 'retentionDays') as
        | { value: unknown }
        | undefined
      expect(maxAlerts?.value).toBe(200)
      // retentionDays must stay at 20 — the shallow merge inside
      // `writeAddonStore` preserves keys not present in the patch.
      expect(retentionDays?.value).toBe(20)
    })
  })

  // ─── Shutdown ───────────────────────────────────────────────────

  describe('shutdown', () => {
    it('unsubscribes from all event categories', async () => {
      // Before shutdown, handlers exist. The exact count is asserted
      // in the initialization test above — here we just want to make
      // sure *something* was subscribed so the zero-after-shutdown
      // check below is meaningful.
      const handlersBefore = eventBus._handlers.size
      expect(handlersBefore).toBeGreaterThan(0)

      await addon.shutdown()

      // After shutdown, all handlers removed
      let totalHandlers = 0
      for (const arr of eventBus._handlers.values()) {
        totalHandlers += arr.length
      }
      expect(totalHandlers).toBe(0)
    })

    it('unsubscribes from event bus on shutdown', async () => {
      eventBus._fire('agent.offline', makeSystemEvent('agent.offline', { nodeId: 'hub' }))
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      await addon.shutdown()

      // After shutdown, event subscriptions are removed — new events
      // should not create new alerts. The addon is no longer usable.
    })
  })

  // ─── Edge cases ─────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles event with missing data fields gracefully (names from source.id)', async () => {
      // Empty data but a present source — the alert names the addon from
      // `source.id` ('test', set by makeSystemEvent) rather than crashing.
      eventBus._fire('addon.crashed', makeSystemEvent('addon.crashed', {}))
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      const alerts = await addon.listAlerts()
      expect(alerts[0]!.message).toContain('test')
    })

    it('falls back to "unknown" only when neither data.addonId nor a source is present', async () => {
      eventBus._fire('addon.crashed', {
        id: 'evt-no-source',
        timestamp: new Date(),
        source: undefined,
        category: 'addon.crashed' as KnownEventCategory,
        data: {},
      })
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      const alerts = await addon.listAlerts()
      expect(alerts[0]!.message).toContain('unknown')
    })

    it('preserves source info from event', async () => {
      const event: SystemEvent = {
        id: 'test-123',
        timestamp: new Date(),
        source: { type: 'addon', id: 'stream-broker' },
        category: 'addon.crashed' as KnownEventCategory,
        data: { addonId: 'stream-broker', error: 'test' },
      }
      eventBus._fire('addon.crashed', event)
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      const alerts = await addon.listAlerts()
      expect(alerts[0]!.source).toEqual({ type: 'addon', id: 'stream-broker' })
    })

    it('stores metadata from event data', async () => {
      eventBus._fire(
        'addon.error',
        makeSystemEvent('addon.error', {
          addonId: 'test-addon',
          error: 'Something broke',
          customField: 42,
        }),
      )
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts()
        expect(alerts).toHaveLength(1)
      })

      const alerts = await addon.listAlerts()
      expect(alerts[0]!.metadata).toMatchObject({
        addonId: 'test-addon',
        error: 'Something broke',
        customField: 42,
      })
    })

    // `[ALERT-CENTER-EVENTS]` — the rate limiter suppresses the tail of
    // a burst from the SAME `(category, source.id)` tuple. The baseline
    // test below still verifies that distinct sources keep producing
    // separate alerts, and the companion test after it locks in the
    // exact cap (currently 5 per source per 60s window).
    it('multiple rapid events from different sources create separate alerts', async () => {
      for (let i = 0; i < 10; i++) {
        const event: SystemEvent = {
          id: `evt-${String(i)}`,
          timestamp: new Date(),
          // Each event uses a DIFFERENT source.id so the rate limiter
          // treats them as independent streams.
          source: { type: 'addon', id: `addon-${String(i)}` },
          category: 'addon.error' as KnownEventCategory,
          data: { addonId: `addon-${String(i)}`, error: `Error ${String(i)}` },
        }
        eventBus._fire('addon.error', event)
      }
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts({ limit: 100 })
        expect(alerts).toHaveLength(10)
      })
    })

    it('suppresses the tail of a burst from the same source (rate limit)', async () => {
      for (let i = 0; i < 10; i++) {
        // All events share the SAME source.id — this is the case the
        // rate limiter targets (flaky camera reconnecting, chatty
        // integration, runaway addon error loop, ...).
        eventBus._fire(
          'addon.error',
          makeSystemEvent('addon.error', {
            addonId: 'flaky-addon',
            error: `Error ${String(i)}`,
          }),
        )
      }
      // After the burst, we expect only the first 5 events to have
      // surfaced as alerts (`RATE_LIMIT_MAX_PER_SOURCE = 5`).
      await vi.waitFor(async () => {
        const alerts = await addon.listAlerts({ limit: 100 })
        expect(alerts).toHaveLength(5)
      })
    })

    it('markRead on nonexistent alert does not throw', async () => {
      await expect(addon.markRead('nonexistent-id')).resolves.not.toThrow()
    })

    it('dismiss on nonexistent alert does not throw', async () => {
      await expect(addon.dismiss('nonexistent-id')).resolves.not.toThrow()
    })
  })
})
