/**
 * `nodes.topology` — the SHAPE of one operator read (D317).
 *
 * Measured on the production hub on 2026-08-31, with every leg isolated
 * against its own endpoint rather than attributed by subtraction:
 *
 *   nodes.getNodeAddons({nodeId:'hub'})     14–39 ms   (HTTP+auth+local registry)
 *   metricsProvider.listAddonInstances      92 ms      (hub `$process.list` + forked `ps`)
 *   metricsProvider.getCached               95 ms      (buildHubEntry's metrics leg)
 *   ONE settings-store round trip           14 846–18 349 ms
 *   nodes.topology                          30 483 ms  (= 2 x 15 557 ms store tick)
 *
 * Three settings-store calls fired in PARALLEL all ended within 1 ms of each
 * other, so the store is not throughput-bound — it stalls, and everything in
 * flight is released together. A read therefore costs one tick per SEQUENTIAL
 * store phase, and `listNodes()` had two: the per-node capture read-back, then
 * `getClusterNodeHistory()`.
 *
 * These tests pin the shape, never the clock:
 *   1. a READ performs no durable WRITE and no per-node durable read;
 *   2. the history read is in flight WHILE the per-node RPCs are;
 *   3. the per-node RPC legs are concurrent, not one node after another;
 *   4. the capture still happens — on the emitter's periodic pass;
 *   5. nothing stopped being reported: the projection is byte-identical.
 */
import { describe, expect, it } from 'vitest'
import { computeTopology } from '../../api/core/cap-providers.js'
import { AgentRegistryService } from '../../core/agent/agent-registry.service.js'
import type { ClusterNodeHistoryStore } from '../../core/agent/cluster-node-history-store.js'
import type { CapabilityService } from '../../core/capability/capability.service.js'
import type { EventBusService } from '../../core/events/event-bus.service.js'
import type { MoleculerService } from '../../core/moleculer/moleculer.service.js'

/** Every operation the fakes observe, in issue order, with an in-flight marker. */
interface Journal {
  readonly ops: string[]
  readonly inFlight: Set<string>
  /** Ops that were in flight at the instant each named op STARTED. */
  readonly overlaps: Map<string, readonly string[]>
}

function createJournal(): Journal {
  return { ops: [], inFlight: new Set(), overlaps: new Map() }
}

function record<T>(journal: Journal, op: string, run: () => Promise<T>): Promise<T> {
  journal.ops.push(op)
  journal.overlaps.set(op, [...journal.inFlight])
  journal.inFlight.add(op)
  return run().finally(() => {
    journal.inFlight.delete(op)
  })
}

