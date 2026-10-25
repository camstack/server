/**
 * Rebalance enforces per-node `maxCameras` via a RUNNING tally.
 *
 * `rebalance()` snapshots `collectAgentLoad()` ONCE, then loops over every
 * camera calling `balance()` with that same static snapshot. Before the fix
 * it never accounted for the assignments it made WITHIN the pass, so the cap
 * check (`attachedCameras < maxCameras`) and the L2 capacity score
 * (`attachedCameras * avgInferenceFps`) were evaluated against pre-rebalance
 * counts for EVERY camera — a node capped at 1 (snapshot: 0 attached) passed
 * the eligibility check for every camera in the pass and, being the
 * least-loaded, won them ALL. With the fix, each (re)assignment updates a
 * per-node delta over the snapshot: +1 on the target for a new attachment,
 * -1 old / +1 new on a migration, no change for a camera that stays put
 * (it is already counted in the snapshot).
 *
 * The per-camera `dispatchCamera` path is NOT affected (it re-collects live
 * load per call) — covered by `agent-maxcameras-dispatch.spec.ts` (T3).
 */
import { afterEach, describe, expect, it } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import type { PendingReason } from '../placement-ledger.js'
import {
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  makeRunnerCameraConfig,
  wireRunnerToBroker,
} from './e2e-helpers.js'

/** Test subclass exposing the protected `pendingReasons` seam. */
class TestOrchestrator extends PipelineOrchestratorAddon {
  peekPendingReason(deviceId: number): PendingReason | undefined {
    return this.ledger?.getPendingReason(deviceId)
  }
}

/** Count assignments per node for the given device ids. */
function countByNode(
  addon: PipelineOrchestratorAddon,
  deviceIds: readonly number[],
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const deviceId of deviceIds) {
    const nodeId = addon.getPipelineAssignment({ deviceId })?.agentNodeId
    if (nodeId) counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1)
  }
  return counts
}

describe('PipelineOrchestratorAddon — rebalance enforces maxCameras (running tally)', () => {
  let addon: TestOrchestrator

  afterEach(async () => {
    if (addon) await addon.shutdown()
  })

  it('spreads pending cameras across a capped node (max 1) and an unlimited node — not all on the capped one', async () => {
    const broker = makeFakeBroker('hub')
    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    const runnerB = makeFakeRunner({ nodeId: 'agent-b' })
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    wireRunnerToBroker(broker, 'agent-b', runnerB)
    broker.addNode('agent-a')
    broker.addNode('agent-b')

    // Only agent-a starts detect-enabled and its cap is ALREADY full, so
    // every dispatch goes pending(over-cap) — the cameras become known
    // (cameraConfigs) but unassigned, which is exactly the state a later
    // `rebalance()` pass has to place in one batch. (The old seed used an
    // empty decoder list; `no-frame-source` is unreachable now that decode
    // is co-located with detection.)
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: ['agent-a'],
      },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    // Operator caps agent-a at ONE camera; agent-b stays unlimited.
    await addon.setAgentMaxCameras({ agentNodeId: 'agent-a', maxCameras: 1 })
    // Fill agent-a's single slot so the batch below all goes pending.
    const seeded = await addon.dispatchCamera(makeRunnerCameraConfig(100))
    expect(seeded.kind).toBe('assigned')

    for (const deviceId of [101, 102, 103]) {
      const result = await addon.dispatchCamera(makeRunnerCameraConfig(deviceId))
      expect(result.kind).toBe('pending')
    }

    // agent-b becomes detect-enabled → the batch pass can now place them.
    await addon.setAgentCapabilities({ agentNodeId: 'agent-b', detect: true })
    // D650 round 3: a re-place elects against the node's LAST ANSWERED device
    // probe and never waits for one; the dispatcher's own reads (a first
    // placement, the session refresher) are what warm it in production.
    await addon.resolveEligibleInferenceDevices('agent-b', 'await-catalog')
    await addon.rebalance()

    // Without the running tally every balance() call saw the nodes at their
    // snapshot counts for the whole pass. With the fix agent-a stays at its
    // cap (exactly 1) and agent-b takes the batch.
    const counts = countByNode(addon, [100, 101, 102, 103])
    expect(counts.get('agent-a') ?? 0).toBe(1)
    expect(counts.get('agent-b') ?? 0).toBe(3)
    expect(runnerA.attachedCameras.size).toBe(1)
    expect(runnerB.attachedCameras.size).toBe(3)
  })

  it('assigns exactly 1 of 3 cameras to a single capped node and leaves the rest pending(over-cap)', async () => {
    const broker = makeFakeBroker('hub')
    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    broker.addNode('agent-a')

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: ['agent-a'],
      },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    await addon.setAgentMaxCameras({ agentNodeId: 'agent-a', maxCameras: 1 })

    // First dispatch fills the single slot; the rest go pending(over-cap).
    for (const deviceId of [201, 202, 203]) {
      await addon.dispatchCamera(makeRunnerCameraConfig(deviceId))
    }

    await addon.rebalance()

    // ONE camera fills the only slot; the other two must be left pending
    // with reason 'over-cap' — never attached beyond the cap.
    expect(runnerA.attachedCameras.size).toBe(1)
    const assigned = [201, 202, 203].filter(
      (deviceId) => addon.getPipelineAssignment({ deviceId }) !== null,
    )
    const pending = [201, 202, 203].filter(
      (deviceId) => addon.getPipelineAssignment({ deviceId }) === null,
    )
    expect(assigned).toHaveLength(1)
    expect(pending).toHaveLength(2)
    for (const deviceId of pending) {
      expect(addon.peekPendingReason(deviceId)).toBe('over-cap')
    }
  })

  it('a migration off a capped node frees its slot for a later camera in the same pass', async () => {
    const broker = makeFakeBroker('hub')
    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    const runnerB = makeFakeRunner({ nodeId: 'agent-b' })
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    wireRunnerToBroker(broker, 'agent-b', runnerB)
    broker.addNode('agent-a')
    broker.addNode('agent-b')

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: ['agent-a', 'agent-b'],
      },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    await addon.setAgentMaxCameras({ agentNodeId: 'agent-a', maxCameras: 1 })

    // Live dispatch (correct path) fills agent-a to its cap, rest on agent-b.
    await addon.dispatchCamera(makeRunnerCameraConfig(301)) // → agent-a (tie, first)
    await addon.dispatchCamera(makeRunnerCameraConfig(302)) // agent-a at cap → agent-b
    await addon.dispatchCamera(makeRunnerCameraConfig(303)) // → agent-b
    expect(runnerA.attachedCameras.size).toBe(1)
    expect(runnerB.attachedCameras.size).toBe(2)

    await addon.rebalance()

    // The pass may shuffle WHICH camera holds agent-a's single slot, but the
    // running tally must keep the invariant: a migration off agent-a
    // decrements its tally (slot reusable within the pass), every attachment
    // increments the target — the capped node ends with EXACTLY one camera
    // and nothing is dropped. Without the decrement/increment accounting the
    // stale snapshot marked agent-a at-cap for the whole pass and it ended
    // with zero cameras.
    const counts = countByNode(addon, [301, 302, 303])
    expect(counts.get('agent-a') ?? 0).toBe(1)
    expect(counts.get('agent-b') ?? 0).toBe(2)
    expect(runnerA.attachedCameras.size).toBe(1)
    expect(runnerB.attachedCameras.size).toBe(2)
  })
})

