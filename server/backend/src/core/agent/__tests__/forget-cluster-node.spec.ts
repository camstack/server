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

/** What the harness did to the catalog, in order - the ORDER is the contract for a live node. */
type CatalogStep = 'disconnected' | 'deleted'

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
  /** The node announces itself again the moment it is deleted (a revocation that did not hold). */
  reappearsOnDelete = false,
) {
  const catalog = new Map<string, RegistryNode>(registryNodes.map((n) => [n.id, n]))
  const deleted: string[] = []
  const steps: CatalogStep[] = []
  const lines: LoggedLine[] = []

  const broker = {
    call: vi.fn(async () => undefined),
    waitForServices: vi.fn(async () => undefined),
    localBus: { on: vi.fn() },
    registry: {
      getNodeList: ({ onlyAvailable }: { onlyAvailable: boolean }) =>
        [...catalog.values()].filter((n) => (onlyAvailable ? n.available : true)),
      nodes: {
        // Moleculer's NodeCatalog.disconnected: marks the node unavailable (and unregisters its services).
        disconnected: (id: string): void => {
          const node = catalog.get(id)
          if (node?.available !== true) return
          steps.push('disconnected')
          catalog.set(id, { id, available: false })
        },
        delete: (id: string): boolean => {
          deleted.push(id)
          steps.push('deleted')
          const removed = catalog.delete(id)
          if (reappearsOnDelete) catalog.set(id, { id, available: true })
          return removed
        },
      },
    },
  }

  const moleculer = { broker } as unknown as MoleculerService
  const eventBus = { emit: vi.fn() } as unknown as EventBusService
  const capabilityService = {} as unknown as CapabilityService

  const service = new AgentRegistryService(eventBus, moleculer, capabilityService)
  service.setAddonRegistry({
    listAddons: () => [],
  } as unknown as AddonRegistryService)

  const push =
    (level: LoggedLine['level']) =>
    (
      message: string,
      extras?: {
        tags?: Record<string, unknown>
        meta?: Record<string, unknown>
      },
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

  return { service, deleted, lines, catalog, eventBus, steps }
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

  it('forgets an ONLINE node: disconnects it from the catalog first, then deletes it', async () => {
    const { service, deleted, steps, catalog } = makeHarness([
      { id: 'hub', available: true },
      { id: 'agent-a', available: true },
    ])
    service.setNodeCertificateRevoker(async () => ['01'])

    const result = await service.forgetClusterNode('agent-a')

    // `nodes.delete` alone leaves a live node's services registered and its pending calls
    // hanging; `disconnected` is what unregisters them and rejects those calls.
    expect(steps).toEqual(['disconnected', 'deleted'])
    expect(deleted).toEqual(['agent-a'])
    expect(catalog.has('agent-a')).toBe(false)
    expect(result.forgotten).toBe(true)
    expect(result.registryRemoved).toBe(true)
    expect(result.stillListed).toBe(false)
    expect(result.certificates).toEqual({
      outcome: 'revoked',
      serials: ['01'],
    })
  })

  it('reports an ONLINE node that comes straight back as STILL listed - no fake success', async () => {
    const { service } = makeHarness([{ id: 'agent-a', available: true }], 'removed', true, true)
    service.setNodeCertificateRevoker(async () => {
      throw new Error('disk full')
    })

    const result = await service.forgetClusterNode('agent-a')

    expect(result.stillListed).toBe(true)
    expect(result.certificates).toEqual({
      outcome: 'failed',
      error: 'disk full',
    })
    expect(result.message).toContain('STILL in the cluster registry')
    expect(result.message).toContain('NOT revoked')
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
    expect(line?.meta).toMatchObject({
      historyRemoved: true,
      registryRemoved: true,
    })
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

  it('runs the node-removal cleanup after a real forget (online or offline), not after a no-op', async () => {
    const forgotten = makeHarness([{ id: 'hub-test', available: false }])
    const onForgotten = vi.fn(async () => undefined)
    forgotten.service.setNodeRemovalCleanup(onForgotten)
    await forgotten.service.forgetClusterNode('hub-test')
    expect(onForgotten).toHaveBeenCalledTimes(1)
    expect(onForgotten).toHaveBeenCalledWith('hub-test', expect.any(Number))

    const live = makeHarness([{ id: 'agent-a', available: true }])
    const onLive = vi.fn(async () => undefined)
    live.service.setNodeRemovalCleanup(onLive)
    await live.service.forgetClusterNode('agent-a')
    expect(onLive).toHaveBeenCalledWith('agent-a', expect.any(Number))
    const ghost = makeHarness([{ id: 'hub', available: true }], 'not-found')
    const onGhost = vi.fn(async () => undefined)
    ghost.service.setNodeRemovalCleanup(onGhost)
    await ghost.service.forgetClusterNode('ghost')
    expect(onGhost).not.toHaveBeenCalled()
  })

  it('still answers the forget when the cleanup throws, and logs it with tags.nodeId', async () => {
    const { service, lines } = makeHarness([{ id: 'hub-test', available: false }])
    service.setNodeRemovalCleanup(async () => {
      throw new Error('boom')
    })

    const result = await service.forgetClusterNode('hub-test')

    expect(result.forgotten).toBe(true)
    const line = lines.find((l) => l.message.includes('node removal cleanup failed'))
    expect(line?.tags).toMatchObject({ nodeId: 'hub-test' })
  })
})

describe('AgentRegistryService.forgetClusterNode - certificates (D857)', () => {
  it('revokes every certificate of the forgotten node, with the reason "forgotten"', async () => {
    const { service } = makeHarness([{ id: 'agent-old', available: false }])
    const revoker = vi.fn(async () => ['0a', '0b'])
    service.setNodeCertificateRevoker(revoker)

    const result = await service.forgetClusterNode('agent-old')

    expect(revoker).toHaveBeenCalledWith('agent-old', 'forgotten')
    expect(result.certificates).toEqual({
      outcome: 'revoked',
      serials: ['0a', '0b'],
    })
    expect(result.message).toContain('2 certificate')
  })

  it('reports an unloaded certificate registry as such - never as "0 revoked" (D393)', async () => {
    const { service, lines } = makeHarness([{ id: 'agent-old', available: false }])
    service.setNodeCertificateRevoker(async () => null)

    const result = await service.forgetClusterNode('agent-old')

    expect(result.certificates).toEqual({ outcome: 'registry-unavailable' })
    expect(result.forgotten).toBe(true)
    expect(result.message).toContain('NOT revoked')
    const line = lines.find((l) => l.message.includes('certificates'))
    expect(line?.tags).toMatchObject({ nodeId: 'agent-old' })
  })

  it('reports a missing revoker wiring the same way', async () => {
    const { service } = makeHarness([{ id: 'agent-old', available: false }])
    const result = await service.forgetClusterNode('agent-old')
    expect(result.certificates).toEqual({ outcome: 'registry-unavailable' })
  })

  it('reports a revoke that throws as failed, logs it with tags.nodeId, and still forgets', async () => {
    const { service, lines } = makeHarness([{ id: 'agent-old', available: false }])
    service.setNodeCertificateRevoker(async () => {
      throw new Error('disk full')
    })

    const result = await service.forgetClusterNode('agent-old')

    expect(result.certificates).toEqual({
      outcome: 'failed',
      error: 'disk full',
    })
    expect(result.forgotten).toBe(true)
    expect(result.message).toContain('NOT revoked')
    const line = lines.find((l) => l.message.includes('certificates'))
    expect(line?.tags).toMatchObject({ nodeId: 'agent-old' })
  })

  it('revokes the certificates of an ONLINE node BEFORE it cuts it from the catalog', async () => {
    const { service, steps } = makeHarness([{ id: 'agent-a', available: true }])
    const order: string[] = []
    service.setNodeCertificateRevoker(async () => {
      order.push(`revoke (catalog steps so far: ${steps.length})`)
      return ['01']
    })

    await service.forgetClusterNode('agent-a')

    // Revoked first: a socket cut before the CRL entry would let the node walk straight back in.
    expect(order).toEqual(['revoke (catalog steps so far: 0)'])
    expect(steps).toEqual(['disconnected', 'deleted'])
  })
})
