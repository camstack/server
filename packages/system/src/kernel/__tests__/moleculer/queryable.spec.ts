/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- test file, mock typing */
import { describe, it, expect, afterEach } from 'vitest'
import { createTestCluster, waitUntil, type TestCluster } from './cluster-setup.js'

function actionIsAvailable(broker: any, actionName: string): boolean {
  return broker.registry.actions.isAvailable(actionName)
}

describe('IQueryable', () => {
  let cluster: TestCluster
  afterEach(async () => {
    if (cluster) await cluster.stop()
  })

  it('addon exposes query catalog', async () => {
    cluster = createTestCluster(['agent-gpu'])
    cluster.agents.get('agent-gpu')!.createService({
      name: 'docker-monitor',
      metadata: {
        addonId: 'docker-monitor',
        capabilities: [{ name: 'queryable', methods: ['getQueryCatalog', 'query'] }],
      },
      actions: {
        'queryable.getQueryCatalog': {
          handler: () => [{ name: 'containers.list', description: 'List Docker containers' }],
        },
        'queryable.query': {
          handler: (ctx: any) => {
            if (ctx.params.name === 'containers.list')
              return [{ id: 'abc', name: 'nginx', status: 'running' }]
            throw new Error(`Unknown query: ${ctx.params.name}`)
          },
        },
      },
    })
    await cluster.start()
    await waitUntil(
      () => actionIsAvailable(cluster.hub, 'docker-monitor.queryable.getQueryCatalog'),
      5000,
    )
    const catalog = (await cluster.hub.call(
      'docker-monitor.queryable.getQueryCatalog',
      {},
      { nodeID: 'agent-gpu' },
    )) as unknown[]
    expect(catalog).toHaveLength(1)
  })

  it('hub can execute query on remote addon', async () => {
    cluster = createTestCluster(['agent-gpu'])
    cluster.agents.get('agent-gpu')!.createService({
      name: 'docker-monitor',
      metadata: {
        addonId: 'docker-monitor',
        capabilities: [{ name: 'queryable', methods: ['query'] }],
      },
      actions: {
        'queryable.query': {
          handler: (ctx: any) => {
            if (ctx.params.name === 'containers.list') return [{ id: 'abc', name: 'nginx' }]
            throw new Error(`Unknown query: ${ctx.params.name}`)
          },
        },
      },
    })
    await cluster.start()
    await waitUntil(() => actionIsAvailable(cluster.hub, 'docker-monitor.queryable.query'), 5000)
    const result = (await cluster.hub.call(
      'docker-monitor.queryable.query',
      { name: 'containers.list' },
      { nodeID: 'agent-gpu' },
    )) as unknown[]
    expect(result).toHaveLength(1)
  })

  it('unknown query throws error', async () => {
    cluster = createTestCluster(['agent-gpu'])
    cluster.agents.get('agent-gpu')!.createService({
      name: 'docker-monitor',
      metadata: {
        addonId: 'docker-monitor',
        capabilities: [{ name: 'queryable', methods: ['query'] }],
      },
      actions: {
        'queryable.query': {
          handler: (ctx: any) => {
            throw new Error(`Unknown query: ${ctx.params.name}`)
          },
        },
      },
    })
    await cluster.start()
    await waitUntil(() => actionIsAvailable(cluster.hub, 'docker-monitor.queryable.query'), 5000)
    await expect(
      cluster.hub.call(
        'docker-monitor.queryable.query',
        { name: 'invalid' },
        { nodeID: 'agent-gpu' },
      ),
    ).rejects.toThrow('Unknown query: invalid')
  })
})
