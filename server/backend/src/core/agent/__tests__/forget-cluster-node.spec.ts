/**
 * "Forget node" must report what it actually removed.
 *
 * WHY THIS FILE EXISTS. On 2026-09-01 the operator forgot the offline node
 * `hub-test` over and over: `clusterNodes.forgetNode` answered
 * `{"success": true}`, the hub logged `forgot cluster node`, and
 * `nodes.topology` kept listing it.
 *
 * Both halves of that were true. The durable history row WAS deleted — the
 * topology row proved it (`lastSeen` had fallen back to `Date.now()` and the
 * shape was `buildOfflineEntry`'s, not the history projection's). The node was
 * still listed because `listNodes()` reads Moleculer's own registry with
 * `onlyAvailable: false`, and NOTHING removed the node from there. Forget
 * cleaned one of the two sources a topology row can come from and reported
 * success for both.
 *
 * So the contract pinned here is: forget purges BOTH sources, and answers with
 * what it removed — never an unconditional `success: true`.
 */
import { describe, expect, it, vi } from 'vitest'
import type { AddonRegistryService } from '../../addon/addon-registry.service'
import type { CapabilityService } from '../../capability/capability.service'
import type { EventBusService } from '../../events/event-bus.service'
import type { MoleculerService } from '../../moleculer/moleculer.service'
import type { ClusterNodeHistoryStore } from '../cluster-node-history-store'
import { AgentRegistryService } from '../agent-registry.service'

interface RegistryNode {
  readonly id: string
  readonly available: boolean
}

interface LoggedLine {
  readonly level: 'info' | 'warn'
  readonly message: string
  readonly tags?: Record<string, unknown>
  readonly meta?: Record<string, unknown>
}

function makeHarness(
  registryNodes: readonly RegistryNode[],
  historyOutcome: 'removed' | 'not-found' | 'store-unavailable' = 'removed',
  withStore = true,
) {
  const catalog = new Map(registryNodes.map((n) => [n.id, n]))
  const deleted: string[] = []
  const lines: LoggedLine[] = []

  const broker = {
    call: vi.fn(async () => undefined),
    waitForServices: vi.fn(async () => undefined),
    localBus: { on: vi.fn() },
    registry: {
      getNodeList: ({ onlyAvailable }: { onlyAvailable: boolean }) =>
        [...catalog.values()].filter((n) => (onlyAvailable ? n.available : true)),
      nodes: {
        delete: (id: string): boolean => {
          deleted.push(id)
          return catalog.delete(id)
        },
      },
    },
  }

  const moleculer = { broker } as unknown as MoleculerService
  const eventBus = { emit: vi.fn() } as unknown as EventBusService
  const capabilityService = {} as unknown as CapabilityService

  const service = new AgentRegistryService(eventBus, moleculer, capabilityService)
  service.setAddonRegistry({ listAddons: () => [] } as unknown as AddonRegistryService)

  const push =
    (level: LoggedLine['level']) =>
    (
      message: string,
      extras?: { tags?: Record<string, unknown>; meta?: Record<string, unknown> },
    ) => {
      lines.push({
        level,
        message,
        ...(extras?.tags !== undefined ? { tags: extras.tags } : {}),
        ...(extras?.meta !== undefined ? { meta: extras.meta } : {}),
      })
    }
  service.setLogger({
    debug: () => undefined,
    info: push('info'),
    warn: push('warn'),
    error: () => undefined,
    child: () => {
      throw new Error('unused')
    },
    withTags: () => {
      throw new Error('unused')
    },
  })

  if (withStore) {
    service.setClusterNodeHistoryStore({
      forget: async () => historyOutcome,
    } as unknown as ClusterNodeHistoryStore)
  }

  return { service, deleted, lines, catalog, eventBus }
}

describe('AgentRegistryService.forgetClusterNode', () => {
  it('removes the offline node from the Moleculer registry, not only the history row', async () => {
    const { service, deleted, catalog } = makeHarness([
      { id: 'hub', available: true },
      { id: 'hub-test', available: false },
    ])

    const result = await service.forgetClusterNode('hub-test')

    expect(deleted).toEqual(['hub-test'])
    expect(catalog.has('hub-test')).toBe(false)
    expect(result.registryRemoved).toBe(true)
    expect(result.historyRemoved).toBe(true)
    expect(result.forgotten).toBe(true)
    expect(result.stillListed).toBe(false)
  })

  it('does NOT claim success when nothing was there to remove', async () => {
    const { service, deleted } = makeHarness([{ id: 'hub', available: true }], 'not-found')

    const result = await service.forgetClusterNode('ghost')

    expect(deleted).toEqual([])
    expect(result.historyRemoved).toBe(false)
    expect(result.registryRemoved).toBe(false)
    expect(result.forgotten).toBe(false)
  })

  it('refuses an ONLINE node instead of silently half-forgetting it', async () => {
    const { service, deleted } = makeHarness([
      { id: 'hub', available: true },
      { id: 'agent-a', available: true },
    ])

    const result = await service.forgetClusterNode('agent-a')

    // Deleting a live node from the routing catalog would break every cap call
    // pinned to it, and the node re-registers within a heartbeat anyway.
    expect(deleted).toEqual([])
    expect(result.forgotten).toBe(false)
    expect(result.stillListed).toBe(true)
    expect(result.message).toMatch(/online/i)
  })

  it('reports a missing history store as unknown, never as a successful delete', async () => {
    const { service } = makeHarness([{ id: 'hub-test', available: false }], 'removed', false)

    const result = await service.forgetClusterNode('hub-test')

    // An optional-chained `historyStore?.forget()` made "no store wired" look
    // exactly like "row deleted". It is not the same fact.
    expect(result.historyRemoved).toBe(false)
    expect(result.message).toMatch(/history/i)
  })

  it('logs the outcome with tags.nodeId on every path', async () => {
    const { service, lines } = makeHarness([{ id: 'hub-test', available: false }])

    await service.forgetClusterNode('hub-test')

    const line = lines.find((l) => l.message.includes('forget cluster node'))
    expect(line).toBeDefined()
    expect(line?.tags).toMatchObject({ nodeId: 'hub-test' })
    expect(line?.meta).toMatchObject({ historyRemoved: true, registryRemoved: true })
  })

  it('emits AgentUnregistered so the topology push drops the row immediately', async () => {
    const { service, eventBus } = makeHarness([{ id: 'hub-test', available: false }])

    await service.forgetClusterNode('hub-test')

    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'agent.unregistered',
        data: { agentId: 'hub-test' },
      }),
    )
  })
})
