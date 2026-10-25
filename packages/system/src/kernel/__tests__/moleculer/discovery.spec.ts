import { describe, it, expect, afterEach } from 'vitest'
import {
  createTestCluster,
  waitUntil,
  getAvailableNodeIds,
  type TestCluster,
} from './cluster-setup.js'

describe('Discovery and lifecycle', () => {
  let cluster: TestCluster
  afterEach(async () => {
    if (cluster) await cluster.stop()
  })

  it('hub sees agents after start', async () => {
    cluster = createTestCluster(['agent-decoder', 'agent-gpu'])
    await cluster.start()
    const nodeIds = getAvailableNodeIds(cluster.hub)
    expect(nodeIds).toContain('agent-decoder')
    expect(nodeIds).toContain('agent-gpu')
  })

  it('hub detects agent offline after stop', async () => {
    cluster = createTestCluster(['agent-decoder', 'agent-gpu'])
    await cluster.start()
    await cluster.agents.get('agent-decoder')!.stop()
    await waitUntil(() => !getAvailableNodeIds(cluster.hub).includes('agent-decoder'))
    const nodeIds = getAvailableNodeIds(cluster.hub)
    expect(nodeIds).not.toContain('agent-decoder')
    expect(nodeIds).toContain('agent-gpu')
  })

  it('registers remote providers via $hub.registerNode handshake (D3)', async () => {
    cluster = createTestCluster(['agent-gpu'])
    cluster.agents.get('agent-gpu')!.createService({
      name: 'detection-pipeline',
      metadata: {
        addonId: 'detection-pipeline',
        capabilities: [{ name: 'detector', methods: ['detect'] }],
      },
      actions: { 'detector.detect': { handler: () => ({ found: true }) } },
    })
    await cluster.start()
    // D3: agent explicitly registers its manifest with the hub.
    await cluster.agents.get('agent-gpu')!.call('$hub.registerNode', {
      nodeId: 'agent-gpu',
      addons: [{ addonId: 'detection-pipeline', capabilities: ['detector'] }],
    })
    await waitUntil(() => cluster.registeredProviders.length > 0)
    expect(cluster.registeredProviders).toContainEqual({
      capName: 'detector',
      addonId: 'detection-pipeline',
      nodeId: 'agent-gpu',
    })
  })

  it('unregisters providers when agent calls $hub.unregisterNode (D3)', async () => {
    cluster = createTestCluster(['agent-gpu'])
    cluster.agents.get('agent-gpu')!.createService({
      name: 'my-addon',
      metadata: { addonId: 'my-addon', capabilities: [{ name: 'metrics-provider' }] },
      actions: {},
    })
    await cluster.start()
    // D3: register first
    await cluster.agents.get('agent-gpu')!.call('$hub.registerNode', {
      nodeId: 'agent-gpu',
      addons: [{ addonId: 'my-addon', capabilities: ['metrics-provider'] }],
    })
    await waitUntil(() => cluster.registeredProviders.length > 0)
    // D3: explicit unregister on graceful shutdown
    await cluster.agents.get('agent-gpu')!.call('$hub.unregisterNode', { nodeId: 'agent-gpu' })
    await waitUntil(() => cluster.disconnectedProviders.length > 0)
    expect(cluster.disconnectedProviders.some((u) => u.addonId === 'my-addon')).toBe(true)
  })
})
