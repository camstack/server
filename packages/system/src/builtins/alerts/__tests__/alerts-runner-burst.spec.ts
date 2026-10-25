/**
 * D877 at the addon level: a crash burst is ONE alert per runner, and each
 * runner episode is announced once on the bus (the alert centre pushes nothing).
 */
import type {
  AddonContext,
  AlertEpisodePayload,
  IEventBus,
  IScopedLogger,
  SystemEvent,
} from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { AlertCenterAddon } from '../alerts.addon.js'

type Row = Record<string, unknown>

function createStore() {
  const rows = new Map<string, Row>()
  return {
    rows,
    api: {
      get: {
        query: async (i: { key: string }) => {
          const data = rows.get(i.key)
          return data === undefined ? null : { id: i.key, data }
        },
      },
      set: { mutate: async (i: { key: string; value: Row }) => void rows.set(i.key, i.value) },
      delete: { mutate: async (i: { key: string }) => void rows.delete(i.key) },
      count: { query: async () => rows.size },
      query: {
        query: async () => [...rows.entries()].map(([id, data]) => ({ id, data })),
      },
    },
  }
}

function createBus() {
  const handlers = new Map<string, ((e: SystemEvent) => void)[]>()
  const emitted: SystemEvent[] = []
  const bus = {
    emit: (event: SystemEvent) => void emitted.push(event),
    subscribe: (f: { category?: string }, h: (e: SystemEvent) => void) => {
      const k = f.category ?? '*'
      handlers.set(k, [...(handlers.get(k) ?? []), h])
      return () => undefined
    },
    getRecent: () => [],
  } as unknown as IEventBus
  const fire = (category: string, data: Record<string, unknown>): void => {
    for (const h of handlers.get(category) ?? []) {
      h({
        id: 'e',
        timestamp: new Date(),
        source: {
          type: 'core',
          id: String(data['runnerId'] ?? data['processId'] ?? 'x'),
          nodeId: 'hub',
        },
        category,
        data,
      } as unknown as SystemEvent)
    }
  }
  const episodes = (): AlertEpisodePayload[] =>
    emitted
      .filter((e) => e.category === EventCategory.AlertEpisode)
      .map((e) => e.data as unknown as AlertEpisodePayload)
  return { bus, fire, episodes }
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
  withTags: vi.fn().mockReturnThis(),
} as unknown as IScopedLogger

async function boot() {
  const store = createStore()
  const { bus, fire, episodes } = createBus()
  const addon = new AlertCenterAddon()
  await addon.initialize({
    api: {
      settingsStore: store.api,
      capabilities: { getCapability: { query: async () => null } },
    },
    eventBus: bus,
    logger,
    addonConfig: {},
    kernel: {},
    settings: {
      readAddonStore: async () => ({}),
      writeAddonStore: async () => undefined,
      readDeviceStore: async () => ({}),
      writeDeviceStore: async () => undefined,
      setSection: async () => undefined,
    },
  } as unknown as AddonContext)
  return { addon, store, fire, episodes }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

const refuse = (
  fire: (c: string, d: Record<string, unknown>) => void,
  id: string,
  reason = 'legacy blobs',
): void =>
  fire('addon.runner-refused', {
    runnerId: id,
    nodeId: 'hub',
    addonIds: [id],
    code: 'unmigrated-settings',
    reason,
    remedy: 'Run the migration.',
  })

describe('runner alerts and their episodes (D877)', () => {
  it('202 events of 28 runners are 28 alerts, not 202', async () => {
    const { addon, fire } = await boot()
    for (let r = 0; r < 28; r++) {
      const id = `r${String(r)}`
      for (let i = 0; i < 5; i++) fire('process.crashed', { processId: id })
      fire('addon.crashed', { addonId: id, error: 'x' })
      fire('addon.runner-failed', {
        runnerId: id,
        nodeId: 'hub',
        addonIds: [id],
        crashesInWindow: 5,
      })
    }
    await settle()
    const alerts = await addon.listAlerts({ limit: 500 })
    expect(alerts.filter((a) => a.id.startsWith('runner:hub:'))).toHaveLength(28)
    expect(alerts.every((a) => a.title === 'Addon crash loop')).toBe(true)
  })

  it('a runner that recovers closes its alert; failing again is a NEW episode', async () => {
    const { addon, fire, episodes } = await boot()
    refuse(fire, 'auth')
    await settle()
    expect(episodes()).toHaveLength(1)
    fire('process.state-changed', {
      runnerId: 'auth',
      nodeId: 'hub',
      addonIds: ['auth'],
      state: 'running',
    })
    await settle()
    expect((await addon.listAlerts())[0]?.status).toBe('dismissed')
    // a different failure after recovery: not folded into the stale refused record
    fire('addon.runner-failed', {
      runnerId: 'auth',
      nodeId: 'hub',
      addonIds: ['auth'],
      crashesInWindow: 5,
    })
    await settle()
    const alert = (await addon.listAlerts())[0]
    expect(alert?.status).toBe('active')
    expect(alert?.title).toBe('Addon crash loop')
    expect(episodes().map((e) => e.phase)).toEqual(['raised', 'resolved', 'raised'])
  })

  it('the same refusal repeated, even with another cause, stays ONE episode', async () => {
    const { fire, episodes } = await boot()
    refuse(fire, 'auth')
    refuse(fire, 'auth', 'a different cause')
    await settle()
    expect(episodes()).toHaveLength(1)
  })

  it('a degraded boot check raises one critical alert; a clean one dismisses it', async () => {
    const { addon, fire, episodes } = await boot()
    fire('system.runner-check', {
      nodeId: 'hub',
      degraded: true,
      summary: '9/28 runners running - failed: a',
      failed: ['a'],
      refused: [],
      missing: [],
    })
    await settle()
    const [check] = await addon.listAlerts()
    expect(check?.severity).toBe('critical')
    expect(episodes()).toHaveLength(1)
    fire('system.runner-check', {
      nodeId: 'hub',
      degraded: false,
      summary: 'ok',
      failed: [],
      refused: [],
      missing: [],
    })
    await settle()
    expect((await addon.listAlerts())[0]?.status).toBe('dismissed')
  })
})
