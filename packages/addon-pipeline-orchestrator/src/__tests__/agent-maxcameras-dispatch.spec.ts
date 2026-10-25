/**
 * T3 — per-node `maxCameras` is actually ENFORCED at dispatch.
 *
 * The balancer alone (see `load-balancer.spec.ts`) honours a `nodeCaps` map;
 * this suite proves the ORCHESTRATOR actually FEEDS it the operator-set caps.
 *
 * Regression guard for the `buildNodeCaps()` bug: it read the async
 * `agentSettingsState.get()` WITHOUT awaiting, so `Object.entries(<Promise>)`
 * was always `[]`, `nodeCaps` was always empty, and the per-node `maxCameras`
 * ceiling was silently ignored — the cluster/per-node max-cameras UI was a
 * no-op. With the fix, a node capped at 1 that already holds one camera must
 * reject a second dispatch as pending(`over-cap`), never assign it.
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

describe('PipelineOrchestratorAddon — maxCameras enforced at dispatch (T3)', () => {
  let addon: TestOrchestrator

  afterEach(async () => {
    if (addon) await addon.shutdown()
  })

  it('a second camera dispatched to a node already at its maxCameras cap goes pending(over-cap)', async () => {
    const broker = makeFakeBroker('hub')

    // hub — the only node, decoder-eligible, capped at 1 camera.
    const hubRunner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', hubRunner)

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: ['hub'],
        // T2 eligibility: a detection node must also be a decoder node.
        enabledDecoderNodes: ['hub'],
      },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    // Operator sets a hard ceiling of ONE camera on the hub.
    await addon.setAgentMaxCameras({ agentNodeId: 'hub', maxCameras: 1 })

    // First camera lands on the hub (0 → 1, at cap).
    await addon.dispatchCamera(makeRunnerCameraConfig(104))
    expect(addon.getPipelineAssignment({ deviceId: 104 })?.agentNodeId).toBe('hub')
    expect(hubRunner.attachedCameras.has(104)).toBe(true)

    // Second camera: the hub is at its cap and is the only eligible node, so it
    // MUST be left pending(over-cap) — NOT assigned. Before the buildNodeCaps
    // await fix, nodeCaps={} and this camera was wrongly assigned to the hub.
    const result = await addon.dispatchCamera(makeRunnerCameraConfig(591))
    expect(result.kind).toBe('pending')
    expect(addon.getPipelineAssignment({ deviceId: 591 })).toBeNull()
    expect(hubRunner.attachedCameras.has(591)).toBe(false)
    expect(addon.peekPendingReason(591)).toBe('over-cap')
  })
})
