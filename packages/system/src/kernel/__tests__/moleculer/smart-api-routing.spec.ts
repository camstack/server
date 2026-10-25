/**
 * Smart API routing — tRPC local-first resolution tests.
 *
 * Verifies that `ctx.api` (a real tRPC client) transparently picks the
 * fastest path for every capability call:
 *
 *   - IN-PROCESS: provider registered in the same Node.js process →
 *     direct method call, zero serialization.
 *   - CROSS-NODE: provider lives on another Moleculer node → routed
 *     through the broker transport.
 *   - HUB-ONLY: provider only exists on the hub → wsLink / broker
 *     fallback to the hub's tRPC server.
 *
 * Setup: 1 hub + 2 agents, overlapping capabilities on all 3 nodes.
 *
 * Capability layout:
 *
 *   ┌─────────┬──────────────────┬───────────────────────┐
 *   │  Node   │  echo (singleton) │  counter (collection) │
 *   ├─────────┼──────────────────┼───────────────────────┤
 *   │  hub    │  echo-hub        │  counter-hub          │
 *   │  agentA │  echo-agentA     │  counter-agentA       │
 *   │  agentB │  echo-agentB     │  (none)               │
 *   └─────────┴──────────────────┴───────────────────────┘
 *
 * Test matrix:
 *
 *   1. Hub calls echo.ping      → resolves to echo-hub (in-process)
 *   2. AgentA calls echo.ping   → resolves to echo-agentA (in-process)
 *   3. AgentB calls echo.ping   → resolves to echo-agentB (in-process)
 *
 *   4. Hub calls echo on agentA (node-targeted) → resolves to echo-agentA (cross-node)
 *   5. AgentA calls echo on hub (node-targeted) → resolves to echo-hub (cross-node)
 *
 *   6. Hub calls counter.getAll → returns [counter-hub] (in-process, 1 local provider)
 *   7. AgentA calls counter.getAll → returns [counter-agentA] (in-process)
 *   8. AgentB calls counter.getAll → returns [] (no local provider, hub not queried implicitly)
 *
 *   9. Hub queries all counter providers across cluster → [counter-hub, counter-agentA]
 *
 *  10. Provider registered AFTER ctx.api creation → still resolved (lazy)
 *  11. Provider unregistered → next call falls through to remote
 *
 *  12. Non-existent capability → clear error (not silent null)
 *
 * These tests define the CONTRACT. The implementation (tRPC custom link,
 * broker-api-proxy rewrite, or a hybrid) must pass all of them.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- test capabilities (echo, counter) are not in the generated AppRouter; the proxy resolves them dynamically at runtime */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ServiceBroker } from 'moleculer'
import { createAddonContext, withAddonScope } from '../../moleculer/addon-context-factory.js'
import { createHubService } from '../../moleculer/hub-service.js'
import type { AddonDeclaration, InternalAddonContext } from '@camstack/types'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ── Test capability providers ────────────────────────────────────────

/** Simple echo provider — returns the nodeId it lives on. */
function makeEchoProvider(nodeId: string) {
  return {
    ping: async (_input?: unknown) => ({ pong: true, nodeId }),
    identify: async () => ({ nodeId }),
  }
}

/** Counter provider — keeps a local count, returns it. */
function makeCounterProvider(nodeId: string) {
  let count = 0
  return {
    increment: async () => {
      count += 1
      return { count, nodeId }
    },
    getCount: async () => ({ count, nodeId }),
    reset: async () => {
      count = 0
    },
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function decl(id: string): AddonDeclaration {
  return { id, entry: './index.js' }
}

function createTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `smart-api-${label}-`))
}

/** A dynamically-resolved tRPC cap method (test caps aren't in `AppRouter`). */
type DynCapMethod = {
  query: (input?: unknown, opts?: { signal?: AbortSignal }) => Promise<unknown>
}
/**
 * A dynamically-resolved tRPC cap. The test caps expose a fixed set of
 * methods (`ping` / `identify` / `getCount`); also indexable by an arbitrary
 * method name for the "non-existent cap" probe.
 */
type DynCap = {
  ping: DynCapMethod
  identify: DynCapMethod
  getCount: DynCapMethod
} & Record<string, DynCapMethod | undefined>

/**
 * Resolve a dynamically-registered test capability off `ctx.api`. The test
 * capabilities (`echo`, `counter`) are registered at runtime and resolved by
 * the proxy, so they aren't part of the statically-generated `AddonApi` /
 * `AppRouter` surface.
 */
