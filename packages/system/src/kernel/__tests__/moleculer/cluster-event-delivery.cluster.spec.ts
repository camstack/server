/**
 * Cluster event delivery — full production path, per-node diagnostics.
 *
 * Reproduces the exact production topology (hub + 2 agents, TCP transport,
 * `udpDiscovery: false` with static URLs) and validates every hop of the
 * event pipeline that admin-ui depends on for benchmark progress, model
 * download progress, alerts, and detection events.
 *
 * The transport contract:
 *   `ctx.eventBus.emit(event)` → `broker.broadcast('camstack.evt.<category>', event)`
 *   → hub `$event-bus` service wildcard handler → shared bus subscriber.
 *
 * Layers tested per node:
 *   1. createBrokerEventBus(broker).emit(event) — the `ctx.eventBus`
 *      implementation every addon uses (the real production path).
 *   2. matrix report: (source node × category) → delivered?
 *   3. `$node.connected` fires on hub for remote agents.
 *
 * The diagnostic exists because bench testing with Fake transporter
 * (smart-api-routing.spec, cross-node-events.spec) can miss issues that
 * only surface with TCP + static URLs. These specs validate the exact
 * config the live dev.sh cluster uses.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { describe, it, expect, afterEach } from 'vitest'
import { ServiceBroker } from 'moleculer'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as net from 'node:net'
import { createHubService } from '../../moleculer/hub-service.js'
import {
  createAddonContext,
  getBrokerEventBus,
  registerEventBusService,
} from '../../moleculer/addon-context-factory.js'
import type { AddonDeclaration, SystemEvent } from '@camstack/types'

// ── Helpers ────────────────────────────────────────────────────────────

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
  return fs.mkdtempSync(path.join(os.tmpdir(), `cluster-events-${label}-`))
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

describe('Cluster event delivery — production TCP topology (hub + 2 agents)', () => {
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

  // Former "layer 1" (direct `broker.call('$hub.event')`) removed — the
  // action no longer exists. Cross-node emits flow exclusively through
  // `broker.broadcast('camstack.evt.<category>', ...)` → `$event-bus` now.

  it('layer 2: ctx.eventBus.emit from each agent (via createBrokerEventBus) reaches hub $event-bus subscriber', async () => {
    if (!(await checkTcpAvailable())) return

    const hubPort = await findFreePort()
    const ns = `test-bus-${Date.now()}`
    // Moleculer TCP expects `host:port/nodeID`, NOT `nodeID@host:port`. The
    // session notes spelled this out explicitly after prior confusion —
    // see broker-factory.normalizeHubUrl which is the only function that
    // produces this format in prod. Keep the format identical here.
    const hubUrl = `127.0.0.1:${hubPort}/hub`
    const hub = prodHubBroker('hub', hubPort, ns)
    const agentA = prodAgentBroker('dev-agent-0', hubUrl, ns)
    const agentB = prodAgentBroker('dev-agent-1', hubUrl, ns)
    brokers.push(hub, agentA, agentB)

    hub.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: () => ({}),
        getRecentEvents: () => [],
        onLog: () => {},
      }),
    )

    // `$event-bus` must be registered before `broker.start()` so the
    // Moleculer discovery handshake propagates the `camstack.evt.**`
    // subscription. The hub subscriber captures every event that lands
    // here — the per-category transport replacing the removed
    // `$hub.event` action.
    registerEventBusService(hub)
    registerEventBusService(agentA)
    registerEventBusService(agentB)

    const received: SystemEvent[] = []
    getBrokerEventBus(hub).subscribe({ category: '**' }, (event) => {
      received.push(event)
    })

    await hub.start()
    await agentA.start()
    await agentB.start()
    // Sanity-check node visibility — cross-broker broadcasts depend on the
    // transport having completed its handshake before emits fly.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    await waitUntil(
      () =>
        (agentA as any).registry
          .getNodeList({ onlyAvailable: true })
          .some((n: { id: string }) => n.id === 'hub'),
      20_000,
    )
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    await waitUntil(
      () =>
        (agentB as any).registry
          .getNodeList({ onlyAvailable: true })
          .some((n: { id: string }) => n.id === 'hub'),
      20_000,
    )

    const dirA = tmpDir('a')
    tmpDirs.push(dirA)
    const dirB = tmpDir('b')
    tmpDirs.push(dirB)
    const ctxA = await createAddonContext(agentA, decl('test-a'), dirA)
    const ctxB = await createAddonContext(agentB, decl('test-b'), dirB)

    const mk = (id: string, category: string, nodeId: string): SystemEvent => ({
      id,
      timestamp: new Date(),
      source: { type: 'pipeline', id: 'pipeline-test' },
      category,
      data: { nodeId, sessionId: `run-${nodeId}-1`, step: '-', message: `hello from ${nodeId}` },
    })

    // Emit from each agent via the real `ctx.eventBus.emit` (brokerEventBus).
    ctxA.eventBus.emit(mk('bus-a-1', 'pipeline.progress', 'dev-agent-0'))
    ctxA.eventBus.emit(mk('bus-a-2', 'benchmark.progress', 'dev-agent-0'))
    ctxB.eventBus.emit(mk('bus-b-1', 'pipeline.progress', 'dev-agent-1'))

    await waitUntil(() => received.length >= 3, 5_000)

    const bySource = new Map<string, Set<string>>()
    for (const e of received) {
      // `sourceNodeId` is attached by `createBrokerEventBus` as an enriched
      // field on the emitted event — not part of the base `SystemEvent`
      // contract, so we read it off a spread snapshot.
      const enriched: Record<string, unknown> = { ...e }
      const src = String(enriched['sourceNodeId'] ?? '(none)')
      const cat = e.category
      if (!bySource.has(src)) bySource.set(src, new Set())
      bySource.get(src)!.add(cat)
    }

    expect(bySource.get('dev-agent-0')?.size).toBe(2)
    expect(bySource.get('dev-agent-0')?.has('pipeline.progress')).toBe(true)
    expect(bySource.get('dev-agent-0')?.has('benchmark.progress')).toBe(true)
    expect(bySource.get('dev-agent-1')?.has('pipeline.progress')).toBe(true)
  }, 60_000)

  it('layer 3: matrix — emit every admin-UI-consumed category from every node, assert hub sees them all', async () => {
    if (!(await checkTcpAvailable())) return

    const hubPort = await findFreePort()
    const ns = `test-matrix-${Date.now()}`
    // Moleculer TCP expects `host:port/nodeID`, NOT `nodeID@host:port`. The
    // session notes spelled this out explicitly after prior confusion —
    // see broker-factory.normalizeHubUrl which is the only function that
    // produces this format in prod. Keep the format identical here.
    const hubUrl = `127.0.0.1:${hubPort}/hub`
    const hub = prodHubBroker('hub', hubPort, ns)
    const agentA = prodAgentBroker('dev-agent-0', hubUrl, ns)
    const agentB = prodAgentBroker('dev-agent-1', hubUrl, ns)
    brokers.push(hub, agentA, agentB)

    hub.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: () => ({}),
        getRecentEvents: () => [],
        onLog: () => {},
      }),
    )

    // Register `$event-bus` on every broker before start so Moleculer
    // advertises the `camstack.evt.**` subscription during the TCP
    // discovery handshake.
    registerEventBusService(hub)
    registerEventBusService(agentA)
    registerEventBusService(agentB)

    const received: SystemEvent[] = []
    getBrokerEventBus(hub).subscribe({ category: '**' }, (event) => {
      received.push(event)
    })

    await hub.start()
    await agentA.start()
    await agentB.start()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    await waitUntil(
      () =>
        (agentA as any).registry
          .getNodeList({ onlyAvailable: true })
          .some((n: { id: string }) => n.id === 'hub'),
      20_000,
    )
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    await waitUntil(
      () =>
        (agentB as any).registry
          .getNodeList({ onlyAvailable: true })
          .some((n: { id: string }) => n.id === 'hub'),
      20_000,
    )

    // Hub's local ctx — same in-process broadcast path used by real hub-side
    // addons. The dispatcher still sees hub-emitted events because local
    // handlers fire synchronously on emit (see `createBrokerEventBus`).
    const dirHub = tmpDir('hub')
    tmpDirs.push(dirHub)
    const ctxHub = await createAddonContext(hub, decl('hub-addon'), dirHub)
    const dirA = tmpDir('a')
    tmpDirs.push(dirA)
    const dirB = tmpDir('b')
    tmpDirs.push(dirB)
    const ctxA = await createAddonContext(agentA, decl('agent-a-addon'), dirA)
    const ctxB = await createAddonContext(agentB, decl('agent-b-addon'), dirB)

    // Every category the admin UI subscribes to today — one emit per (node × category).
    const categories = [
      'pipeline.progress',
      'benchmark.progress',
      'model.download.progress',
      'detection.result',
      'detection.motion-analysis',
      'detection.motion-zones-raw',
      'pipeline.trace',
      'alert.created',
      'alert.updated',
    ]
    const nodes = [
      { ctx: ctxHub, nodeId: 'hub' },
      { ctx: ctxA, nodeId: 'dev-agent-0' },
      { ctx: ctxB, nodeId: 'dev-agent-1' },
    ]

    for (const { ctx, nodeId } of nodes) {
      for (const cat of categories) {
        ctx.eventBus.emit({
          id: `${nodeId}-${cat}`,
          timestamp: new Date(),
          source: { type: 'test', id: nodeId },
          category: cat,
          data: { nodeId, message: `${cat} from ${nodeId}` },
        })
      }
    }

    // Hub's own events dispatch locally only (cross-broker echo is skipped
    // in the dispatcher by `sourceNodeId === broker.nodeID`). The dispatcher
    // on the hub receives the local-emit path (same mechanism as on-node
    // handlers). So we expect one event per (nodeId × category).
    const expected = nodes.length * categories.length
    await waitUntil(() => received.length >= expected, 5_000)

    const matrix: Record<string, Record<string, boolean>> = {}
    for (const { nodeId } of nodes) {
      matrix[nodeId] = Object.fromEntries(categories.map((c) => [c, false]))
    }
    for (const e of received) {
      const enriched: Record<string, unknown> = { ...e }
      const src = String(enriched['sourceNodeId'] ?? '(none)')
      const cat = e.category
      if (matrix[src]?.[cat] !== undefined) matrix[src]![cat] = true
    }

    // Every (node × category) cell must be delivered.
    for (const { nodeId } of nodes) {
      for (const cat of categories) {
        expect(matrix[nodeId]?.[cat], `missing: ${nodeId} → ${cat}`).toBe(true)
      }
    }
  }, 60_000)

  it('layer 4: $node.connected fires on hub for remote agents (agent.online prerequisite)', async () => {
    if (!(await checkTcpAvailable())) return

    const hubPort = await findFreePort()
    const ns = `test-connected-${Date.now()}`
    // Moleculer TCP expects `host:port/nodeID`, NOT `nodeID@host:port`. The
    // session notes spelled this out explicitly after prior confusion —
    // see broker-factory.normalizeHubUrl which is the only function that
    // produces this format in prod. Keep the format identical here.
    const hubUrl = `127.0.0.1:${hubPort}/hub`
    const hub = prodHubBroker('hub', hubPort, ns)
    const agentA = prodAgentBroker('dev-agent-0', hubUrl, ns)
    brokers.push(hub, agentA)

    const connectedNodes: string[] = []
    hub.localBus.on('$node.connected', ({ node }: { node: { id: string } }) => {
      connectedNodes.push(node.id)
    })

    hub.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: () => ({}),
        getRecentEvents: () => [],
        onLog: () => {},
      }),
    )

    await hub.start()
    await agentA.start()

    // Agent must be visible on hub's registry AND fire `$node.connected`.
    await waitUntil(() => connectedNodes.includes('dev-agent-0'), 20_000)
    expect(connectedNodes).toContain('dev-agent-0')
  }, 60_000)
})
