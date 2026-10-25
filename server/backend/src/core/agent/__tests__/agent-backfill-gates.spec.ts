import { describe, expect, it, vi } from 'vitest'
import type { AddonRegistryService } from '../../addon/addon-registry.service'
import type { CapabilityService } from '../../capability/capability.service'
import type { EventBusService } from '../../events/event-bus.service'
import type { MoleculerService } from '../../moleculer/moleculer.service'
import { type NodePackageEntry } from '../agent-addon-backfill'
import { DELIVERY_GRACE_MS } from '../agent-delivery-ledger'
import { AgentRegistryService } from '../agent-registry.service'
import type { ClusterNodeHistoryStore } from '../cluster-node-history-store'

/**
 * The three gates that stop the back-fill reacting to a roster gap the HUB
 * caused.
 *
 * Evidence these exist for (2026-08-07, live hub): every
 * `camstack deploy <pkg> -n agent-a` landed the correct bytes and ~1.5s
 * later the node held a different build under the same version. `$agent.deploy`
 * evicts the package's declaration ids, `$agent.reload` re-registers the node,
 * the reconcile reads the emptied roster and "repairs" the node over the bytes
 * just shipped. Making the pack read the hub's installed copy made the damage
 * invisible; it did not remove the trigger. These tests remove the trigger.
 */

interface HubAddonRow {
  readonly manifest: {
    readonly id: string
    readonly packageName: string
    readonly packageVersion: string
  }
  readonly declaration: {
    readonly id: string
    readonly execution: { readonly placement: string }
  }
}

const HUB_ROWS: readonly HubAddonRow[] = [
  {
    manifest: {
      id: 'recorder',
      packageName: '@camstack/addon-pipeline',
      packageVersion: '1.2.43',
    },
    declaration: { id: 'recorder', execution: { placement: 'any-node' } },
  },
  {
    manifest: {
      id: 'llm',
      packageName: '@camstack/addon-ai',
      packageVersion: '1.2.43',
    },
    declaration: { id: 'llm', execution: { placement: 'any-node' } },
  },
]

const RECORDED: readonly NodePackageEntry[] = [
  { name: '@camstack/addon-pipeline', version: '1.2.43' },
  { name: '@camstack/addon-ai', version: '1.2.43' },
]

/** The node reports @camstack/addon-ai and NOT @camstack/addon-pipeline. */
const ROSTER_MISSING_PIPELINE = [
  { id: 'llm', packageName: '@camstack/addon-ai', version: '1.2.43' },
]
/** The node reports both — nothing is missing. */
const ROSTER_COMPLETE = [
  { id: 'llm', packageName: '@camstack/addon-ai', version: '1.2.43' },
  {
    id: 'recorder',
    packageName: '@camstack/addon-pipeline',
    version: '1.2.43',
  },
]

function makeStore(seed: readonly NodePackageEntry[]) {
  const rosters = new Map<string, NodePackageEntry[]>([['agent-a', [...seed]]])
  const store = {
    getPackages: vi.fn(async (nodeId: string) => rosters.get(nodeId) ?? []),
    recordPackages: vi.fn(async (nodeId: string, packages: readonly NodePackageEntry[]) => {
      const merged = new Map((rosters.get(nodeId) ?? []).map((p) => [p.name, p]))
      for (const p of packages) merged.set(p.name, p)
      rosters.set(nodeId, [...merged.values()])
    }),
    prunePackages: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => undefined),
    touch: vi.fn(async () => undefined),
    tryGetAll: vi.fn(async () => []),
    forget: vi.fn(async () => undefined),
  }
  return store as unknown as ClusterNodeHistoryStore
}

interface HarnessOptions {
  /** One roster per `$agent.status` call, in order. The last one repeats. */
  readonly statusReads: ReadonlyArray<
    ReadonlyArray<{ id: string; packageName?: string; version?: string }>
  >
  /** 1-based `$agent.status` call number from which the RPC throws. */
  readonly statusThrowsFromCall?: number
}

