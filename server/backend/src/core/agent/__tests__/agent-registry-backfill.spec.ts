import { describe, expect, it, vi } from 'vitest'
import type { AddonRegistryService } from '../../addon/addon-registry.service'
import type { CapabilityService } from '../../capability/capability.service'
import type { EventBusService } from '../../events/event-bus.service'
import type { MoleculerService } from '../../moleculer/moleculer.service'
import { MAX_BACKFILL_ATTEMPTS, type NodePackageEntry } from '../agent-addon-backfill'
import { DELIVERY_GRACE_MS } from '../agent-delivery-ledger'
import { AgentRegistryService } from '../agent-registry.service'
import type { ClusterNodeHistoryStore } from '../cluster-node-history-store'

/**
 * Node addon back-fill — the hub converges a node to the roster THAT NODE
 * itself last declared.
 *
 * Before this existed, `reconcileAgentAddons` was undeploy-only: an agent whose
 * `<dataDir>/addons` had been wiped came back with its 4 bootstrap packages and
 * the hub never sent the other 10. Under the volume-only image that empty state
 * is the ordinary first boot of every rebuilt node, so the gap had to close
 * before the seed could be removed.
 */

interface HubAddonRow {
  readonly manifest: {
    readonly id: string
    readonly packageName: string
    readonly packageVersion: string
  }
  readonly declaration: { readonly id: string; readonly execution: { readonly placement: string } }
}

const HUB_ROWS: readonly HubAddonRow[] = [
  {
    manifest: { id: 'recorder', packageName: '@camstack/addon-pipeline', packageVersion: '1.2.14' },
    declaration: { id: 'recorder', execution: { placement: 'any-node' } },
  },
  {
    manifest: { id: 'llm', packageName: '@camstack/addon-ai', packageVersion: '1.2.14' },
    declaration: { id: 'llm', execution: { placement: 'any-node' } },
  },
  {
    manifest: {
      id: 'embedding-encoder',
      packageName: '@camstack/addon-post-analysis',
      packageVersion: '1.2.14',
    },
    declaration: { id: 'embedding-encoder', execution: { placement: 'any-node' } },
  },
]

/** In-memory stand-in for the durable per-node roster record. */
function makeStore(seed: Record<string, readonly NodePackageEntry[]> = {}) {
  const rosters = new Map<string, NodePackageEntry[]>(
    Object.entries(seed).map(([k, v]) => [k, [...v]]),
  )
  const store = {
    getPackages: vi.fn(async (nodeId: string) => rosters.get(nodeId) ?? []),
    recordPackages: vi.fn(async (nodeId: string, packages: readonly NodePackageEntry[]) => {
      const merged = new Map((rosters.get(nodeId) ?? []).map((p) => [p.name, p]))
      for (const p of packages) merged.set(p.name, p)
      rosters.set(nodeId, [...merged.values()])
    }),
    prunePackages: vi.fn(async (nodeId: string, names: readonly string[]) => {
      const drop = new Set(names)
      rosters.set(
        nodeId,
        (rosters.get(nodeId) ?? []).filter((p) => !drop.has(p.name)),
      )
    }),
    snapshot: vi.fn(async () => undefined),
    touch: vi.fn(async () => undefined),
    tryGetAll: vi.fn(async () => []),
    forget: vi.fn(async () => undefined),
  }
  return { store: store as unknown as ClusterNodeHistoryStore, rosters, spies: store }
}

interface HarnessOptions {
  readonly agentAddons: ReadonlyArray<{ id: string; packageName?: string; version?: string }>
  readonly recorded?: Record<string, readonly NodePackageEntry[]>
  readonly hubRows?: readonly HubAddonRow[]
  readonly packFails?: ReadonlySet<string>
  readonly deployDelayMs?: number
}

function makeHarness(opts: HarnessOptions) {
  const undeployed: string[] = []
  const deployed: string[] = []
  const reloads: string[] = []

  const broker = {
    call: vi.fn(async (action: string, params?: Record<string, unknown>) => {
      if (action === '$agent.status') return { addons: opts.agentAddons }
      if (action === '$agent.undeploy') {
        undeployed.push(String(params?.['addonId']))
        return { ok: true }
      }
      return undefined
    }),
    waitForServices: vi.fn(async () => undefined),
    localBus: { on: vi.fn() },
  }

  const moleculer = { broker } as unknown as MoleculerService
  const eventBus = { emit: vi.fn() } as unknown as EventBusService
  const capabilityService = {} as unknown as CapabilityService

  const service = new AgentRegistryService(eventBus, moleculer, capabilityService)
  service.setAddonRegistry({
    listAddons: () => opts.hubRows ?? HUB_ROWS,
  } as unknown as AddonRegistryService)

  const { store, rosters, spies } = makeStore(opts.recorded ?? {})
  service.setClusterNodeHistoryStore(store)

  service.setAddonBackfill({
    pack: vi.fn(async (name: string) => {
      if (opts.packFails?.has(name)) throw new Error(`npm pack failed for ${name}`)
      return Buffer.from(`tgz:${name}`)
    }),
    deploy: vi.fn(async (_nodeId: string, name: string) => {
      if (opts.deployDelayMs) await new Promise((r) => setTimeout(r, opts.deployDelayMs))
      deployed.push(name)
    }),
    reload: vi.fn(async (nodeId: string) => {
      reloads.push(nodeId)
    }),
  })

  return { service, undeployed, deployed, reloads, rosters, spies }
}

