/**
 * Regression: a single WEDGED runner node must not wedge the whole cluster.
 *
 * `collectAgentLoad` sweeps every known runner's `getLocalLoad` before
 * `dispatchCamera` can pick a target. A degraded agent (transport up enough
 * to stay in the registry, but whose `broker.call` neither resolves nor
 * rejects — observed live as "[brokerTransportLink] still awaiting … after
 * 18min") makes that per-node await hang forever. The transport link's
 * AbortSignal only tears down the discovery poll, NOT an in-flight
 * `broker.call`, so the sweep — and through it `dispatchCamera` →
 * `startDetection` for EVERY camera — stalls silently with no error.
 *
 * The fix bounds each per-node load query with a timeout: on expiry the node
 * is treated exactly like an offline one (skipped), so dispatch proceeds to
 * the healthy runners.
 */
import { afterEach, describe, expect, it } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import {
  enabledNodesFromBroker,
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  makeRunnerCameraConfig,
  wireRunnerToBroker,
} from './e2e-helpers.js'

describe('PipelineOrchestratorAddon — agent-load resilience', () => {
  let addon: PipelineOrchestratorAddon

  afterEach(async () => {
    if (addon) await addon.shutdown()
  })

  it('skips a wedged runner whose getLocalLoad never settles instead of hanging dispatch', async () => {
    const broker = makeFakeBroker('hub')

    // A healthy runner the camera should land on.
    const idleRunner = makeFakeRunner({ nodeId: 'agent-idle' })
    wireRunnerToBroker(broker, 'agent-idle', idleRunner)
    broker.addNode('agent-idle')

    // A wedged runner: its pipeline-runner service is present (so the call
    // passes discovery), but getLocalLoad never resolves AND never rejects.
    broker.registerService('agent-stuck', 'pipeline-runner')
    broker.registerAction(
      'agent-stuck',
      'pipeline-runner.pipeline-runner.getLocalLoad',
      () =>
        new Promise<never>(() => {
          /* never settles */
        }),
    )
    broker.addNode('agent-stuck')

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: enabledNodesFromBroker(broker),
        // Phase-1 frame-source model: a detection node must also be a decoder
        // node, so mirror the enabled set into the decoder allow-list.
        enabledDecoderNodes: enabledNodesFromBroker(broker),
        // Tiny bound so the wedged node is skipped near-instantly in test.
        agentLoadTimeoutMs: 50,
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    const config = makeRunnerCameraConfig(42, { detectionFps: 4 })
    const result = await addon.dispatchCamera(config)

    expect(result.kind).toBe('assigned')
    if (result.kind !== 'assigned') return // narrow for TS
    expect(result.agentNodeId).toBe('agent-idle')
    expect(idleRunner.attachedCameras.has(42)).toBe(true)
    // Without the timeout, dispatchCamera hangs on agent-stuck and this test
    // trips the per-test deadline below.
  }, 2_000)
})
