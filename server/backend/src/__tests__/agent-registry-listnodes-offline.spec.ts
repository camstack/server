/**
 * AgentRegistryService.listNodes() — offline-node inclusion.
 *
 * `listNodes()` used to read the Moleculer registry with
 * `onlyAvailable: true`, so a disconnected node vanished from the list
 * entirely (the #25 "offline nodes hidden" gap, previously worked around by
 * the now-removed `OfflineAgentsPanel`). It now reads `onlyAvailable: false`
 * and, for any node Moleculer still remembers as `available: false`, emits
 * a minimal degraded row (`isOnline: false`) instead of attempting an
 * `$agent.status`/`$process.list` RPC round-trip that would just time out.
 */
import { describe, it, expect } from 'vitest'
import { AgentRegistryService } from '../core/agent/agent-registry.service.js'
import type { EventBusService } from '../core/events/event-bus.service.js'
import type { MoleculerService } from '../core/moleculer/moleculer.service.js'
import type { CapabilityService } from '../core/capability/capability.service.js'

interface FakeRegistryNode {
  readonly id: string
  readonly available: boolean
  readonly hostname?: string | null
}

function createFakes(nodeList: readonly FakeRegistryNode[], opts: { agentStatusCalls: string[] }) {
  const fakeEventBus = { emit: () => {} } as unknown as EventBusService

  const fakeMoleculer = {
    broker: {
      nodeID: 'hub',
      localBus: { on: () => {} },
      registry: {
        getNodeList: ({ onlyAvailable }: { onlyAvailable: boolean }) =>
          onlyAvailable ? nodeList.filter((n) => n.available) : nodeList,
      },
      call: async (action: string, _params?: unknown, options?: { nodeID?: string }) => {
        if (action === '$process.list') return []
        if (action === '$agent.status') {
          if (options?.nodeID) opts.agentStatusCalls.push(options.nodeID)
          return {
            hostname: `${options?.nodeID}-host`,
            name: options?.nodeID,
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
      },
    },
    setOnAgentRegistered: () => {},
  } as unknown as MoleculerService

  const fakeCapability = { getRegistry: () => null } as unknown as CapabilityService
  return new AgentRegistryService(fakeEventBus, fakeMoleculer, fakeCapability)
}

describe('AgentRegistryService.listNodes() — offline nodes', () => {
  it('includes a disconnected node inline with isOnline:false, without RPC fan-out', async () => {
    const agentStatusCalls: string[] = []
    const service = createFakes(
      [
        { id: 'live-agent', available: true, hostname: 'live-host' },
        { id: 'dead-agent', available: false, hostname: 'dead-host' },
      ],
      { agentStatusCalls },
    )

    const nodes = await service.listNodes()
    const byId = new Map(nodes.map((n) => [n.info.id, n]))

    expect(byId.has('hub')).toBe(true)
    expect(byId.get('hub')!.isHub).toBe(true)

    const live = byId.get('live-agent')
    expect(live).toBeDefined()
    expect(live!.isOnline).not.toBe(false)

    const dead = byId.get('dead-agent')
    expect(dead).toBeDefined()
    expect(dead!.isOnline).toBe(false)
    expect(dead!.isHub).toBe(false)
    expect(dead!.info.hostname).toBe('dead-host')
    expect(dead!.status.cpuPercent).toBe(0)
    expect(dead!.status.memoryPercent).toBe(0)

    // The offline branch must never attempt the $agent.status RPC — the
    // node is unreachable by definition, so no round-trip should be tried.
    expect(agentStatusCalls).toEqual(['live-agent'])
  })

  it('preserves existing behavior when every node is online', async () => {
    const agentStatusCalls: string[] = []
    const service = createFakes([{ id: 'live-agent', available: true, hostname: 'live-host' }], {
      agentStatusCalls,
    })

    const nodes = await service.listNodes()
    expect(nodes).toHaveLength(2) // hub + live-agent
    expect(nodes.some((n) => n.isOnline === false)).toBe(false)
    expect(agentStatusCalls).toEqual(['live-agent'])
  })
})
