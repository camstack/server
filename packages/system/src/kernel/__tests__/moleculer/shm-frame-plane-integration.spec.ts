/**
 * Phase 5 (D9) Task 9 Step 4 — D10 integration coverage for the shared-memory
 * frame plane in the dissolved-`pipeline`-group world.
 *
 * Phase 5 dissolved the `pipeline` co-location group: once decoded frames
 * travel as serialisable shm `FrameHandle`s and audio as chunks over tRPC,
 * the seven former media addons (`decoder-nodeav`, `motion-wasm`,
 * `detection-pipeline`, `pipeline-runner`, `stream-broker`, `audio-codec`,
 * `audio-analyzer`) no longer share a process — each is its own
 * `addon-runner` subprocess. This spec pins the end-state invariants:
 *
 *   1. **Separate runners.** The former pipeline addons each resolve to their
 *      OWN single-addon runner — no `pipeline` runner remains. (Plan-level —
 *      `resolveRunnerId` is the deterministic authority.)
 *
 *   2. **A media-runner crash drops only ITS caps; the cluster recovers.**
 *      A two-runner cluster: a `decoder-nodeav` runner and a `motion-wasm`
 *      runner both register caps with the hub. The decoder runner's broker
 *      stops (a crash) → Moleculer fires `$node.disconnected` → the hub drops
 *      the decoder's caps and ONLY those; the motion runner's caps survive
 *      untouched. A fresh decoder runner then re-registers — the cluster is
 *      whole again. The cluster uses the in-memory `Fake` transporter (the
 *      same one `cluster-setup.ts` / the bulk of the moleculer suite use): it
 *      is process-isolated, so this spec cannot collide with the other
 *      cluster specs running in parallel, and it still fires the real
 *      `$node.disconnected` liveness event on `.stop()`.
 *
 * ## Level honesty
 *
 * The cross-process shm frame flow this file was written next to no longer
 * exists: `@camstack/shm-ring` and its multi-process ring specs were deleted
 * (D763). What stays true, and what this spec covers, is the kernel-side half —
 * the runner topology and the crash → cap-drop wiring — at the same plan-level /
 * TCP-cluster level `addon-runner.spec.ts` uses, deliberately NOT a flaky
 * full multi-process boot.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { ServiceBroker } from 'moleculer'
import { resolveRunnerId, resolveAddonPlacement, isIsolatedBuiltin } from '@camstack/types'
import type { AddonDeclaration, RunnerAddonPlacement, RunnerPlan } from '@camstack/types'
import { HubNodeRegistry } from '../../moleculer/node-registry.js'
import { createHubService } from '../../moleculer/hub-service.js'
import type { HubServiceDeps } from '../../moleculer/hub-service.js'

// ---------------------------------------------------------------------------
// Part 1 — runner topology: the former pipeline media addons are separate
// ---------------------------------------------------------------------------
//
// Re-derivation of `AddonRegistryService.buildAddonGroupPlan` — the same
// faithful mirror `addon-runner.spec.ts` uses. The plan keys every surviving
// addon by `resolveRunnerId`; a groupless addon keys to its own id.

interface PlanAddonEntry {
  readonly addonId: string
  readonly addonDir: string
  readonly packageName: string
  readonly declaration: Pick<AddonDeclaration, 'execution'>
}

function deriveRunnerPlan(entries: readonly PlanAddonEntry[]): RunnerPlan {
  const plan = new Map<string, RunnerAddonPlacement[]>()
  for (const entry of entries) {
    if (entry.packageName === '@camstack/system' && !isIsolatedBuiltin(entry.declaration)) continue
    if (resolveAddonPlacement(entry.declaration) === 'agent-only') continue
    const runnerId = resolveRunnerId(entry.declaration, entry.addonId)
    const bucket = plan.get(runnerId) ?? []
    bucket.push({ addonId: entry.addonId, addonDir: entry.addonDir })
    plan.set(runnerId, bucket)
  }
  return plan
}

/** A groupless media addon entry (the Phase-5 end state — no `execution.group`). */
function mediaAddon(addonId: string): PlanAddonEntry {
  return {
    addonId,
    addonDir: `/opt/addons/${addonId}`,
    packageName: '@camstack/addon-pipeline',
    declaration: { execution: { group: undefined, placement: 'any-node' } },
  }
}

