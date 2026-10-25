/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- test file, mock typing */
import { describe, it, expect, afterEach } from 'vitest'
import { createTestCluster, waitUntil, type TestCluster } from './cluster-setup.js'

function createMetricsService(nodeLabel: string) {
  return {
    name: 'metrics-glances',
    metadata: {
      addonId: 'metrics-glances',
      capabilities: [{ name: 'metrics-provider', methods: ['getMetrics'] }],
    },
    actions: {
      'metrics-provider.getMetrics': {
        handler: () => ({ nodeLabel, cpu: 42.5, memoryMB: 8192 }),
      },
    },
  }
}

describe('Distributed metrics', () => {
  let cluster: TestCluster
  afterEach(async () => {
    if (cluster) await cluster.stop()
  })

  it('hub can target specific node for metrics', async () => {
    cluster = createTestCluster(['agent-decoder', 'agent-gpu'])
    cluster.agents.get('agent-decoder')!.createService(createMetricsService('decoder'))
    cluster.agents.get('agent-gpu')!.createService(createMetricsService('gpu'))
    await cluster.start()

    const actionName = 'metrics-glances.metrics-provider.getMetrics'
    await waitUntil(() => (cluster.hub as any).registry.actions.isAvailable(actionName), 5000)

    const gpuMetrics = (await cluster.hub.call(actionName, {}, { nodeID: 'agent-gpu' })) as Record<
      string,
      unknown
    >
    expect(gpuMetrics.nodeLabel).toBe('gpu')

    const decoderMetrics = (await cluster.hub.call(
      actionName,
      {},
      { nodeID: 'agent-decoder' },
    )) as Record<string, unknown>
    expect(decoderMetrics.nodeLabel).toBe('decoder')
  })
})
