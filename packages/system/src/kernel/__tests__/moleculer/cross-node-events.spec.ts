/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- test file, mock typing */
import { describe, it, expect, afterEach } from 'vitest'
import { createAddonContext, clusterEventTopic } from '../../moleculer/addon-context-factory.js'
import { createTestCluster, waitUntil, type TestCluster } from './cluster-setup.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { EventCategory, type AddonDeclaration } from '@camstack/types'

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cross-node-${label}-`))
}

describe('Cross-node event flow (agent -> hub only)', () => {
  let cluster: TestCluster
  const tmpDirs: string[] = []
  afterEach(async () => {
    if (cluster) await cluster.stop()
    for (const d of tmpDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true })
      } catch {
        /* swallow */
      }
    }
    tmpDirs.length = 0
  })

  it('agent event reaches hub via camstack.evt.* broadcast', async () => {
    cluster = createTestCluster(['agent-gpu'])
    await cluster.start()

    // `ctx.eventBus.emit` is the real production path — it broadcasts
    // `camstack.evt.<category>`, the hub's `$event-bus` service picks it
    // up, and the wildcard subscriber installed by `createTestCluster`
    // populates `cluster.receivedEvents` for assertion.
    const dir = tmpDir('agent-gpu')
    tmpDirs.push(dir)
    const declaration: AddonDeclaration = { id: 'detection-pipeline', entry: './index.js' }
    const ctx = await createAddonContext(cluster.agents.get('agent-gpu')!, declaration, dir)

    ctx.eventBus.emit({
      id: 'evt-1',
      timestamp: new Date(),
      source: { type: 'addon', id: 'detection-pipeline' },
      category: EventCategory.DetectionResult,
      data: { deviceId: 'cam1', count: 5 },
    })

    await waitUntil(() => cluster.receivedEvents.length >= 1)
    expect(cluster.receivedEvents).toHaveLength(1)
    expect(cluster.receivedEvents[0]!.category).toBe('detection.result')
  })

  it('hub can read addon config from agent context', async () => {
    cluster = createTestCluster(['agent-gpu'])
    await cluster.start()
    const config = await cluster.agents
      .get('agent-gpu')!
      .call('$hub.getAddonConfig', { addonId: 'detection-pipeline' })
    expect(config).toEqual({ addonId: 'detection-pipeline' })
  })

  it('detection pipeline on agent sends result to hub', async () => {
    cluster = createTestCluster(['agent-gpu'])
    cluster.agents.get('agent-gpu')!.createService({
      name: 'detection-pipeline',
      metadata: {
        addonId: 'detection-pipeline',
        capabilities: [{ name: 'detector', methods: ['detect'] }],
      },
      actions: {
        'detector.detect': {
          async handler(ctx: any) {
            // Emulate a detection addon publishing a result event. The
            // transport is one Moleculer event per category —
            // `broker.broadcast('camstack.evt.<category>', ...)`. Use it
            // directly here — this mirrors what `createBrokerEventBus`
            // does on behalf of addon code.
            ctx.broker.broadcast(clusterEventTopic(EventCategory.DetectionResult), {
              id: 'det-1',
              timestamp: new Date(),
              source: { type: 'addon', id: 'detection-pipeline' },
              category: EventCategory.DetectionResult,
              data: { detections: ['person', 'car'] },
              sourceNodeId: ctx.broker.nodeID,
              sourceAddonId: 'detection-pipeline',
            })
            return { detections: ['person', 'car'] }
          },
        },
      },
    })
    await cluster.start()
    // Wait for remote action to be available on hub
    await waitUntil(
      () => (cluster.hub as any).registry.actions.isAvailable('detection-pipeline.detector.detect'),
      5000,
    )
    const result = (await cluster.hub.call('detection-pipeline.detector.detect', {
      frame: 'base64data',
    })) as Record<string, unknown>
    expect(result.detections).toEqual(['person', 'car'])

    await waitUntil(() => cluster.receivedEvents.length >= 1)
    expect(cluster.receivedEvents).toHaveLength(1)
  })
})