describe('D9 frame plane — runner topology (the pipeline group is dissolved)', () => {
  it('the decoder, motion and detection addons each get their own runner — frames cross via shm, not co-location', () => {
    // The three addons on the shm frame path: decoder writes the ring,
    // motion + detection read it. Phase 5 made all three groupless.
    const plan = deriveRunnerPlan([
      mediaAddon('decoder-nodeav'),
      mediaAddon('motion-wasm'),
      mediaAddon('detection-pipeline'),
    ])
    // Three groupless addons → three distinct single-addon runners.
    expect([...plan.keys()].toSorted()).toEqual([
      'decoder-nodeav',
      'detection-pipeline',
      'motion-wasm',
    ])
    for (const [runnerId, addons] of plan) {
      expect(addons).toHaveLength(1)
      expect(addons[0]!.addonId).toBe(runnerId)
    }
    // No co-location runner — the `pipeline` group no longer exists.
    expect(plan.has('pipeline')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Part 2 — a media-runner crash drops only its caps; the cluster recovers
// ---------------------------------------------------------------------------

function getAvailableNodeIds(broker: ServiceBroker): readonly string[] {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double: reach Moleculer's internal registry
  const registry = (broker as unknown as Record<string, unknown>).registry as
    | { getNodeList: (opts: Record<string, boolean>) => readonly { id: string }[] }
    | undefined
  return (registry?.getNodeList?.({ onlyAvailable: true }) ?? []).map((n) => n.id)
}

async function waitFor(condition: () => boolean, timeout = 8000, interval = 50): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error(`waitFor timed out after ${timeout}ms`)
    await new Promise((r) => setTimeout(r, interval))
  }
}

describe('D9 frame plane — a media-runner crash drops only its caps', { timeout: 40000 }, () => {
  const brokers: ServiceBroker[] = []

  afterEach(async () => {
    for (const b of [...brokers].toReversed()) {
      try {
        await b.stop()
      } catch {
        /* already stopped */
      }
    }
    brokers.length = 0
  })

  /** Spawn a runner broker on the in-memory `Fake` transporter. */
  function spawnRunner(nodeId: string): ServiceBroker {
    const broker = new ServiceBroker({ nodeID: nodeId, transporter: 'Fake', logger: false })
    brokers.push(broker)
    return broker
  }

  it('the decoder runner crashes → its caps drop, the motion runner is untouched, a fresh decoder recovers the cluster', async () => {
    // HubNodeRegistry is the single cap authority. Wire it to the hub
    // service's registration handshake and to `$node.disconnected`.
    const nodeRegistry = new HubNodeRegistry()
    const hubDeps: HubServiceDeps = {
      getAddonConfig: (addonId) => ({ addonId }),
      getSettings: () => ({}),
      getRecentEvents: () => [],
      onLog: () => {},
      onRegisterNode: (params) => {
        nodeRegistry.registerNode(params)
      },
      onUnregisterNode: (nodeId) => {
        nodeRegistry.removeNode(nodeId)
      },
    }

    const hub = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    brokers.push(hub)
    hub.createService(createHubService(hubDeps))
    // Production wiring: the hub mirrors `$node.disconnected` onto the
    // registry — exactly what `moleculer.service.ts` does.
    hub.localBus.on('$node.disconnected', ({ node }: { node: { id: string } }) => {
      nodeRegistry.removeNode(node.id)
    })
    await hub.start()

    // Two media runners, each its OWN process — modelled as a sibling broker
    // whose nodeID follows the `hub/<runnerId>` convention.
    const decoderRunner = spawnRunner('hub/decoder-nodeav')
    await decoderRunner.start()
    const motionRunner = spawnRunner('hub/motion-wasm')
    await motionRunner.start()

    await waitFor(() => {
      const ids = getAvailableNodeIds(hub)
      return ids.includes('hub/decoder-nodeav') && ids.includes('hub/motion-wasm')
    })
    await decoderRunner.waitForServices(['$hub'], 8000)
    await motionRunner.waitForServices(['$hub'], 8000)

    // Both runners complete their boot handshake — register their caps.
    await decoderRunner.call('$hub.registerNode', {
      nodeId: 'hub/decoder-nodeav',
      addons: [{ addonId: 'decoder-nodeav', capabilities: ['decoder'] }],
    })
    await motionRunner.call('$hub.registerNode', {
      nodeId: 'hub/motion-wasm',
      addons: [{ addonId: 'motion-wasm', capabilities: ['motion-detection'] }],
    })

    // The hub holds both runners' caps.
    expect(sortedCaps(nodeRegistry)).toEqual(['decoder', 'motion-detection'])

    // The decoder runner crashes — stop its broker. Moleculer fires
    // `$node.disconnected` on the hub. No timer, no scan.
    await decoderRunner.stop()
    brokers.splice(brokers.indexOf(decoderRunner), 1)

    await waitFor(() => !getAvailableNodeIds(hub).includes('hub/decoder-nodeav'))
    await waitFor(() => nodeRegistry.getNodeManifest('hub/decoder-nodeav') === undefined)

    // ONLY the decoder's caps dropped — the motion runner is untouched, a
    // crash in one media runner does not cascade to its siblings.
    expect(sortedCaps(nodeRegistry)).toEqual(['motion-detection'])
    expect(nodeRegistry.getNodeManifest('hub/motion-wasm')).toBeDefined()

    // The cluster recovers: a fresh decoder runner re-registers — exactly
    // what `CrashSupervisor` respawning a crashed runner achieves.
    const decoderRunner2 = spawnRunner('hub/decoder-nodeav')
    await decoderRunner2.start()
    await waitFor(() => getAvailableNodeIds(hub).includes('hub/decoder-nodeav'))
    await decoderRunner2.waitForServices(['$hub'], 8000)
    await decoderRunner2.call('$hub.registerNode', {
      nodeId: 'hub/decoder-nodeav',
      addons: [{ addonId: 'decoder-nodeav', capabilities: ['decoder'] }],
    })

    // The cluster is whole again — both caps present.
    expect(sortedCaps(nodeRegistry)).toEqual(['decoder', 'motion-detection'])
  })
})

/** Every cap name the registry currently holds, sorted — a stable assertion. */
function sortedCaps(registry: HubNodeRegistry): string[] {
  return [...new Set(registry.listEntries().map((e) => e.capName))].toSorted()
}