describe('PipelineOrchestratorAddon — auto-rebalance hysteresis (no churn on a balanced cluster)', () => {
  let addon: TestOrchestrator

  afterEach(async () => {
    if (addon) await addon.shutdown()
  })

  it('leaves a within-1 balanced 2/1 split untouched under the hysteresis margin', async () => {
    const broker = makeFakeBroker('hub')
    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    const runnerB = makeFakeRunner({ nodeId: 'agent-b' })
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    wireRunnerToBroker(broker, 'agent-b', runnerB)
    broker.addNode('agent-a')
    broker.addNode('agent-b')

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: ['agent-a', 'agent-b'],
      },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    // Two equal-weight nodes, 3 cameras → live dispatch yields a 2/1 split
    // (balanced within a single camera).
    for (const deviceId of [401, 402, 403]) {
      await addon.dispatchCamera(makeRunnerCameraConfig(deviceId))
    }
    const before = countByNode(addon, [401, 402, 403])
    expect([before.get('agent-a') ?? 0, before.get('agent-b') ?? 0].toSorted()).toEqual([1, 2])

    // A margin-1.5 pass (what the periodic auto-rebalance uses) must NOT move
    // anything: equalizing the 1-camera gap would only reverse it.
    const auto = await addon.rebalance({ minImprovement: 1.5 })
    expect(auto.migrated).toBe(0)
    const after = countByNode(addon, [401, 402, 403])
    expect(after).toEqual(before)
  })

  it('DOES migrate under hysteresis when a node is meaningfully overloaded (3/0 → 2/1)', async () => {
    const broker = makeFakeBroker('hub')
    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    const runnerB = makeFakeRunner({ nodeId: 'agent-b' })
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    wireRunnerToBroker(broker, 'agent-b', runnerB)
    broker.addNode('agent-a')
    broker.addNode('agent-b')

    // agent-b starts NOT detect-enabled so all 3 cameras pile on agent-a;
    // then enable agent-b and let the margin pass correct the 3/0 imbalance.
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: ['agent-a'],
      },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    for (const deviceId of [501, 502, 503]) {
      await addon.dispatchCamera(makeRunnerCameraConfig(deviceId))
    }
    expect(runnerA.attachedCameras.size).toBe(3)
    expect(runnerB.attachedCameras.size).toBe(0)

    await addon.setAgentCapabilities({ agentNodeId: 'agent-b', detect: true })

    // 3/0 gap (improvement 3 ≥ 1.5) → at least one camera migrates to agent-b;
    // the pass stops once the gap drops below the margin (settles at 2/1).
    const auto = await addon.rebalance({ minImprovement: 1.5 })
    expect(auto.migrated).toBeGreaterThan(0)
    expect(runnerB.attachedCameras.size).toBe(1)
    expect(runnerA.attachedCameras.size).toBe(2)
  })
})
