/**
 * AgentRegistryService.listNodeDirectory() — the cheap node list (D637).
 *
 * It reads the in-memory Moleculer registry plus the durable history and
 * NOTHING else: the fake broker's `call` throws, so any per-node RPC (the
 * `topology` path, 32–51 s) fails the test. An unreadable history answers
 * `complete: false` (D315).
 */
import { describe, expect, it } from 'vitest'
import { createRecordsAccess, type IScopedLogger, type RecordsTransport } from '@camstack/types'
import { clusterAgentRecordKinds } from '../../../../../../packages/system/src/builtins/cluster-agent/record-kinds.js'
import { makeRecordsWorld } from '../../../../../../packages/system/src/builtins/sqlite-storage/__tests__/support/records-world.js'
import { AgentRegistryService } from '../agent-registry.service.js'
import { ClusterNodeHistoryStore } from '../cluster-node-history-store.js'
import type { EventBusService } from '../../events/event-bus.service.js'
import type { MoleculerService } from '../../moleculer/moleculer.service.js'
import type { CapabilityService } from '../../capability/capability.service.js'

interface FakeRegistryNode {
  readonly id: string
  readonly available: boolean
}

function noopLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function makeService(nodeList: readonly FakeRegistryNode[], calls: string[]): AgentRegistryService {
  const fakeEventBus = { emit: () => {} } as unknown as EventBusService
  const fakeMoleculer = {
    broker: {
      nodeID: 'hub',
      localBus: { on: () => {} },
      registry: {
        getNodeList: ({ onlyAvailable }: { onlyAvailable: boolean }) =>
          onlyAvailable ? nodeList.filter((n) => n.available) : nodeList,
      },
      call: async (action: string) => {
        calls.push(action)
        throw new Error(`per-node RPC is forbidden here: ${action}`)
      },
    },
    setOnAgentRegistered: () => {},
  } as unknown as MoleculerService
  const fakeCapability = { getRegistry: () => null } as unknown as CapabilityService
  return new AgentRegistryService(fakeEventBus, fakeMoleculer, fakeCapability)
}

interface QueryCounter {
  count: number
}

/** A history store on the real records engine, holding `rows`; counts the reads. */
async function historyStore(
  rows: readonly { id: string; name: string; isHub: boolean }[],
  queries: QueryCounter = { count: 0 },
): Promise<ClusterNodeHistoryStore> {
  const world = makeRecordsWorld()
  await world.provider.init()
  const inner = world.transportFor('cluster-agent')
  const transport: RecordsTransport = {
    ...inner,
    query: (input) => {
      queries.count += 1
      return inner.query(input)
    },
  }
  const records = createRecordsAccess({ owner: 'cluster-agent', transport, secrets: null })
  await records.declare(clusterAgentRecordKinds)
  const kind = records.kind(clusterAgentRecordKinds['node-history'])
  for (const row of rows) {
    await kind.put({
      id: row.id,
      at: 1,
      data: {
        descriptor: {
          id: row.id,
          name: row.name,
          hostname: row.id,
          platform: 'linux',
          arch: 'x64',
          cpuModel: null,
          cpuCores: 1,
          memoryMB: 1,
          engines: [],
          isHub: row.isHub,
          localIps: [],
          addonIds: [],
        },
      },
    })
  }
  return new ClusterNodeHistoryStore(noopLogger(), () => kind)
}

describe('AgentRegistryService.listNodeDirectory', () => {
  it('merges live liveness with history, makes no per-node RPC', async () => {
    const calls: string[] = []
    const service = makeService(
      [
        { id: 'hub', available: true },
        { id: 'agent-a', available: false },
      ],
      calls,
    )
    service.setClusterNodeHistoryStore(
      await historyStore([
        { id: 'agent-a', name: 'Mac mini', isHub: false },
        { id: 'agent-gone', name: 'Old NUC', isHub: false },
      ]),
    )
    expect(await service.listNodeDirectory()).toEqual({
      complete: true,
      nodes: [
        { id: 'hub', name: 'hub', isHub: true, isOnline: true },
        { id: 'agent-a', name: 'Mac mini', isHub: false, isOnline: false },
        { id: 'agent-gone', name: 'Old NUC', isHub: false, isOnline: false },
      ],
    })
    expect(calls).toEqual([])
  })

  it('an unavailable history store answers incomplete, live nodes still listed', async () => {
    const calls: string[] = []
    const service = makeService([{ id: 'hub', available: true }], calls)
    service.setClusterNodeHistoryStore(new ClusterNodeHistoryStore(noopLogger()))
    expect(await service.listNodeDirectory()).toEqual({
      complete: false,
      nodes: [{ id: 'hub', name: 'hub', isHub: true, isOnline: true }],
    })
    expect(calls).toEqual([])
  })

  it('no history store wired is incomplete, never an answered empty history', async () => {
    const service = makeService([{ id: 'hub', available: true }], [])
    expect((await service.listNodeDirectory()).complete).toBe(false)
  })

  it('serves the history the topology pass already read — no second records read', async () => {
    const queries: QueryCounter = { count: 0 }
    const service = makeService([{ id: 'hub', available: true }], [])
    service.setClusterNodeHistoryStore(
      await historyStore([{ id: 'agent-a', name: 'Mac mini', isHub: false }], queries),
    )
    await service.getClusterNodeHistory()
    expect(queries.count).toBe(1)
    const dir = await service.listNodeDirectory()
    expect(dir.complete).toBe(true)
    expect(dir.nodes.map((n) => n.id)).toEqual(['hub', 'agent-a'])
    expect(queries.count).toBe(1)
  })

  it('forgetting a node drops the mirror: the next directory re-reads', async () => {
    const queries: QueryCounter = { count: 0 }
    const service = makeService([{ id: 'hub', available: true }], [])
    service.setClusterNodeHistoryStore(
      await historyStore([{ id: 'agent-a', name: 'Mac mini', isHub: false }], queries),
    )
    await service.listNodeDirectory()
    expect(queries.count).toBe(1)
    await service.forgetClusterNode('agent-a')
    await service.listNodeDirectory()
    expect(queries.count).toBe(2)
  })
})