const WIPED_AGENT = [
  { id: 'sqlite-settings', packageName: '@camstack/system', version: '1.2.14' },
  { id: 'agent-ui', packageName: '@camstack/addon-agent-ui', version: '1.2.14' },
  { id: 'recorder', packageName: '@camstack/addon-pipeline', version: '1.2.14' },
]

const FULL_ROSTER: readonly NodePackageEntry[] = [
  { name: '@camstack/system', version: '1.2.14' },
  { name: '@camstack/addon-agent-ui', version: '1.2.14' },
  { name: '@camstack/addon-pipeline', version: '1.2.14' },
  { name: '@camstack/addon-ai', version: '1.2.10' },
  { name: '@camstack/addon-post-analysis', version: '1.2.10' },
]

describe('AgentRegistryService — addon back-fill', () => {
  it('converges a wiped node back to the roster it last declared', async () => {
    const h = makeHarness({
      agentAddons: WIPED_AGENT,
      recorded: { 'agent-a': FULL_ROSTER },
    })

    await h.service.reconcileAgentAddons('agent-a')

    expect(h.deployed).toEqual(['@camstack/addon-ai', '@camstack/addon-post-analysis'])
    expect(h.reloads).toEqual(['agent-a'])
    expect(h.undeployed).toEqual([])
  })

  it('back-fills at the HUB-installed version, not the version the node last ran', async () => {
    const packCalls: Array<[string, string]> = []
    const h = makeHarness({
      agentAddons: WIPED_AGENT,
      recorded: { 'agent-a': FULL_ROSTER },
    })
    // Re-wire pack to capture the requested version.
    h.service.setAddonBackfill({
      pack: async (name: string, version: string) => {
        packCalls.push([name, version])
        return Buffer.from('tgz')
      },
      deploy: async () => undefined,
      reload: async () => undefined,
    })

    await h.service.reconcileAgentAddons('agent-a')

    expect(packCalls).toEqual([
      ['@camstack/addon-ai', '1.2.14'],
      ['@camstack/addon-post-analysis', '1.2.14'],
    ])
  })

  it('is a no-op for a node that already has its full roster', async () => {
    const h = makeHarness({
      agentAddons: [
        ...WIPED_AGENT,
        { id: 'llm', packageName: '@camstack/addon-ai', version: '1.2.14' },
        {
          id: 'embedding-encoder',
          packageName: '@camstack/addon-post-analysis',
          version: '1.2.14',
        },
      ],
      recorded: { 'agent-a': FULL_ROSTER },
    })

    await h.service.reconcileAgentAddons('agent-a')

    expect(h.deployed).toEqual([])
    expect(h.reloads).toEqual([])
    expect(h.undeployed).toEqual([])
  })

  it('delivers exactly the one package a node is missing', async () => {
    const h = makeHarness({
      agentAddons: [
        ...WIPED_AGENT,
        { id: 'llm', packageName: '@camstack/addon-ai', version: '1.2.14' },
      ],
      recorded: { 'agent-a': FULL_ROSTER },
    })

    await h.service.reconcileAgentAddons('agent-a')

    expect(h.deployed).toEqual(['@camstack/addon-post-analysis'])
  })

  it('records what the node declares, so the next wipe has something to converge to', async () => {
    const h = makeHarness({
      agentAddons: [
        ...WIPED_AGENT,
        { id: 'llm', packageName: '@camstack/addon-ai', version: '1.2.14' },
      ],
    })

    await h.service.reconcileAgentAddons('agent-a')

    expect((h.rosters.get('agent-a') ?? []).map((p) => p.name).toSorted()).toEqual([
      '@camstack/addon-agent-ui',
      '@camstack/addon-ai',
      '@camstack/addon-pipeline',
      '@camstack/system',
    ])
  })

  it('surfaces a failed install and bounds retries instead of looping forever', async () => {
    const h = makeHarness({
      agentAddons: WIPED_AGENT,
      recorded: { 'agent-a': FULL_ROSTER },
      packFails: new Set(['@camstack/addon-ai']),
    })

    // Reconcile repeatedly — a reconnect flap must not retry unboundedly.
    //
    // Each pass is separated past the delivery grace window: a back-fill that
    // ships bytes marks the node as "hub is writing to it" and the next pass
    // declines while that window is open (see `agent-delivery-ledger.ts`). That
    // gate is not what this test is about, so it is stepped over explicitly
    // rather than left to make the breaker look bounded for the wrong reason.
    vi.useFakeTimers()
    try {
      for (let i = 0; i < MAX_BACKFILL_ATTEMPTS + 3; i++) {
        await h.service.reconcileAgentAddons('agent-a')
        vi.setSystemTime(Date.now() + DELIVERY_GRACE_MS * 2)
      }
    } finally {
      vi.useRealTimers()
    }

    const aiAttempts = h.spies.recordPackages.mock.calls.length // sanity: reconcile ran each pass
    expect(aiAttempts).toBe(MAX_BACKFILL_ATTEMPTS + 3)

    const failures = h.service.getBackfillFailures('agent-a')
    expect(failures.map((f) => f.name)).toContain('@camstack/addon-ai')
    expect(failures.find((f) => f.name === '@camstack/addon-ai')?.attempts).toBe(
      MAX_BACKFILL_ATTEMPTS,
    )
    // The healthy sibling still gets delivered every pass it is missing.
    expect(h.deployed).toContain('@camstack/addon-post-analysis')
  })

  it("does not undo an operator's deliberate undeploy", async () => {
    const h = makeHarness({
      agentAddons: [
        ...WIPED_AGENT,
        { id: 'llm', packageName: '@camstack/addon-ai', version: '1.2.14' },
        {
          id: 'embedding-encoder',
          packageName: '@camstack/addon-post-analysis',
          version: '1.2.14',
        },
      ],
      recorded: { 'agent-a': FULL_ROSTER },
    })

    // Operator removes post-analysis from this node only.
    await h.service.noteAddonUndeployed('agent-a', 'embedding-encoder')

    // The node reconnects reporting it no longer runs post-analysis.
    const h2 = makeHarness({
      agentAddons: [
        ...WIPED_AGENT,
        { id: 'llm', packageName: '@camstack/addon-ai', version: '1.2.14' },
      ],
      recorded: { 'agent-a': h.rosters.get('agent-a') ?? [] },
    })
    await h2.service.reconcileAgentAddons('agent-a')

    expect(h2.deployed).toEqual([])
  })

  it('does not double-install when two reconciles race', async () => {
    const h = makeHarness({
      agentAddons: WIPED_AGENT,
      recorded: { 'agent-a': FULL_ROSTER },
      deployDelayMs: 20,
    })

    await Promise.all([
      h.service.reconcileAgentAddons('agent-a'),
      h.service.reconcileAgentAddons('agent-a'),
    ])

    expect(h.deployed).toEqual(['@camstack/addon-ai', '@camstack/addon-post-analysis'])
  })

  it('back-fills nothing when $agent.status is malformed (fail closed)', async () => {
    const broker = {
      call: vi.fn(async (action: string) =>
        action === '$agent.status' ? { addons: null } : undefined,
      ),
      waitForServices: vi.fn(async () => undefined),
      localBus: { on: vi.fn() },
    }
    const service = new AgentRegistryService(
      { emit: vi.fn() } as unknown as EventBusService,
      { broker } as unknown as MoleculerService,
      {} as unknown as CapabilityService,
    )
    service.setAddonRegistry({ listAddons: () => HUB_ROWS } as unknown as AddonRegistryService)
    const { store } = makeStore({ 'agent-a': FULL_ROSTER })
    service.setClusterNodeHistoryStore(store)
    const deployed: string[] = []
    service.setAddonBackfill({
      pack: async () => Buffer.from('tgz'),
      deploy: async (_n, name) => {
        deployed.push(name)
      },
      reload: async () => undefined,
    })

    await service.reconcileAgentAddons('agent-a')

    expect(deployed).toEqual([])
  })

  it('is inert when no back-fill seam is wired', async () => {
    const h = makeHarness({
      agentAddons: WIPED_AGENT,
      recorded: { 'agent-a': FULL_ROSTER },
    })
    h.service.setAddonBackfill(null)

    await expect(h.service.reconcileAgentAddons('agent-a')).resolves.toBeUndefined()
    expect(h.deployed).toEqual([])
  })
})
