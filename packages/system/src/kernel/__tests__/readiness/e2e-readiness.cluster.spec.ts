/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
/**
 * E2E tests for the system-readiness protocol — §8.3 of the design
 * spec. Exercises the real distributed event-bus path (Moleculer TCP,
 * production namespace/topology) so every subscriber + producer hop
 * the admin-ui relies on is exercised end-to-end.
 *
 * Mirrors the shape of `cluster-event-delivery.cluster.spec.ts`: spins real
 * brokers, waits for action discovery, then drives readiness events
 * via `emitReadiness` (producer side) and `ReadinessRegistry`
 * (consumer side).
 *
 * Scenarios covered (numbering from the spec §8.3 E2E matrix):
 *   - E1  Consumer races producer at boot — awaitReady resolves
 *   - E4  Agent carrying multiple caps — each cap epoch tracked
 *         independently (same-node restart simulation).
 *   - E7  Timeout fires loud — awaitReady rejects with ReadinessTimeoutError
 *   - E8  Late consumer — resolves from snapshot immediately
 *   - E10 Multi-consumer, same producer — same epoch across subscribers
 *   - E12 Producer never initializes — timeout as expected
 *
 * Skipped for now (would need real process fork + kernel supervisor):
 *   - E3 forked child crash+respawn
 *   - E11 hub restart with persistent state
 *   - E14 rapid flap process-level
 *
 * Those are better tested via process-runner integration; the scenarios
 * above cover the wire-level protocol correctness.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, afterEach } from 'vitest'
import { ServiceBroker } from 'moleculer'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as net from 'node:net'
import { createHubService } from '../../moleculer/hub-service.js'
import {
  createAddonContext,
  registerEventBusService,
} from '../../moleculer/addon-context-factory.js'
import type { AddonDeclaration } from '@camstack/types'
import { ReadinessRegistry, ReadinessTimeoutError, emitReadiness } from '@camstack/types'

// ── Harness helpers (copied from cluster-event-delivery.cluster.spec.ts) ─────

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
  return fs.mkdtempSync(path.join(os.tmpdir(), `readiness-e2e-${label}-`))
}

function decl(id: string): AddonDeclaration {
  return { id, entry: './index.js' }
}

function actionIsAvailable(broker: ServiceBroker, name: string): boolean {
  const reg = (broker as any).registry
  return reg?.actions?.isAvailable?.(name) === true
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

// ── Test suite ───────────────────────────────────────────────────────

describe('Readiness E2E — real Moleculer TCP (hub + agent)', () => {
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

  it('E1 — consumer awaitReady resolves when producer emits (early consumer race)', async () => {
    if (!(await checkTcpAvailable())) return

    const hubPort = await findFreePort()
    const ns = `ready-e1-${Date.now()}`
    const hubUrl = `127.0.0.1:${hubPort}/hub`
    const hub = prodHubBroker('hub', hubPort, ns)
    const agent = prodAgentBroker('dev-agent-0', hubUrl, ns)
    brokers.push(hub, agent)

    hub.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: () => ({}),
        getRecentEvents: () => [],
        onLog: () => {},
      }),
    )

    // Register the $event-bus service on both brokers BEFORE start
    // so the `camstack.evt.*` broadcasts reach every subscriber
    // as soon as TCP discovery completes. If we defer to first
    // `createAddonContext` call (post-start), initial broadcasts may be
    // dropped until the next Moleculer heartbeat.
    registerEventBusService(hub)
    registerEventBusService(agent)
    await hub.start()
    await agent.start()
    await waitUntil(() => actionIsAvailable(agent, '$hub.getAddonConfig'), 20_000)

    const dirHub = tmpDir('hub')
    tmpDirs.push(dirHub)
    const dirA = tmpDir('a')
    tmpDirs.push(dirA)
    const ctxHub = await createAddonContext(hub, decl('consumer'), dirHub)
    const ctxA = await createAddonContext(agent, decl('producer'), dirA)

    const consumer = new ReadinessRegistry({
      eventBus: ctxHub.eventBus,
      sourceNodeId: 'hub',
    })
    try {
      // Consumer calls awaitReady BEFORE producer emits.
      const waitPromise = consumer.awaitReady(
        'detection-pipeline',
        { type: 'node', nodeId: 'dev-agent-0' },
        { timeoutMs: 15_000 },
      )

      // After a small delay, producer emits — simulating the
      // BaseAddon auto-emission that happens post-initialize.
      await new Promise((r) => setTimeout(r, 200))
      emitReadiness(ctxA.eventBus, {
        capName: 'detection-pipeline',
        scope: { type: 'node', nodeId: 'dev-agent-0' },
        state: 'ready',
        generation: 'gen-PROD-1',
        sourceNodeId: 'dev-agent-0',
      })

      await expect(waitPromise).resolves.toBeUndefined()

      const snap = consumer.get('detection-pipeline', { type: 'node', nodeId: 'dev-agent-0' })
      expect(snap).not.toBeNull()
      expect(snap!.state).toBe('ready')
      expect(snap!.epoch).toBe(1)
      expect(snap!.generation).toBe('gen-PROD-1')
    } finally {
      consumer.close()
    }
  }, 60_000)

  it('E7 — awaitReady rejects with ReadinessTimeoutError when producer never emits', async () => {
    if (!(await checkTcpAvailable())) return

    const hubPort = await findFreePort()
    const ns = `ready-e7-${Date.now()}`
    const hub = prodHubBroker('hub', hubPort, ns)
    brokers.push(hub)

    hub.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: () => ({}),
        getRecentEvents: () => [],
        onLog: () => {},
      }),
    )
    registerEventBusService(hub)
    await hub.start()

    const dirHub = tmpDir('hub')
    tmpDirs.push(dirHub)
    const ctxHub = await createAddonContext(hub, decl('consumer'), dirHub)
    const consumer = new ReadinessRegistry({
      eventBus: ctxHub.eventBus,
      sourceNodeId: 'hub',
    })
    try {
      await expect(
        consumer.awaitReady('never-coming', { type: 'global' }, { timeoutMs: 200 }),
      ).rejects.toBeInstanceOf(ReadinessTimeoutError)
    } finally {
      consumer.close()
    }
  }, 15_000)

  it('E8 — late consumer reads current state from snapshot without re-awaiting', async () => {
    if (!(await checkTcpAvailable())) return

    const hubPort = await findFreePort()
    const ns = `ready-e8-${Date.now()}`
    const hubUrl = `127.0.0.1:${hubPort}/hub`
    const hub = prodHubBroker('hub', hubPort, ns)
    const agent = prodAgentBroker('dev-agent-0', hubUrl, ns)
    brokers.push(hub, agent)

    hub.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: () => ({}),
        getRecentEvents: () => [],
        onLog: () => {},
      }),
    )
    // Register the $event-bus service on both brokers BEFORE start
    // so the `camstack.evt.*` broadcasts reach every subscriber
    // as soon as TCP discovery completes. If we defer to first
    // `createAddonContext` call (post-start), initial broadcasts may be
    // dropped until the next Moleculer heartbeat.
    registerEventBusService(hub)
    registerEventBusService(agent)
    await hub.start()
    await agent.start()
    await waitUntil(() => actionIsAvailable(agent, '$hub.getAddonConfig'), 20_000)

    const dirHub = tmpDir('hub')
    tmpDirs.push(dirHub)
    const dirA = tmpDir('a')
    tmpDirs.push(dirA)
    const ctxHub = await createAddonContext(hub, decl('consumer'), dirHub)
    const ctxA = await createAddonContext(agent, decl('producer'), dirA)

    // Consumer mounts first and ingests the event, but doesn't
    // subscribe immediately — mirrors a consumer that was running
    // during the producer's emission.
    const consumer = new ReadinessRegistry({ eventBus: ctxHub.eventBus, sourceNodeId: 'hub' })
    try {
      emitReadiness(ctxA.eventBus, {
        capName: 'decoder-nodeav',
        scope: { type: 'node', nodeId: 'dev-agent-0' },
        state: 'ready',
        generation: 'gen-D1',
        sourceNodeId: 'dev-agent-0',
      })
      // Give the event time to round-trip through Moleculer.
      await waitUntil(
        () =>
          consumer.get('decoder-nodeav', { type: 'node', nodeId: 'dev-agent-0' })?.state ===
          'ready',
        10_000,
      )

      // Now a late awaitReady call should return immediately.
      const t0 = Date.now()
      await consumer.awaitReady(
        'decoder-nodeav',
        { type: 'node', nodeId: 'dev-agent-0' },
        { timeoutMs: 500 },
      )
      expect(Date.now() - t0).toBeLessThan(100)
    } finally {
      consumer.close()
    }
  }, 60_000)

  it('E10 — multiple consumers on the same producer see the same epoch', async () => {
    if (!(await checkTcpAvailable())) return

    const hubPort = await findFreePort()
    const ns = `ready-e10-${Date.now()}`
    const hubUrl = `127.0.0.1:${hubPort}/hub`
    const hub = prodHubBroker('hub', hubPort, ns)
    const agent = prodAgentBroker('dev-agent-0', hubUrl, ns)
    brokers.push(hub, agent)

    hub.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: () => ({}),
        getRecentEvents: () => [],
        onLog: () => {},
      }),
    )
    // Register the $event-bus service on both brokers BEFORE start
    // so the `camstack.evt.*` broadcasts reach every subscriber
    // as soon as TCP discovery completes. If we defer to first
    // `createAddonContext` call (post-start), initial broadcasts may be
    // dropped until the next Moleculer heartbeat.
    registerEventBusService(hub)
    registerEventBusService(agent)
    await hub.start()
    await agent.start()
    await waitUntil(() => actionIsAvailable(agent, '$hub.getAddonConfig'), 20_000)

    const dirHub = tmpDir('hub')
    tmpDirs.push(dirHub)
    const dirA = tmpDir('a')
    tmpDirs.push(dirA)
    const ctxHub = await createAddonContext(hub, decl('consumer'), dirHub)
    const ctxA = await createAddonContext(agent, decl('producer'), dirA)

    const consumerA = new ReadinessRegistry({ eventBus: ctxHub.eventBus, sourceNodeId: 'hub' })
    const consumerB = new ReadinessRegistry({ eventBus: ctxHub.eventBus, sourceNodeId: 'hub' })
    try {
      const seenA: number[] = []
      const seenB: number[] = []
      consumerA.onReadyState('detection-pipeline', { type: 'node', nodeId: 'dev-agent-0' }, (t) => {
        if (t.state === 'ready') seenA.push(t.epoch)
      })
      consumerB.onReadyState('detection-pipeline', { type: 'node', nodeId: 'dev-agent-0' }, (t) => {
        if (t.state === 'ready') seenB.push(t.epoch)
      })

      emitReadiness(ctxA.eventBus, {
        capName: 'detection-pipeline',
        scope: { type: 'node', nodeId: 'dev-agent-0' },
        state: 'ready',
        generation: 'gen-PROD-1',
        sourceNodeId: 'dev-agent-0',
      })
      await waitUntil(() => seenA.length >= 1 && seenB.length >= 1, 10_000)

      // Producer goes down + comes back with new generation.
      emitReadiness(ctxA.eventBus, {
        capName: 'detection-pipeline',
        scope: { type: 'node', nodeId: 'dev-agent-0' },
        state: 'down',
        generation: 'gen-PROD-1',
        sourceNodeId: 'dev-agent-0',
      })
      emitReadiness(ctxA.eventBus, {
        capName: 'detection-pipeline',
        scope: { type: 'node', nodeId: 'dev-agent-0' },
        state: 'ready',
        generation: 'gen-PROD-2',
        sourceNodeId: 'dev-agent-0',
      })
      await waitUntil(() => seenA.length >= 2 && seenB.length >= 2, 10_000)

      expect(seenA).toEqual([1, 2])
      expect(seenB).toEqual([1, 2])
    } finally {
      consumerA.close()
      consumerB.close()
    }
  }, 60_000)

  it('E4 — multiple caps on the same agent track epochs independently', async () => {
    if (!(await checkTcpAvailable())) return

    const hubPort = await findFreePort()
    const ns = `ready-e4-${Date.now()}`
    const hubUrl = `127.0.0.1:${hubPort}/hub`
    const hub = prodHubBroker('hub', hubPort, ns)
    const agent = prodAgentBroker('dev-agent-0', hubUrl, ns)
    brokers.push(hub, agent)

    hub.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: () => ({}),
        getRecentEvents: () => [],
        onLog: () => {},
      }),
    )
    // Register the $event-bus service on both brokers BEFORE start
    // so the `camstack.evt.*` broadcasts reach every subscriber
    // as soon as TCP discovery completes. If we defer to first
    // `createAddonContext` call (post-start), initial broadcasts may be
    // dropped until the next Moleculer heartbeat.
    registerEventBusService(hub)
    registerEventBusService(agent)
    await hub.start()
    await agent.start()
    await waitUntil(() => actionIsAvailable(agent, '$hub.getAddonConfig'), 20_000)

    const dirHub = tmpDir('hub')
    tmpDirs.push(dirHub)
    const dirA = tmpDir('a')
    tmpDirs.push(dirA)
    const ctxHub = await createAddonContext(hub, decl('consumer'), dirHub)
    const ctxA = await createAddonContext(agent, decl('producer'), dirA)

    const consumer = new ReadinessRegistry({ eventBus: ctxHub.eventBus, sourceNodeId: 'hub' })
    try {
      const scope = { type: 'node' as const, nodeId: 'dev-agent-0' }

      emitReadiness(ctxA.eventBus, {
        capName: 'detection-pipeline',
        scope,
        state: 'ready',
        generation: 'gen-X-1',
        sourceNodeId: 'dev-agent-0',
      })
      emitReadiness(ctxA.eventBus, {
        capName: 'decoder-nodeav',
        scope,
        state: 'ready',
        generation: 'gen-X-1',
        sourceNodeId: 'dev-agent-0',
      })
      await waitUntil(
        () =>
          consumer.get('detection-pipeline', scope)?.state === 'ready' &&
          consumer.get('decoder-nodeav', scope)?.state === 'ready',
        10_000,
      )

      // Only detection-pipeline restarts — decoder stays up.
      emitReadiness(ctxA.eventBus, {
        capName: 'detection-pipeline',
        scope,
        state: 'down',
        generation: 'gen-X-1',
        sourceNodeId: 'dev-agent-0',
      })
      emitReadiness(ctxA.eventBus, {
        capName: 'detection-pipeline',
        scope,
        state: 'ready',
        generation: 'gen-X-2',
        sourceNodeId: 'dev-agent-0',
      })
      await waitUntil(() => consumer.get('detection-pipeline', scope)?.epoch === 2, 10_000)

      expect(consumer.get('detection-pipeline', scope)!.epoch).toBe(2)
      expect(consumer.get('decoder-nodeav', scope)!.epoch).toBe(1) // untouched
    } finally {
      consumer.close()
    }
  }, 60_000)

  it('E12 — addon that never initializes never emits, consumer hits timeout', async () => {
    if (!(await checkTcpAvailable())) return

    const hubPort = await findFreePort()
    const ns = `ready-e12-${Date.now()}`
    const hubUrl = `127.0.0.1:${hubPort}/hub`
    const hub = prodHubBroker('hub', hubPort, ns)
    const agent = prodAgentBroker('dev-agent-0', hubUrl, ns)
    brokers.push(hub, agent)

    hub.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: () => ({}),
        getRecentEvents: () => [],
        onLog: () => {},
      }),
    )
    // Register the $event-bus service on both brokers BEFORE start
    // so the `camstack.evt.*` broadcasts reach every subscriber
    // as soon as TCP discovery completes. If we defer to first
    // `createAddonContext` call (post-start), initial broadcasts may be
    // dropped until the next Moleculer heartbeat.
    registerEventBusService(hub)
    registerEventBusService(agent)
    await hub.start()
    await agent.start()
    await waitUntil(() => actionIsAvailable(agent, '$hub.getAddonConfig'), 20_000)

    const dirHub = tmpDir('hub')
    tmpDirs.push(dirHub)
    const ctxHub = await createAddonContext(hub, decl('consumer'), dirHub)

    const consumer = new ReadinessRegistry({ eventBus: ctxHub.eventBus, sourceNodeId: 'hub' })
    try {
      // Agent is up but no producer ever calls emitReadiness for this cap.
      await expect(
        consumer.awaitReady(
          'missing-cap',
          { type: 'node', nodeId: 'dev-agent-0' },
          { timeoutMs: 500 },
        ),
      ).rejects.toBeInstanceOf(ReadinessTimeoutError)
      expect(consumer.get('missing-cap', { type: 'node', nodeId: 'dev-agent-0' })).toBeNull()
    } finally {
      consumer.close()
    }
  }, 60_000)

  it('E2 — detection-never-starts regression: orchestrator subscribes before producer, producer emits late, seed fires with new epoch', async () => {
    // Simulates the exact production bug the spec was written to cure:
    //   1. Orchestrator (on hub) mounts early and subscribes to
    //      `detection-pipeline` readiness on `{type:'node', nodeId:'hub'}`.
    //   2. Hub's forked `hub/detection-pipeline` child is slow to
    //      initialize — it joins the bus AFTER the orchestrator already
    //      tried (and failed) the old init-time seed.
    //   3. When the forked child completes init and emits `ready`, the
    //      orchestrator's readiness subscription fires the seed + redispatch.
    //
    // Assertion: the seed callback runs exactly once on the `ready`
    // transition with the correct epoch — captures the behaviour that
    // replaces the fire-and-forget init seed.
    if (!(await checkTcpAvailable())) return

    const hubPort = await findFreePort()
    const ns = `ready-e2-${Date.now()}`
    const hubUrl = `127.0.0.1:${hubPort}/hub`
    const hub = prodHubBroker('hub', hubPort, ns)
    // The forked child emits from its own broker (represents the
    // forked-process flow — it's a Moleculer node in its own right
    // that carries the provider even though it's co-located with hub).
    const forkedChild = prodAgentBroker('hub/detection-pipeline', hubUrl, ns)
    brokers.push(hub, forkedChild)

    hub.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: () => ({}),
        getRecentEvents: () => [],
        onLog: () => {},
      }),
    )
    registerEventBusService(hub)
    registerEventBusService(forkedChild)
    await hub.start()
    // Delay child start to model the race: orchestrator boots first.
    const childStartPromise = (async () => {
      await new Promise((r) => setTimeout(r, 400))
      await forkedChild.start()
      await waitUntil(() => actionIsAvailable(forkedChild, '$hub.getAddonConfig'), 20_000)
    })()

    const dirHub = tmpDir('orch')
    tmpDirs.push(dirHub)
    const ctxHub = await createAddonContext(hub, decl('orchestrator'), dirHub)

    // Orchestrator-like consumer — subscribes BEFORE the provider exists.
    // Tracks every seed+redispatch firing with the epoch for idempotency assertions.
    const consumer = new ReadinessRegistry({ eventBus: ctxHub.eventBus, sourceNodeId: 'hub' })
    const seeds: Array<{ epoch: number; generation: string; state: string }> = []
    let lastSeenEpoch = 0
    consumer.onReadyState('detection-pipeline', { type: 'node', nodeId: 'hub' }, (t) => {
      if (t.state !== 'ready') return
      if (t.epoch <= lastSeenEpoch) return // orchestrator's epoch guard
      lastSeenEpoch = t.epoch
      seeds.push({ epoch: t.epoch, generation: t.generation, state: t.state })
    })

    // Wait for the forked child to finish booting, then emit `ready`.
    await childStartPromise
    const dirChild = tmpDir('child')
    tmpDirs.push(dirChild)
    const ctxChild = await createAddonContext(forkedChild, decl('detection-pipeline'), dirChild)

    emitReadiness(ctxChild.eventBus, {
      capName: 'detection-pipeline',
      scope: { type: 'node', nodeId: 'hub' }, // child carries the cap for its parent nodeId
      state: 'ready',
      generation: 'gen-child-1',
      sourceNodeId: 'hub/detection-pipeline',
    })

    try {
      await waitUntil(() => seeds.length >= 1, 10_000)
      expect(seeds[0]).toEqual({ epoch: 1, generation: 'gen-child-1', state: 'ready' })

      // Idempotent keepalive — child re-emits the same generation
      // (e.g. $node.connected re-emission). Orchestrator MUST NOT
      // re-seed for the same epoch.
      emitReadiness(ctxChild.eventBus, {
        capName: 'detection-pipeline',
        scope: { type: 'node', nodeId: 'hub' },
        state: 'ready',
        generation: 'gen-child-1',
        sourceNodeId: 'hub/detection-pipeline',
      })
      await new Promise((r) => setTimeout(r, 500))
      expect(seeds).toHaveLength(1)

      // Child crashes + respawns — new generation → seed fires again.
      emitReadiness(ctxChild.eventBus, {
        capName: 'detection-pipeline',
        scope: { type: 'node', nodeId: 'hub' },
        state: 'down',
        generation: 'gen-child-1',
        sourceNodeId: 'hub/detection-pipeline',
      })
      emitReadiness(ctxChild.eventBus, {
        capName: 'detection-pipeline',
        scope: { type: 'node', nodeId: 'hub' },
        state: 'ready',
        generation: 'gen-child-2',
        sourceNodeId: 'hub/detection-pipeline',
      })
      await waitUntil(() => seeds.length >= 2, 10_000)
      expect(seeds[1]).toEqual({ epoch: 2, generation: 'gen-child-2', state: 'ready' })
    } finally {
      consumer.close()
    }
  }, 60_000)
})