function makeHarness(opts: HarnessOptions) {
  const deployed: string[] = []
  let statusCalls = 0

  const broker = {
    call: vi.fn(async (action: string) => {
      if (action === '$agent.status') {
        const idx = Math.min(statusCalls, opts.statusReads.length - 1)
        statusCalls += 1
        if (opts.statusThrowsFromCall !== undefined && statusCalls >= opts.statusThrowsFromCall) {
          throw new Error('node went away mid-reconcile')
        }
        return { addons: opts.statusReads[idx] }
      }
      return undefined
    }),
    waitForServices: vi.fn(async () => undefined),
    localBus: { on: vi.fn() },
  }

  const service = new AgentRegistryService(
    { emit: vi.fn() } as unknown as EventBusService,
    { broker } as unknown as MoleculerService,
    {} as unknown as CapabilityService,
  )
  service.setAddonRegistry({
    listAddons: () => HUB_ROWS,
  } as unknown as AddonRegistryService)
  service.setClusterNodeHistoryStore(makeStore(RECORDED))
  service.setAddonBackfill({
    pack: async () => Buffer.from('tgz'),
    deploy: async (_nodeId: string, name: string) => {
      deployed.push(name)
    },
    reload: async () => undefined,
  })

  return { service, deployed, statusCalls: () => statusCalls }
}

describe('back-fill gate — delivery window', () => {
  it('does NOT install while the hub has a delivery in flight to that node', async () => {
    const h = makeHarness({ statusReads: [ROSTER_MISSING_PIPELINE] })

    // A deploy is running: the window is open and never closed.
    h.service.deliveryLedger.begin('agent-a', '@camstack/addon-pipeline')

    await h.service.reconcileAgentAddons('agent-a', 'node-registration')

    expect(h.deployed).toEqual([])
  })

  it('does NOT install in the grace tail after a delivery finishes', async () => {
    const h = makeHarness({ statusReads: [ROSTER_MISSING_PIPELINE] })

    // The reload's re-registrations land AFTER $agent.reload returns — this is
    // the window the storm arrives in.
    const close = h.service.deliveryLedger.begin('agent-a', '@camstack/addon-pipeline')
    close()

    await h.service.reconcileAgentAddons('agent-a', 'node-registration')

    expect(h.deployed).toEqual([])
  })

  it('installs once the grace tail has elapsed — the gate is a window, not an off switch', async () => {
    const h = makeHarness({ statusReads: [ROSTER_MISSING_PIPELINE] })

    // A delivery that finished well over a grace period ago.
    const longAgo = Date.now() - DELIVERY_GRACE_MS * 2
    h.service.deliveryLedger.begin('agent-a', '@camstack/addon-pipeline', () => longAgo)()

    await h.service.reconcileAgentAddons('agent-a', 'node-registration')

    expect(h.deployed).toEqual(['@camstack/addon-pipeline'])
  })
})

describe('back-fill gate — confirmation read (D49)', () => {
  it('does NOT install when a second roster read reports the package present', async () => {
    // First read: mid-reload, pipeline missing. Second read: it is back.
    const h = makeHarness({
      statusReads: [ROSTER_MISSING_PIPELINE, ROSTER_COMPLETE],
    })

    await h.service.reconcileAgentAddons('agent-a', 'node-registration')

    expect(h.deployed).toEqual([])
    // The second read must actually have happened — a gate nothing calls is
    // indistinguishable from no gate.
    expect(h.statusCalls()).toBe(2)
  })

  it('installs when BOTH reads agree the package is missing', async () => {
    const h = makeHarness({
      statusReads: [ROSTER_MISSING_PIPELINE, ROSTER_MISSING_PIPELINE],
    })

    await h.service.reconcileAgentAddons('agent-a', 'node-registration')

    expect(h.deployed).toEqual(['@camstack/addon-pipeline'])
  })

  it('fails CLOSED when the confirmation read cannot be taken', async () => {
    // The first read said "install this". A read that FAILS must never be
    // allowed to look like agreement — that is how a transport blip becomes an
    // overwrite of a freshly deployed bundle.
    const h = makeHarness({
      statusReads: [ROSTER_MISSING_PIPELINE],
      statusThrowsFromCall: 2,
    })

    await h.service.reconcileAgentAddons('agent-a', 'node-registration')

    expect(h.deployed).toEqual([])
    expect(h.statusCalls()).toBe(2)
  })
})

describe('back-fill gate — trigger allowlist', () => {
  it('an inspect-only pass never installs', async () => {
    const h = makeHarness({ statusReads: [ROSTER_MISSING_PIPELINE] })

    await h.service.reconcileAgentAddons('agent-a', 'inspect-only')

    expect(h.deployed).toEqual([])
  })

  it('operator repair installs — it is the explicit escape hatch', async () => {
    const h = makeHarness({ statusReads: [ROSTER_MISSING_PIPELINE] })

    await h.service.repairNodeAddons('agent-a')

    expect(h.deployed).toEqual(['@camstack/addon-pipeline'])
  })
})
