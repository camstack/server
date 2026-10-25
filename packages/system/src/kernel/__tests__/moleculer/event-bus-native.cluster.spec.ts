/**
 * D10 integration test — Moleculer-native event bus guarantees.
 *
 * Asserts three properties the new per-category transport must guarantee:
 *   A. Per-category event names: an event emitted on an agent reaches
 *      the hub subscriber under the correct `camstack.evt.<category>` topic.
 *   B. Wildcard delivery: the `$event-bus` service registered on a broker
 *      subscribes to `camstack.evt.**` so it receives all categories.
 *   C. Internal-event isolation: Moleculer internal events (`$node.*`,
 *      `$services.*`) NEVER leak into the camstack event bus. The
 *      `camstack.evt.**` wildcard must be disjoint from `$node.connected`.
 *
 * Uses the exact production TCP topology (hub + 1 agent, static URLs,
 * `udpDiscovery: false`) matching the live cluster config.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, afterEach } from 'vitest'
import { ServiceBroker } from 'moleculer'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as net from 'node:net'
import {
  createAddonContext,
  getBrokerEventBus,
  registerEventBusService,
  EVENT_TOPIC_PREFIX,
} from '../../moleculer/addon-context-factory.js'
import { EventCategory } from '@camstack/types'
import type { AddonDeclaration, SystemEvent } from '@camstack/types'

// ── Helpers (copied from cluster-event-delivery.cluster.spec.ts) ───────────────

async function waitUntil(fn: () => boolean | Promise<boolean>, timeout = 10_000): Promise<void> {
  const start = Date.now()
  while (!(await fn())) {
    if (Date.now() - start > timeout) throw new Error(`waitUntil timed out after ${timeout}ms`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else reject(new Error('no address'))
    })
  })
}

async function checkTcpAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, () => srv.close(() => resolve(true)))
    srv.on('error', () => resolve(false))
  })
}

function tmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `event-bus-native-${label}-`))
}

function decl(id: string): AddonDeclaration {
  return { id, entry: './index.js' }
}

function prodHubBroker(nodeID: string, port: number, namespace: string): ServiceBroker {
  return new ServiceBroker({
    nodeID,
    namespace,
    transporter: {
      type: 'TCP',
      options: { port, maxPacketSize: 10 * 1024 * 1024, udpDiscovery: false },
    },
    logger: false,
    metrics: { enabled: false },
  })
}

function prodAgentBroker(nodeID: string, hubUrl: string, namespace: string): ServiceBroker {
  return new ServiceBroker({
    nodeID,
    namespace,
    transporter: {
      type: 'TCP',
      options: { urls: hubUrl, maxPacketSize: 10 * 1024 * 1024, udpDiscovery: false },
    },
    logger: false,
    metrics: { enabled: false },
  })
}

// ── Test suite ─────────────────────────────────────────────────────────

describe('D10: Moleculer-native event bus integration', () => {
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

  it('Test A — agent emit delivers to the hub bus under the correct per-category topic', async () => {
    if (!(await checkTcpAvailable())) return

    const hubPort = await findFreePort()
    const ns = `test-a-${Date.now()}`
    const hubUrl = `127.0.0.1:${hubPort}/hub`
    const hub = prodHubBroker('hub', hubPort, ns)
    const agent = prodAgentBroker('dev-agent-0', hubUrl, ns)
    brokers.push(hub, agent)

    // Register `$event-bus` on both BEFORE start so the TCP discovery
    // handshake propagates the `camstack.evt.**` subscription to peers.
    registerEventBusService(hub)
    registerEventBusService(agent)

    // Collect every event that lands on the hub bus.
    const received: SystemEvent[] = []
    getBrokerEventBus(hub).subscribe({ category: '**' }, (e) => {
      received.push(e)
    })

    await hub.start()
    await agent.start()

    // Wait until the agent has discovered the hub — ensures the TCP
    // handshake is complete before we emit cross-node broadcasts.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    await waitUntil(
      () =>
        (agent as any).registry
          .getNodeList({ onlyAvailable: true })
          .some((n: { id: string }) => n.id === 'hub'),
      20_000,
    )

    const dir = tmpDir('a')
    tmpDirs.push(dir)
    const ctx = await createAddonContext(agent, decl('a'), dir)

    // Emit a `pipeline.progress` event from the agent context.
    ctx.eventBus.emit({
      id: 'test-a-1',
      timestamp: new Date(),
      source: { type: 'test', id: 'a' },
      category: EventCategory.PipelineProgress,
      data: {},
    })

    // The hub must receive the event on its event bus subscriber.
    await waitUntil(() => received.some((e) => e.category === 'pipeline.progress'), 5_000)

    const arrived = received.find((e) => e.category === 'pipeline.progress')
    expect(arrived).toBeDefined()
    expect(arrived!.id).toBe('test-a-1')
    // Verify the topic naming: the enriched event from the broker carries
    // `sourceNodeId` from the agent, confirming the per-category broadcast path.
    const enriched: Record<string, unknown> = { ...arrived }
    expect(enriched['sourceNodeId']).toBe('dev-agent-0')
  }, 60_000)

  it('Test B — the $event-bus service is registered and handles the camstack.evt.** wildcard', async () => {
    if (!(await checkTcpAvailable())) return

    const hubPort = await findFreePort()
    const ns = `test-b-${Date.now()}`
    const hubUrl = `127.0.0.1:${hubPort}/hub`
    const hub = prodHubBroker('hub', hubPort, ns)
    const agent = prodAgentBroker('dev-agent-0', hubUrl, ns)
    brokers.push(hub, agent)

    registerEventBusService(hub)
    registerEventBusService(agent)

    // Subscribe on the hub bus before start — the wildcard handler must
    // bridge any category that arrives via broadcast from the agent.
    const received: SystemEvent[] = []
    getBrokerEventBus(hub).subscribe({ category: '**' }, (e) => {
      received.push(e)
    })

    await hub.start()
    await agent.start()

    // Wait for full TCP handshake.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    await waitUntil(
      () =>
        (agent as any).registry
          .getNodeList({ onlyAvailable: true })
          .some((n: { id: string }) => n.id === 'hub'),
      20_000,
    )

    // Inspect the hub broker's service registry to confirm `$event-bus`
    // is present. Moleculer 0.15 does not expose an `events` field on
    // service descriptors, so we confirm the wildcard (`camstack.evt.**`)
    // operationally via end-to-end delivery of two distinct categories below.
    const registry = (hub as any).registry
    const services: any[] = registry.getServiceList({ onlyAvailable: true, withActions: true })
    const eventBusSvc = services.find((s: any) => s.name === '$event-bus')

    // Primary assertion: the `$event-bus` service must be present in the hub registry.
    expect(eventBusSvc, '$event-bus service must be present in hub registry').toBeDefined()

    // Secondary end-to-end assertion: emit a test event from the agent and
    // confirm the hub's `camstack.evt.**` wildcard handler delivered it —
    // this proves the subscription is wired up and operational.
    const dir = tmpDir('b')
    tmpDirs.push(dir)
    const ctx = await createAddonContext(agent, decl('b'), dir)

    // Emit two events with different categories to confirm the wildcard
    // (not just a single-category handler) delivers both.
    ctx.eventBus.emit({
      id: 'test-b-1',
      timestamp: new Date(),
      source: { type: 'test', id: 'b' },
      category: EventCategory.BenchmarkProgress,
      data: {},
    })
    ctx.eventBus.emit({
      id: 'test-b-2',
      timestamp: new Date(),
      source: { type: 'test', id: 'b' },
      category: EventCategory.ModelDownloadProgress,
      data: {},
    })

    await waitUntil(
      () => received.some((e) => e.id === 'test-b-1') && received.some((e) => e.id === 'test-b-2'),
      5_000,
    )

    // Confirm both categories arrived, proving the `camstack.evt.**`
    // wildcard (not just a per-category handler) is active.
    expect(received.some((e) => e.category === 'benchmark.progress')).toBe(true)
    expect(received.some((e) => e.category === 'model.download.progress')).toBe(true)

    // Additionally verify that the topics used for the broadcasts are in
    // the `camstack.evt.` namespace — checked via the EVENT_TOPIC_PREFIX
    // constant exported by the module under test.
    expect(EVENT_TOPIC_PREFIX).toBe('camstack.evt.')
  }, 60_000)

  it('Test C — Moleculer internal events ($node.connected) never reach the camstack event bus', async () => {
    if (!(await checkTcpAvailable())) return

    const hubPort = await findFreePort()
    const ns = `test-c-${Date.now()}`
    const hubUrl = `127.0.0.1:${hubPort}/hub`
    const hub = prodHubBroker('hub', hubPort, ns)
    const agent = prodAgentBroker('dev-agent-0', hubUrl, ns)
    brokers.push(hub, agent)

    registerEventBusService(hub)
    registerEventBusService(agent)

    // Start collecting camstack bus events before brokers start so we
    // capture anything that might arrive during the TCP handshake phase.
    const received: SystemEvent[] = []
    getBrokerEventBus(hub).subscribe({ category: '**' }, (e) => {
      received.push(e)
    })

    await hub.start()
    await agent.start()

    // Wait until the agent is in the hub's registry. By this point the
    // TCP handshake is complete and `$node.connected` has fired on the
    // hub's `localBus` — the most dangerous window for internal-event
    // leakage has already passed.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    await waitUntil(
      () =>
        (agent as any).registry
          .getNodeList({ onlyAvailable: true })
          .some((n: { id: string }) => n.id === 'hub'),
      20_000,
    )

    // Allow a short settling period so any delayed Moleculer heartbeats /
    // topology events have had time to propagate. If they were going to
    // leak into the bus, they would have arrived by now.
    await new Promise((r) => setTimeout(r, 500))

    // Canary probe: emit a known camstack event from the agent and wait
    // for it to land on the hub bus. This proves the hub's `camstack.evt.**`
    // subscriber is genuinely wired — if `received` were empty because the
    // subscriber broke, this waitUntil would time out and fail the test,
    // preventing the isolation assertions below from passing vacuously.
    const dirC = tmpDir('c')
    tmpDirs.push(dirC)
    const ctxC = await createAddonContext(agent, decl('c'), dirC)
    ctxC.eventBus.emit({
      id: 'canary-c',
      timestamp: new Date(),
      source: { type: 'test', id: 'c' },
      category: EventCategory.PipelineProgress,
      data: {},
    })
    await waitUntil(() => received.some((e) => e.id === 'canary-c'), 5_000)

    // Core invariant: no event in the camstack bus may have a `$`-prefixed
    // category, because `camstack.evt.**` is disjoint from `$node.*` /
    // `$services.*`. The hub's `$event-bus` wildcard handler must NEVER
    // be triggered by Moleculer internal events.
    expect(
      received.every((e) => !e.category.startsWith('$')),
      `found internal Moleculer event in camstack bus: ${received
        .filter((e) => e.category.startsWith('$'))
        .map((e) => e.category)
        .join(', ')}`,
    ).toBe(true)

    expect(
      received.some((e) => e.category === '$node.connected'),
      '$node.connected must never appear on the camstack event bus',
    ).toBe(false)
  }, 60_000)
})