/** Resolve on the next macrotask so concurrent callers actually interleave. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5))
}

const AGENT_IDS = ['agent-a', 'agent-b'] as const

function createAgentRegistry(journal: Journal): AgentRegistryService {
  const eventBus = { emit: () => {} } as unknown as EventBusService

  const moleculer = {
    broker: {
      nodeID: 'hub',
      localBus: { on: () => {} },
      registry: {
        getNodeList: () => [
          { id: 'hub', available: true, hostname: 'hub-host' },
          ...AGENT_IDS.map((id) => ({ id, available: true, hostname: `${id}-host` })),
        ],
      },
      call: async (action: string, _params?: unknown, options?: { nodeID?: string }) => {
        const target = options?.nodeID ?? 'hub'
        return record(journal, `rpc:${action}@${target}`, async () => {
          await tick()
          if (action === '$process.list') return []
          if (action === '$agent.status') {
            return {
              hostname: `${target}-host`,
              name: target,
              platform: 'linux',
              arch: 'x64',
              cpuCores: 4,
              totalMemoryMB: 8192,
              cpuPercent: 5,
              memoryPercent: 10,
              uptime: 120,
              addons: [],
              localIps: [],
            }
          }
          throw new Error(`unexpected action ${action}`)
        })
      },
    },
    setOnAgentRegistered: () => {},
  } as unknown as MoleculerService

  const capability = { getRegistry: () => null } as unknown as CapabilityService
  const service = new AgentRegistryService(eventBus, moleculer, capability)

  const historyStore = {
    tryGetAll: async () =>
      record(journal, 'store:tryGetAll', async () => {
        await tick()
        return [
          {
            id: 'ghost-agent',
            name: 'Ghost',
            hostname: 'ghost.local',
            platform: 'linux',
            arch: 'x64',
            cpuModel: 'N100',
            cpuCores: 4,
            memoryMB: 4096,
            engines: [],
            isHub: false,
            localIps: [],
            addonIds: ['some-addon'],
            lastActive: 1_700_000_000_000,
          },
        ]
      }),
    snapshot: async (descriptor: { id: string }) =>
      record(journal, `store:snapshot@${descriptor.id}`, async () => {
        await tick()
      }),
  } as unknown as ClusterNodeHistoryStore

  service.setClusterNodeHistoryStore(historyStore)
  return service
}

describe('nodes.topology — one operator read is proportional (D317)', () => {
  it('performs NO durable write and NO per-node durable read', async () => {
    const journal = createJournal()
    await computeTopology(createAgentRegistry(journal))

    const storeOps = journal.ops.filter((op) => op.startsWith('store:'))
    expect(storeOps.filter((op) => op.startsWith('store:snapshot'))).toEqual([])
    expect(storeOps).toEqual(['store:tryGetAll'])
  })

  it('reads the history WHILE the per-node RPCs are in flight, not after them', async () => {
    const journal = createJournal()
    await computeTopology(createAgentRegistry(journal))

    const overlap = journal.overlaps.get('store:tryGetAll') ?? []
    expect(overlap.some((op) => op.startsWith('rpc:'))).toBe(true)
  })

  it('issues the per-agent RPC legs concurrently, not one node after another', async () => {
    const journal = createJournal()
    await computeTopology(createAgentRegistry(journal))

    const lastAgentStatus = `rpc:$agent.status@${AGENT_IDS[AGENT_IDS.length - 1]}`
    const overlap = journal.overlaps.get(lastAgentStatus) ?? []
    expect(overlap).toContain(`rpc:$agent.status@${AGENT_IDS[0]}`)
  })

  it('still reports every node and every field the Cluster page renders', async () => {
    const journal = createJournal()
    const nodes = await computeTopology(createAgentRegistry(journal))

    const byId = new Map(nodes.map((n) => [n.id, n]))
    expect([...byId.keys()].sort()).toEqual(['agent-a', 'agent-b', 'ghost-agent', 'hub'])

    const hub = byId.get('hub')
    expect(hub?.isHub).toBe(true)
    expect(hub?.processes.length).toBeGreaterThan(0)

    const agent = byId.get('agent-a')
    expect(agent?.isOnline).toBe(true)
    expect(agent?.cpuCores).toBe(4)
    expect(agent?.memoryMB).toBe(8192)
    expect(agent?.cpuPercent).toBe(5)
    expect(agent?.memoryPercent).toBe(10)

    // The offline row from durable history is still unioned in.
    const ghost = byId.get('ghost-agent')
    expect(ghost?.isOnline).toBe(false)
    expect(ghost?.name).toBe('Ghost')
    expect(ghost?.lastSeen).toBe(new Date(1_700_000_000_000).toISOString())
  })
})

describe('the durable capture still happens — on the periodic pass (D317)', () => {
  it('captureNodeHistory snapshots every online node', async () => {
    const journal = createJournal()
    const service = createAgentRegistry(journal)

    const live = await service.listNodes()
    await service.captureNodeHistory(live)

    const snapshots = journal.ops.filter((op) => op.startsWith('store:snapshot@')).sort()
    expect(snapshots).toEqual([
      'store:snapshot@agent-a',
      'store:snapshot@agent-b',
      'store:snapshot@hub',
    ])
  })
})
