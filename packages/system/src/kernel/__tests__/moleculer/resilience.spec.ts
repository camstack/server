/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- test file, mock typing */
import { describe, it, expect, afterEach } from 'vitest'
import { ServiceBroker } from 'moleculer'
import {
  createTestCluster,
  waitUntil,
  getAvailableNodeIds,
  type TestCluster,
} from './cluster-setup.js'

function actionIsAvailable(broker: any, actionName: string): boolean {
  return broker.registry.actions.isAvailable(actionName)
}

/** Register a node's manifest with the hub via $hub.registerNode. */
async function registerNode(
  agent: ServiceBroker,
  nodeId: string,
  addonId: string,
  capabilities: readonly string[],
): Promise<void> {
  await agent.call('$hub.registerNode', {
    nodeId,
    addons: [{ addonId, capabilities }],
  })
}

describe('Resilience', () => {
  let cluster: TestCluster
  const extraBrokers: ServiceBroker[] = []
  afterEach(async () => {
    for (const b of extraBrokers) {
      try {
        await b.stop()
      } catch {
        /* already stopped */
      }
    }
    extraBrokers.length = 0
    if (cluster) await cluster.stop()
  })

  it('hub detects agent disconnection after $hub.unregisterNode (D3)', async () => {
    cluster = createTestCluster(['agent-gpu'])
    cluster.agents.get('agent-gpu')!.createService({
      name: 'test-addon',
      metadata: { addonId: 'test-addon', capabilities: [{ name: 'test-cap' }] },
      actions: {},
    })
    await cluster.start()
    // D3: send handshake so hub knows about this node's caps.
    await registerNode(cluster.agents.get('agent-gpu')!, 'agent-gpu', 'test-addon', ['test-cap'])
    await waitUntil(() => cluster.registeredProviders.length > 0)
    expect(cluster.registeredProviders.length).toBeGreaterThan(0)
    // Graceful unregister (simulates shutdown path).
    await cluster.agents.get('agent-gpu')!.call('$hub.unregisterNode', { nodeId: 'agent-gpu' })
    await waitUntil(() => cluster.disconnectedProviders.length > 0)
    expect(cluster.disconnectedProviders.length).toBeGreaterThan(0)
  })

  it('agent reconnect restores services after re-handshake (D3)', async () => {
    cluster = createTestCluster(['agent-gpu'])
    cluster.agents.get('agent-gpu')!.createService({
      name: 'detection-pipeline',
      metadata: {
        addonId: 'detection-pipeline',
        capabilities: [{ name: 'detector', methods: ['detect'] }],
      },
      actions: { 'detector.detect': { handler: () => ({ ok: true }) } },
    })
    await cluster.start()
    // D3: initial handshake.
    await registerNode(cluster.agents.get('agent-gpu')!, 'agent-gpu', 'detection-pipeline', [
      'detector',
    ])
    await waitUntil(() => cluster.registeredProviders.length > 0)
    const initialCount = cluster.registeredProviders.length

    // Disconnect: explicit unregister.
    await cluster.agents.get('agent-gpu')!.call('$hub.unregisterNode', { nodeId: 'agent-gpu' })
    await waitUntil(() => cluster.disconnectedProviders.length > 0)

    // Simulate restart with new broker.
    const newAgent = new ServiceBroker({ nodeID: 'agent-gpu', transporter: 'Fake', logger: false })
    extraBrokers.push(newAgent)
    newAgent.createService({
      name: 'detection-pipeline',
      metadata: {
        addonId: 'detection-pipeline',
        capabilities: [{ name: 'detector', methods: ['detect'] }],
      },
      actions: { 'detector.detect': { handler: () => ({ ok: true }) } },
    })
    await newAgent.start()
    await waitUntil(() => getAvailableNodeIds(cluster.hub).includes('agent-gpu'))
    // D3: new agent re-registers.
    await registerNode(newAgent, 'agent-gpu', 'detection-pipeline', ['detector'])
    await waitUntil(() => cluster.registeredProviders.length > initialCount)
    expect(cluster.registeredProviders.length).toBeGreaterThan(initialCount)
  })

  it('action call to offline agent throws', async () => {
    cluster = createTestCluster(['agent-gpu'])
    cluster.agents.get('agent-gpu')!.createService({
      name: 'test-addon',
      metadata: { addonId: 'test-addon', capabilities: [{ name: 'test', methods: ['run'] }] },
      actions: { 'test.run': { handler: () => 'ok' } },
    })
    await cluster.start()
    await waitUntil(() => actionIsAvailable(cluster.hub, 'test-addon.test.run'), 5000)
    const result = await cluster.hub.call('test-addon.test.run')
    expect(result).toBe('ok')

    await cluster.agents.get('agent-gpu')!.stop()
    await waitUntil(() => !getAvailableNodeIds(cluster.hub).includes('agent-gpu'))

    await expect(cluster.hub.call('test-addon.test.run', {}, { timeout: 1000 })).rejects.toThrow()
  })
})
