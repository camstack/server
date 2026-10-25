/**
 * Verifies that `createAddonContext` exposes a SHARED
 * `ReadinessRegistry` via `ctx.kernel.readinessRegistry` — every addon
 * on the same broker should see the same instance so event-bus
 * subscriptions stay de-duplicated and the snapshot is consistent.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { ServiceBroker } from 'moleculer'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AddonDeclaration } from '@camstack/types'
import {
  createAddonContext,
  registerEventBusService,
} from '../../moleculer/addon-context-factory.js'

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `readiness-singleton-${label}-`))
}

function decl(id: string): AddonDeclaration {
  return { id, entry: './index.js' }
}

describe('ctx.kernel.readinessRegistry singleton', () => {
  const brokers: ServiceBroker[] = []
  const tmpDirs: string[] = []

  afterEach(async () => {
    for (const b of brokers) {
      try {
        await b.stop()
      } catch {
        /* already stopped */
      }
    }
    brokers.length = 0
    for (const d of tmpDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true })
      } catch {
        /* swallow */
      }
    }
    tmpDirs.length = 0
  })

  it('returns the same registry instance for every addon on the same broker', async () => {
    const broker = new ServiceBroker({
      nodeID: 'hub',
      namespace: 'singleton-test',
      transporter: null,
      logger: false,
      metrics: { enabled: false },
    })
    brokers.push(broker)
    registerEventBusService(broker)
    await broker.start()

    const d1 = tmpDir('a')
    tmpDirs.push(d1)
    const d2 = tmpDir('b')
    tmpDirs.push(d2)
    const ctxA = await createAddonContext(broker, decl('addon-a'), d1)
    const ctxB = await createAddonContext(broker, decl('addon-b'), d2)

    expect(ctxA.kernel.readinessRegistry).toBeDefined()
    expect(ctxB.kernel.readinessRegistry).toBeDefined()
    expect(ctxA.kernel.readinessRegistry).toBe(ctxB.kernel.readinessRegistry)
  })

  it('different brokers (same process) get independent registries', async () => {
    const broker1 = new ServiceBroker({
      nodeID: 'hub',
      namespace: 'ns-a',
      transporter: null,
      logger: false,
      metrics: { enabled: false },
    })
    const broker2 = new ServiceBroker({
      nodeID: 'agent',
      namespace: 'ns-b',
      transporter: null,
      logger: false,
      metrics: { enabled: false },
    })
    brokers.push(broker1, broker2)
    registerEventBusService(broker1)
    registerEventBusService(broker2)
    await broker1.start()
    await broker2.start()

    const d1 = tmpDir('1')
    tmpDirs.push(d1)
    const d2 = tmpDir('2')
    tmpDirs.push(d2)
    const ctx1 = await createAddonContext(broker1, decl('a1'), d1)
    const ctx2 = await createAddonContext(broker2, decl('a2'), d2)

    expect(ctx1.kernel.readinessRegistry).toBeDefined()
    expect(ctx2.kernel.readinessRegistry).toBeDefined()
    expect(ctx1.kernel.readinessRegistry).not.toBe(ctx2.kernel.readinessRegistry)
  })

  it('shared snapshot: one addon emit is observed via another addon subscription', async () => {
    const broker = new ServiceBroker({
      nodeID: 'hub',
      namespace: 'singleton-await',
      transporter: null,
      logger: false,
      metrics: { enabled: false },
    })
    brokers.push(broker)
    registerEventBusService(broker)
    await broker.start()

    const d1 = tmpDir('c')
    tmpDirs.push(d1)
    const ctxConsumer = await createAddonContext(broker, decl('consumer'), d1)

    const registry = ctxConsumer.kernel.readinessRegistry
    if (!registry) throw new Error('registry missing from context')

    // The registry listens to its own event bus; use the emitReadiness
    // helper on that same bus to stay transport-independent.
    const { emitReadiness } = await import('@camstack/types')
    emitReadiness(ctxConsumer.eventBus, {
      capName: 'fake-cap',
      scope: { type: 'node', nodeId: 'hub' },
      state: 'ready',
      generation: 'gen-producer-1',
      sourceNodeId: 'hub',
    })
    // Snapshot reflects the ready state after a microtask flush.
    await Promise.resolve()
    // 'fake-cap' is a synthetic name not in the generated cap-name union the
    // typed registry interface narrows to; the runtime keys on a plain string.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double: synthetic cap name
    const fakeCap = 'fake-cap' as unknown as Parameters<typeof registry.get>[0]
    const snap = registry.get(fakeCap, { type: 'node', nodeId: 'hub' })
    expect(snap?.state).toBe('ready')
    expect(snap?.epoch).toBe(1)
  })
})
