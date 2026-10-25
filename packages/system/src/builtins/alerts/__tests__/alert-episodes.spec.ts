/**
 * The alert centre sends NOTHING of its own. It announces each alert EPISODE on
 * the bus (`alert.episode`) and Notification Center turns that into a
 * notification through a system-event rule.
 *
 *  - a critical/error alert opening is announced ONCE per episode;
 *  - a re-emit of the same open alert is not announced again;
 *  - closing the alert announces the resolution;
 *  - an alert that opens again after it was closed is a NEW episode;
 *  - nothing ever reaches `notificationOutput`.
 */
import type {
  Alert,
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
      set: {
        mutate: async (i: { key: string; value: Row }) => void rows.set(i.key, i.value),
      },
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
          id: String(data['runnerId'] ?? 'x'),
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

async function boot(
  storedRows: Record<string, Row> = {},
  addonStore: Record<string, unknown> = {},
) {
  const store = createStore()
  for (const [id, row] of Object.entries(storedRows)) store.rows.set(id, row)
  const { bus, fire, episodes } = createBus()
  const addon = new AlertCenterAddon()
  const push = vi.fn(async () => ({ success: true }))
  const api = {
    settingsStore: store.api,
    capabilities: { getCapability: { query: async () => null } },
    // The old autonomous push path would have called these.
    notificationOutput: {
      listTargets: {
        query: async () => [{ id: 'ops', addonId: 'notifiers', enabled: true, config: {} }],
      },
      send: { mutate: push },
    },
  }
  const init = await addon.initialize({
    api,
    eventBus: bus,
    logger,
    addonConfig: {},
    kernel: {},
    settings: {
      readAddonStore: async () => addonStore,
      writeAddonStore: async () => undefined,
      readDeviceStore: async () => ({}),
      writeDeviceStore: async () => undefined,
      setSection: async () => undefined,
    },
  } as unknown as AddonContext)
  const registrations = Array.isArray(init) ? init : init?.providers
  const registration = registrations?.find((r) => r.capability.name === 'alerts')
  const provider = registration?.provider as unknown as {
    emit: (alert: Alert) => Promise<void>
    update: (input: { alertId: string; patch: Partial<Alert> }) => Promise<void>
  }
  return { addon, store, fire, episodes, push, provider }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

const T0 = Date.now() - 60_000

const criticalAlert = (over: Partial<Alert> = {}): Alert => ({
  id: 'recorder:placement:loc-1',
  category: 'recorder.placement',
  severity: 'critical',
  title: 'Recording location full',
  message: 'No free space on loc-1',
  status: 'active',
  read: false,
  createdAt: T0,
  updatedAt: T0,
  source: { type: 'addon', id: 'recorder' },
  ...over,
})

const refuse = (fire: (c: string, d: Record<string, unknown>) => void, id: string): void =>
  fire('addon.runner-refused', {
    runnerId: id,
    nodeId: 'hub',
    addonIds: [id],
    code: 'unmigrated-settings',
    reason: 'legacy blobs',
    remedy: 'Run the migration.',
  })

describe('the alert centre never pushes (operator decision 2026-10-21)', () => {
  it('a refused runner raises a critical alert and sends nothing to the notifiers', async () => {
    const { addon, fire, push, episodes } = await boot()
    refuse(fire, 'auth')
    fire('addon.started', { addonId: 'notifiers' })
    await settle()
    const alerts = await addon.listAlerts()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.severity).toBe('critical')
    expect(alerts[0]?.metadata?.['push']).toBeUndefined()
    expect(push).not.toHaveBeenCalled()
    expect(episodes()).toHaveLength(1)
  })
})

describe('alert episodes', () => {
  it('a critical alert raised is announced exactly once, with what a rule template needs', async () => {
    const { provider, episodes, push } = await boot()
    await provider.emit(criticalAlert({ action: { label: 'Open', href: '/system/storage' } }))
    await settle()
    expect(episodes()).toHaveLength(1)
    expect(episodes()[0]).toMatchObject({
      phase: 'raised',
      alertId: 'recorder:placement:loc-1',
      severity: 'critical',
      category: 'recorder.placement',
      title: 'Recording location full',
      message: 'No free space on loc-1',
      sourceType: 'addon',
      sourceId: 'recorder',
      actionUrl: '/system/storage',
    })
    expect(episodes()[0]?.episodeId).toEqual(expect.any(String))
    expect(push).not.toHaveBeenCalled()
  })

  it('re-emitting the same open alert (any createdAt) never announces it again', async () => {
    const { provider, episodes } = await boot()
    await provider.emit(criticalAlert())
    await provider.emit(criticalAlert({ createdAt: T0 + 5000, updatedAt: T0 + 5000 }))
    await provider.emit(criticalAlert({ message: 'No free space (98%)', updatedAt: T0 + 6000 }))
    await settle()
    expect(episodes().filter((e) => e.phase === 'raised')).toHaveLength(1)
  })

  it('resolving the alert announces the resolution of the SAME episode', async () => {
    const { addon, provider, episodes } = await boot()
    await provider.emit(criticalAlert())
    await addon.dismiss('recorder:placement:loc-1')
    await settle()
    const [raised, resolved] = episodes()
    expect(resolved?.phase).toBe('resolved')
    expect(resolved?.episodeId).toBe(raised?.episodeId)
    // dismissing an already closed alert says nothing more
    await addon.dismiss('recorder:placement:loc-1')
    expect(episodes()).toHaveLength(2)
  })

  it('an alert that opens again after it was closed is a NEW episode', async () => {
    const { provider, episodes } = await boot()
    await provider.emit(criticalAlert())
    await provider.update({
      alertId: 'recorder:placement:loc-1',
      patch: { status: 'completed' },
    })
    await provider.emit(criticalAlert({ createdAt: T0 + 9000, updatedAt: T0 + 9000 }))
    await settle()
    const raised = episodes().filter((e) => e.phase === 'raised')
    expect(raised).toHaveLength(2)
    expect(raised[1]?.episodeId).not.toBe(raised[0]?.episodeId)
    expect(episodes().filter((e) => e.phase === 'resolved')).toHaveLength(1)
  })

  it('a runner that recovers resolves its episode; failing again opens a new one', async () => {
    const { fire, episodes } = await boot()
    refuse(fire, 'auth')
    await settle()
    fire('process.state-changed', {
      runnerId: 'auth',
      nodeId: 'hub',
      addonIds: ['auth'],
      state: 'running',
    })
    await settle()
    refuse(fire, 'auth')
    await settle()
    expect(episodes().map((e) => e.phase)).toEqual(['raised', 'resolved', 'raised'])
    const ids = new Set(episodes().map((e) => e.episodeId))
    expect(ids.size).toBe(2)
  })

  it('warning and info alerts are never announced; an error is announced as raised only', async () => {
    const { addon, provider, episodes } = await boot()
    await provider.emit(criticalAlert({ id: 'w', severity: 'warning' }))
    await provider.emit(criticalAlert({ id: 'e', severity: 'error' }))
    await addon.dismiss('w')
    await settle()
    expect(episodes().map((e) => `${e.alertId}:${e.severity}:${e.phase}`)).toEqual([
      'e:error:raised',
    ])
  })

  it('a stored alert row with a leftover push record still loads and is not rewritten with it', async () => {
    const { addon } = await boot({
      legacy: {
        category: 'addon.runner-refused',
        severity: 'error',
        title: 'Addon refused to start',
        message: 'x',
        status: 'active',
        read: false,
        createdAt: 1,
        updatedAt: 1,
        metadata: {
          push: { state: 'pending', key: 'k', attempts: 3 },
          pushLine: 'old',
        },
      },
    })
    expect(await addon.listAlerts()).toHaveLength(1)
  })

  it('settings stored by the push-era schema still boot, and are not in the schema any more', async () => {
    const { addon } = await boot(
      {},
      {
        maxAlerts: 77,
        criticalPushEnabled: false,
        criticalPushTargetIds: 'ops,phone',
      },
    )
    const schema = await addon.getGlobalSettings()
    const keys = schema?.sections[0]?.fields.map((f) => ('key' in f ? f.key : undefined))
    expect(keys).toEqual(['maxAlerts', 'retentionDays'])
    const max = schema?.sections[0]?.fields.find((f) => 'key' in f && f.key === 'maxAlerts')
    expect(max).toMatchObject({ value: 77 })
  })
})
