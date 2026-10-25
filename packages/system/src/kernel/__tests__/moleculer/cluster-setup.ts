import { ServiceBroker } from 'moleculer'
import { createHubService } from '../../moleculer/hub-service.js'
import { HubNodeRegistry } from '../../moleculer/node-registry.js'
import {
  getBrokerEventBus,
  registerEventBusService,
} from '../../moleculer/addon-context-factory.js'
import type { HubServiceDeps } from '../../moleculer/hub-service.js'
import type { SystemEvent } from '@camstack/types'

interface TestCluster {
  readonly hub: ServiceBroker
  readonly agents: ReadonlyMap<string, ServiceBroker>
  readonly receivedEvents: Array<Record<string, unknown>>
  readonly registeredProviders: Array<{ capName: string; addonId: string; nodeId: string }>
  readonly disconnectedProviders: Array<{ nodeId: string; addonId: string }>
  start(): Promise<void>
  stop(): Promise<void>
}

/** Poll until condition is true or timeout (ms) elapses. */
async function waitUntil(condition: () => boolean, timeout = 3000, interval = 100): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error(`waitUntil timed out after ${timeout}ms`)
    }
    await new Promise((r) => setTimeout(r, interval))
  }
}

function getAvailableNodeIds(broker: ServiceBroker): readonly string[] {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double: reach broker registry internals
  const registry = (broker as unknown as Record<string, unknown>).registry as
    | { getNodeList: (opts: Record<string, boolean>) => readonly { id: string }[] }
    | undefined
  const nodes = registry?.getNodeList?.({ onlyAvailable: true }) ?? []
  return nodes.map((n) => n.id)
}

function hasRemoteServices(broker: ServiceBroker, nodeId: string): boolean {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double: reach broker registry internals
  const registry = (broker as unknown as Record<string, unknown>).registry as
    | { getServiceList: (opts: Record<string, boolean>) => readonly { nodeID: string }[] }
    | undefined
  const services = registry?.getServiceList?.({ onlyAvailable: true, withActions: true }) ?? []
  return services.some((s) => s.nodeID === nodeId)
}

function createTestCluster(agentIds: readonly string[]): TestCluster {
  const hub = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
  const agents = new Map<string, ServiceBroker>()
  for (const id of agentIds) {
    agents.set(id, new ServiceBroker({ nodeID: id, transporter: 'Fake', logger: false }))
  }

  const receivedEvents: Array<Record<string, unknown>> = []
  const registeredProviders: Array<{ capName: string; addonId: string; nodeId: string }> = []
  const disconnectedProviders: Array<{ nodeId: string; addonId: string }> = []

  // D3: HubNodeRegistry tracks node manifests delivered via $hub.registerNode.
  const nodeRegistry = new HubNodeRegistry()

  const hubDeps: HubServiceDeps = {
    getAddonConfig: (addonId) => ({ addonId }),
    getSettings: () => ({}),
    getRecentEvents: () => [],
    onLog: () => {},
    // D3 registration handshake: populate registeredProviders from the manifest.
    onRegisterNode: (params) => {
      nodeRegistry.registerNode(params)
      for (const addon of params.addons) {
        for (const capName of addon.capabilities) {
          registeredProviders.push({ capName, addonId: addon.addonId, nodeId: params.nodeId })
        }
      }
    },
    onUnregisterNode: (nodeId) => {
      const manifest = nodeRegistry.getNodeManifest(nodeId)
      if (manifest) {
        for (const addon of manifest) {
          disconnectedProviders.push({ nodeId, addonId: addon.addonId })
        }
      }
      nodeRegistry.removeNode(nodeId)
    },
  }

  hub.createService(createHubService(hubDeps))

  // Events flow via per-category `camstack.evt.*` broadcasts.
  registerEventBusService(hub)
  getBrokerEventBus(hub).subscribe({ category: '**' }, (event: SystemEvent) => {
    receivedEvents.push({ ...event })
  })
  for (const agent of agents.values()) {
    registerEventBusService(agent)
  }

  return {
    hub,
    agents,
    receivedEvents,
    registeredProviders,
    disconnectedProviders,
    async start() {
      await hub.start()
      for (const agent of agents.values()) await agent.start()
      // Wait for all agent nodes to appear in hub's registry
      for (const id of agentIds) {
        await waitUntil(() => getAvailableNodeIds(hub).includes(id))
      }
      // Wait for remote services to be discoverable
      for (const id of agentIds) {
        await waitUntil(() => hasRemoteServices(hub, id))
      }
    },
    async stop() {
      for (const agent of agents.values()) {
        try {
          await agent.stop()
        } catch {
          /* already stopped */
        }
      }
      await hub.stop()
    },
  }
}

export { createTestCluster, waitUntil, getAvailableNodeIds }
export type { TestCluster }
