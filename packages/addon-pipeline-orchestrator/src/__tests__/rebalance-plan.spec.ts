/**
 * `rebalance({ dryRun: true })` is the PLAN of the same loop `rebalance()` acts
 * with: it reports the moves without attaching or detaching anything, and the
 * moves it lists are the ones the real pass then makes.
 */
import { afterEach, describe, expect, it } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import {
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  makeRunnerCameraConfig,
  wireRunnerToBroker,
} from './e2e-helpers.js'

describe('rebalance dry-run planner', () => {
  let addon: PipelineOrchestratorAddon

  afterEach(async () => {
    if (addon) await addon.shutdown()
  })

  async function seedSkewedCluster() {
    const broker = makeFakeBroker('hub')
    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    const runnerB = makeFakeRunner({ nodeId: 'agent-b' })
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    wireRunnerToBroker(broker, 'agent-b', runnerB)
    broker.addNode('agent-a')
    broker.addNode('agent-b')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['agent-a'] },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)
    for (const deviceId of [100, 101, 102]) {
      const r = await addon.dispatchCamera(makeRunnerCameraConfig(deviceId))
      expect(r.kind).toBe('assigned')
    }
    await addon.setAgentCapabilities({ agentNodeId: 'agent-b', detect: true })
    await addon.resolveEligibleInferenceDevices('agent-b', 'await-catalog')
    return { runnerA, runnerB }
  }

  it('lists the moves without attaching or detaching anything', async () => {
    const { runnerA, runnerB } = await seedSkewedCluster()
    const plan = await addon.rebalance({ minImprovement: 0, dryRun: true })
    expect(plan.moves.length).toBeGreaterThan(0)
    expect(plan.moves.every((m) => m.fromNodeId === 'agent-a' && m.toNodeId === 'agent-b')).toBe(
      true,
    )
    expect(plan.migrated).toBe(0)
    expect(runnerA.attachedCameras.size).toBe(3)
    expect(runnerB.attachedCameras.size).toBe(0)
  })

  it('the act makes exactly the moves the plan listed', async () => {
    const { runnerB } = await seedSkewedCluster()
    const plan = await addon.rebalance({ minImprovement: 0, dryRun: true })
    const act = await addon.rebalance({ minImprovement: 0 })
    expect(act.moves).toEqual(plan.moves)
    expect(runnerB.attachedCameras.size).toBe(plan.moves.length)
  })

  it('the auto-sweep margin plans no more moves than a manual rebalance', async () => {
    await seedSkewedCluster()
    const manual = await addon.rebalance({ minImprovement: 0, dryRun: true })
    const sweep = await addon.rebalance({ minImprovement: 1.5, dryRun: true })
    expect(sweep.moves.length).toBeLessThanOrEqual(manual.moves.length)
  })
})