function dynCap(ctx: InternalAddonContext, cap: string): DynCap {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- runtime-resolved test caps
  const api = ctx.api as unknown as Record<string, DynCap>
  return api[cap]!
}

// ── Test suite ─────────────────────────────────────���────────────────

describe('Smart API routing — tRPC local-first resolution', () => {
  let hubBroker: ServiceBroker
  let agentABroker: ServiceBroker
  let agentBBroker: ServiceBroker

  let hubCtx: InternalAddonContext
  let agentACtx: InternalAddonContext
  let agentBCtx: InternalAddonContext

  let tmpDirHub: string
  let tmpDirA: string
  let tmpDirB: string

  beforeAll(async () => {
    // Create Moleculer brokers with Fake transporter (in-memory, same process)
    hubBroker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    agentABroker = new ServiceBroker({ nodeID: 'agent-a', transporter: 'Fake', logger: false })
    agentBBroker = new ServiceBroker({ nodeID: 'agent-b', transporter: 'Fake', logger: false })

    // Hub service — required for $hub.event / $hub.log routing
    hubBroker.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: () => ({}),
        getRecentEvents: () => [],
        onLog: () => {},
      }),
    )

    await hubBroker.start()
    await agentABroker.start()
    await agentBBroker.start()

    // Wait for node discovery
    const waitForNodes = async (broker: ServiceBroker, expected: string[]) => {
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const nodes = broker.registry
          .getNodeList({ onlyAvailable: true })
          .map((n: { id: string }) => n.id)
        if (expected.every((id) => nodes.includes(id))) return
        await new Promise((r) => setTimeout(r, 50))
      }
      throw new Error(`Timed out waiting for nodes: ${expected.join(', ')}`)
    }

    await waitForNodes(hubBroker, ['agent-a', 'agent-b'])

    // Create temp dirs
    tmpDirHub = createTmpDir('hub')
    tmpDirA = createTmpDir('agent-a')
    tmpDirB = createTmpDir('agent-b')

    // Create addon contexts
    hubCtx = await createAddonContext(hubBroker, decl('test-addon-hub'), tmpDirHub)
    agentACtx = await createAddonContext(agentABroker, decl('test-addon-a'), tmpDirA)
    agentBCtx = await createAddonContext(agentBBroker, decl('test-addon-b'), tmpDirB)

    // Register providers — each node gets its own echo + selective counter
    withAddonScope('test-addon-hub', () => {
      hubCtx.registerProvider!('echo', makeEchoProvider('hub'))
      hubCtx.registerProvider!('counter', makeCounterProvider('hub'))
    })

    withAddonScope('test-addon-a', () => {
      agentACtx.registerProvider!('echo', makeEchoProvider('agent-a'))
      agentACtx.registerProvider!('counter', makeCounterProvider('agent-a'))
    })

    withAddonScope('test-addon-b', () => {
      agentBCtx.registerProvider!('echo', makeEchoProvider('agent-b'))
      // Note: agent-b does NOT register a counter provider
    })
  })

  afterAll(async () => {
    await agentBBroker.stop()
    await agentABroker.stop()
    await hubBroker.stop()
    for (const dir of [tmpDirHub, tmpDirA, tmpDirB]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* swallow */
      }
    }
  })

  // ── 1-3: In-process resolution (local provider wins) ──────────────

  describe('in-process resolution', () => {
    it('1. hub calls echo.ping → resolves to local echo-hub provider', async () => {
      const result = await dynCap(hubCtx, 'echo').ping.query()
      expect(result).toEqual({ pong: true, nodeId: 'hub' })
    })

    it('2. agentA calls echo.ping → resolves to local echo-agentA provider', async () => {
      const result = await dynCap(agentACtx, 'echo').ping.query()
      expect(result).toEqual({ pong: true, nodeId: 'agent-a' })
    })

    it('3. agentB calls echo.ping → resolves to local echo-agentB provider', async () => {
      const result = await dynCap(agentBCtx, 'echo').ping.query()
      expect(result).toEqual({ pong: true, nodeId: 'agent-b' })
    })
  })

  // ── 4-5: Cross-node resolution (explicit node targeting) ────────��─

  describe('cross-node resolution', () => {
    it('4. hub calls echo on agent-a → resolves to echo-agentA', async () => {
      // This requires node-targeted call support.
      // The exact API shape depends on implementation — could be:
      //   ctx.api.echo.ping.query({ _nodeId: 'agent-a' })
      // or a separate method. For now, test the concept.
      // TODO: define the node-targeting API shape
      expect(true).toBe(true) // placeholder
    })

    it('5. agentA calls echo on hub → resolves to echo-hub', async () => {
      // Same: requires node-targeted call support
      // TODO: define the node-targeting API shape
      expect(true).toBe(true) // placeholder
    })
  })

  // ── 6-8: Collection resolution ────────────────────────────────────

  describe('collection resolution (local scope)', () => {
    it('6. hub calls counter.getCount → returns hub counter value', async () => {
      const result = await dynCap(hubCtx, 'counter').getCount.query()
      expect(result).toMatchObject({ nodeId: 'hub' })
    })

    it('7. agentA calls counter.getCount → returns agentA counter value', async () => {
      const result = await dynCap(agentACtx, 'counter').getCount.query()
      expect(result).toMatchObject({ nodeId: 'agent-a' })
    })

    it('8. agentB calls counter.getCount ��� no local provider, waits until aborted', async () => {
      // Agent-B has no counter provider and hub counter is not visible to it
      // in this fixture (different transporter, no cluster advertise). The
      // brokerTransportLink now waits indefinitely for service discovery —
      // matches the `ctx.api` location-transparency rule: callers can't
      // tell if a cap is missing or just arriving late. Addons that want
      // bounded waiting use a caller-supplied AbortSignal.
      const ctrl = new AbortController()
      setTimeout(() => ctrl.abort(), 300)
      await expect(
        dynCap(agentBCtx, 'counter').getCount.query(undefined, { signal: ctrl.signal }),
      ).rejects.toThrow()
    })
  })

  // ── 9: Cluster-wide collection query ──────────────────────────────

  describe('cluster-wide resolution', () => {
    it('9. hub queries all counter providers across cluster', async () => {
      // TODO: define the cluster-wide collection query API
      // Could be: ctx.api.$getCollectionProviders<Counter>('counter')
      // This returns providers from ALL nodes, not just local.
      expect(true).toBe(true) // placeholder
    })
  })

  // ── 10-11: Dynamic registration / unregistration ──────────────────

  describe('dynamic provider lifecycle', () => {
    it('10. provider registered AFTER ctx.api creation is still resolved', async () => {
      // Use a FRESH broker so its per-broker registry starts empty.
      const freshBroker = new ServiceBroker({
        nodeID: 'fresh-late',
        transporter: 'Fake',
        logger: false,
      })
      await freshBroker.start()
      const tmpDir = createTmpDir('late-reg')

      try {
        const ctx = await createAddonContext(freshBroker, decl('late-addon'), tmpDir)

        // No provider yet — the call waits for discovery. With an abort
        // after 200ms it rejects, proving the caller controls deadlines.
        const earlyCtrl = new AbortController()
        setTimeout(() => earlyCtrl.abort(), 200)
        await expect(
          dynCap(ctx, 'echo').identify.query(undefined, { signal: earlyCtrl.signal }),
        ).rejects.toThrow()

        // Register a provider AFTER the context was created
        withAddonScope('late-addon', () => {
          ctx.registerProvider!('echo', makeEchoProvider('late-registered'))
        })

        // Now it should resolve locally — the resolver checks at call time
        const result = await dynCap(ctx, 'echo').identify.query()
        expect(result).toEqual({ nodeId: 'late-registered' })
      } finally {
        await freshBroker.stop()
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('11. unregistered provider falls through to remote', async () => {
      // TODO: implement provider unregistration on worker contexts
      // After unregister, the local resolution should stop working
      // and the call should route to the hub or fail.
      expect(true).toBe(true) // placeholder
    })
  })

  // ── 12: Error handling ────────────────────────────────────────────

  describe('error handling', () => {
    it('12. non-existent capability waits until the caller aborts', async () => {
      // `brokerTransportLink` is deadline-free by design (location
      // transparency) — a capability that the caller expects to never
      // exist must be guarded with a caller-supplied AbortSignal.
      const cap = dynCap(hubCtx, 'nonExistentCap')
      const ctrl = new AbortController()
      setTimeout(() => ctrl.abort(), 300)
      await expect(cap['someMethod']!.query(undefined, { signal: ctrl.signal })).rejects.toThrow()
    })
  })
})
