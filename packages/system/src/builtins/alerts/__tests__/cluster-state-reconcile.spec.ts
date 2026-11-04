/**
 * The centre resolves node alerts from `nodes.directory`, including cards
 * that were already active when it booted. `agent.online` is a hint; a
 * dropped one still clears on the next reconcile.
 */
import type { AddonContext, IEventBus, IScopedLogger, SystemEvent } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AlertCenterAddon } from '../alerts.addon.js'
import { CLUSTER_STATE_RECONCILE_MS } from '../cluster-state-alerts.js'

type Row = Record<string, unknown>

interface Presence {
  readonly id: string
  readonly isOnline: boolean
}

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
  const bus = {
    emit: () => undefined,
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
        source: { type: 'core', id: 'agent-registry' },
        category,
        data,
      } as unknown as SystemEvent)
    }
  }
  return { bus, fire }
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
  withTags: vi.fn().mockReturnThis(),
} as unknown as IScopedLogger

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 40))

function seed(
  rows: Map<string, Row>,
  id: string,
  category: string,
  metadata: Record<string, unknown>,
): void {
  rows.set(id, {
    id,
    category,
    severity: 'warning',
    title: 't',
    message: 'm',
    status: 'active',
    read: false,
    createdAt: 1,
    updatedAt: 1,
    metadata,
  })
}

describe('node alerts reconcile from the node list', () => {
  let tick: (() => void) | null = null
  let addon: AlertCenterAddon | null = null

  afterEach(async () => {
    await addon?.shutdown()
    addon = null
    vi.restoreAllMocks()
  })

  async function boot(opts: {
    readonly nodes: readonly Presence[]
    readonly failDirectory?: boolean
    readonly seedRows?: (rows: Map<string, Row>) => void
  }) {
    tick = null
    const real = globalThis.setInterval
    vi.spyOn(globalThis, 'setInterval').mockImplementation((handler, timeout, ...args) => {
      if (timeout === CLUSTER_STATE_RECONCILE_MS && typeof handler === 'function') {
        const run = handler
        tick = () => {
          run()
        }
      }
      return real(handler, timeout, ...args)
    })
    const presence = new Map(opts.nodes.map((node) => [node.id, node.isOnline]))
    const store = createStore()
    opts.seedRows?.(store.rows)
    const { bus, fire } = createBus()
    const started = new AlertCenterAddon()
    addon = started
    await started.initialize({
      api: {
        settingsStore: store.api,
        nodes: {
          directory: {
            query: async () => {
              if (opts.failDirectory === true) throw new Error('node list unread')
              return {
                nodes: [...presence.entries()].map(([id, isOnline]) => ({
                  id,
                  name: id,
                  isHub: id === 'hub',
                  isOnline,
                })),
                complete: true,
              }
            },
          },
        },
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
    return {
      addon: started,
      fire,
      setOnline: (id: string, isOnline: boolean): void => {
        presence.set(id, isOnline)
      },
      reconcile: (): void => {
        if (tick === null) throw new Error('reconcile timer was not scheduled')
        tick()
      },
    }
  }

  it('an agent.offline alert resolves once the node is online, without a second event', async () => {
    const {
      addon: centre,
      fire,
      setOnline,
      reconcile,
    } = await boot({
      nodes: [{ id: 'little-unraid', isOnline: false }],
    })
    fire('agent.offline', { agentId: 'little-unraid', reason: 'connection-lost' })
    await settle()
    expect((await centre.listAlerts())[0]?.status).toBe('active')
    setOnline('little-unraid', true)
    reconcile()
    await settle()
    expect((await centre.listAlerts())[0]?.status).toBe('dismissed')
  })

  it('agent.online is only the hint: the same resolve happens when the list says online', async () => {
    const {
      addon: centre,
      fire,
      setOnline,
    } = await boot({
      nodes: [{ id: 'mac-mini', isOnline: false }],
    })
    fire('agent.offline', { agentId: 'mac-mini', reason: 'connection-lost' })
    await settle()
    setOnline('mac-mini', true)
    fire('agent.online', { agentId: 'mac-mini' })
    await settle()
    const alerts = await centre.listAlerts()
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.status).toBe('dismissed')
  })

  it('a system.restarting alert resolves when the node is back online', async () => {
    const {
      addon: centre,
      fire,
      setOnline,
      reconcile,
    } = await boot({
      nodes: [{ id: 'amd-proxmox', isOnline: false }],
    })
    fire('system.restarting', { nodeId: 'amd-proxmox', kind: 'manual', requestedAt: 10 })
    await settle()
    expect((await centre.listAlerts())[0]?.status).toBe('active')
    setOnline('amd-proxmox', true)
    reconcile()
    await settle()
    expect((await centre.listAlerts())[0]?.status).toBe('dismissed')
  })

  it('a matching restart completion resolves system.restarting while the node is still listed offline', async () => {
    const { addon: centre, fire } = await boot({
      nodes: [{ id: 'hub', isOnline: false }],
    })
    fire('system.restarting', { nodeId: 'hub', kind: 'manual', requestedAt: 40 })
    await settle()
    fire('system.restart-completed', { nodeId: 'hub', kind: 'manual', requestedAt: 40 })
    await settle()
    const restarting = (await centre.listAlerts()).find(
      (row) => row.category === 'system.restarting',
    )
    expect(restarting?.status).toBe('dismissed')
  })

  it('a node that is still offline stays active across a reconcile', async () => {
    const {
      addon: centre,
      fire,
      reconcile,
    } = await boot({
      nodes: [{ id: 'little-unraid', isOnline: false }],
    })
    fire('agent.offline', { agentId: 'little-unraid', reason: 'connection-lost' })
    fire('system.restarting', { nodeId: 'little-unraid', kind: 'manual', requestedAt: 10 })
    await settle()
    reconcile()
    await settle()
    const alerts = await centre.listAlerts()
    expect(alerts.map((row) => row.status)).toEqual(['active', 'active'])
  })

  it('alerts already active at boot resolve when the list says those nodes are online', async () => {
    const { addon: centre } = await boot({
      nodes: [
        { id: 'little-unraid', isOnline: true },
        { id: 'mac-mini', isOnline: true },
        { id: 'amd-proxmox', isOnline: false },
      ],
      seedRows: (rows) => {
        seed(rows, 'off-1', 'agent.offline', { agentId: 'little-unraid' })
        seed(rows, 'off-2', 'agent.offline', { agentId: 'mac-mini' })
        seed(rows, 'rst-1', 'system.restarting', { nodeId: 'little-unraid', requestedAt: 1 })
        seed(rows, 'rst-2', 'system.restarting', { nodeId: 'mac-mini', requestedAt: 1 })
        seed(rows, 'still', 'agent.offline', { agentId: 'amd-proxmox' })
      },
    })
    await settle()
    const byId = new Map((await centre.listAlerts()).map((row) => [row.id, row.status]))
    expect(byId.get('off-1')).toBe('dismissed')
    expect(byId.get('off-2')).toBe('dismissed')
    expect(byId.get('rst-1')).toBe('dismissed')
    expect(byId.get('rst-2')).toBe('dismissed')
    expect(byId.get('still')).toBe('active')
  })

  it('a node list that cannot be read leaves active alerts alone', async () => {
    const {
      addon: centre,
      fire,
      reconcile,
    } = await boot({
      nodes: [{ id: 'little-unraid', isOnline: true }],
      failDirectory: true,
    })
    fire('agent.offline', { agentId: 'little-unraid', reason: 'connection-lost' })
    await settle()
    reconcile()
    await settle()
    expect((await centre.listAlerts())[0]?.status).toBe('active')
  })
})
