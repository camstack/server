/**
 * D791 — benchmark mode end to end on the real orchestrator with fake
 * runners: a camera PINNED to the node under test and one merely placed on
 * it both leave for the other node while the run measures; the pin is never
 * rewritten; when the run ends the pinned camera is back on its node and the
 * mode is off. The measurement is driven on the chosen node's runner,
 * whichever node the request came from.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import {
  type FakeRunner,
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  makeRunnerCameraConfig,
  wireRunnerToBroker,
} from './e2e-helpers.js'

class TestOrchestrator extends PipelineOrchestratorAddon {
  protected override nodeBenchmarkPollMs = 10
  modeNode(): string | null {
    return this.nodeBenchmark?.modeNodeId() ?? null
  }
}

describe('node benchmark mode (D791) — e2e', () => {
  let addon: TestOrchestrator | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  async function boot(): Promise<{ addon: TestOrchestrator; a: FakeRunner; b: FakeRunner }> {
    const broker = makeFakeBroker('hub')
    const a = makeFakeRunner({ nodeId: 'agent-a' })
    const b = makeFakeRunner({ nodeId: 'agent-b' })
    wireRunnerToBroker(broker, 'agent-a', a)
    wireRunnerToBroker(broker, 'agent-b', b)
    broker.addNode('agent-a')
    broker.addNode('agent-b')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['agent-a', 'agent-b'] },
      providers: {
        'platform-probe': {
          getCapabilities: () => ({
            nodeId: 'agent-a',
            reachable: true,
            devices: [
              {
                key: 'openvino:npu',
                backend: 'openvino',
                device: 'npu',
                format: 'openvino',
                runtime: 'python' as const,
                score: 10,
                available: true,
              },
            ],
          }),
        },
      },
    })
    const o = new TestOrchestrator()
    addon = o
    await o.initialize(ctx)
    await o.setAgentCapabilities({ agentNodeId: 'agent-a', detect: true })
    await o.setAgentCapabilities({ agentNodeId: 'agent-b', detect: true })
    await o.resolveEligibleInferenceDevices('agent-a', 'await-catalog')
    await o.resolveEligibleInferenceDevices('agent-b', 'await-catalog')
    return { addon: o, a, b }
  }

  it('moves a pinned and a placed camera off the node for the run, and puts the pinned one back', async () => {
    const { addon: o, a, b } = await boot()
    a.benchState = 'running'
    await o.assignPipeline({ deviceId: 301, agentNodeId: 'agent-a' })
    await o.dispatchCamera(makeRunnerCameraConfig(301, { detectionMode: 'always-on' }))
    await o.dispatchCamera(makeRunnerCameraConfig(302, { detectionMode: 'always-on' }))
    if (o.getPipelineAssignment({ deviceId: 302 })?.agentNodeId !== 'agent-a') {
      await o.assignPipeline({ deviceId: 302, agentNodeId: 'agent-a' })
      await o.unassignPipeline({ deviceId: 302 })
    }
    expect(o.getPipelineAssignment({ deviceId: 301 })?.agentNodeId).toBe('agent-a')

    const preflight = await o.getNodeBenchmarkPreflight({
      nodeId: 'agent-a',
      devices: [{ deviceKey: 'openvino:npu', modelIds: ['yolov9s-640'] }],
      phases: ['device'],
    })
    expect(preflight.moving.map((c) => c.deviceId)).toContain(301)
    expect(preflight.staying).toEqual([])

    const started = await o.startNodeBenchmark({
      nodeId: 'agent-a',
      devices: [{ deviceKey: 'openvino:npu', modelIds: ['yolov9s-640'] }],
      phases: ['device'],
    })
    expect(started.kind).toBe('started')
    expect(o.modeNode()).toBe('agent-a')

    await vi.waitFor(() => expect(a.benchStarts).toHaveLength(1), { timeout: 5000 })
    // Measuring: nothing of the cluster's runs on the node under test.
    expect(a.attachedCameras.has(301)).toBe(false)
    expect(b.attachedCameras.has(301)).toBe(true)
    expect(o.getPipelineAssignment({ deviceId: 301 })?.agentNodeId).toBe('agent-b')
    expect(b.benchStarts).toEqual([])
    // The stored pin was never rewritten.
    expect((await o.getNodeBenchmarkStatus()).modeNodeId).toBe('agent-a')

    a.benchState = 'done'
    await vi.waitFor(
      async () => expect((await o.getNodeBenchmarkStatus()).run?.state).toBe('done'),
      { timeout: 5000 },
    )
    expect(o.modeNode()).toBeNull()
    await vi.waitFor(
      () => expect(o.getPipelineAssignment({ deviceId: 301 })?.agentNodeId).toBe('agent-a'),
      { timeout: 5000 },
    )
  })

  it('refuses a second run while one is active', async () => {
    const { addon: o, a } = await boot()
    a.benchState = 'running'
    const plan = {
      nodeId: 'agent-a',
      devices: [{ deviceKey: 'openvino:npu', modelIds: ['yolov9s-640'] }],
      phases: ['device' as const],
    }
    expect((await o.startNodeBenchmark(plan)).kind).toBe('started')
    const second = await o.startNodeBenchmark({ ...plan, nodeId: 'agent-b' })
    expect(second.kind).toBe('refused')
    const runId = (await o.getNodeBenchmarkStatus()).run?.runId ?? ''
    expect(await o.abortNodeBenchmark({ runId })).toEqual({ aborted: true })
    await vi.waitFor(
      async () => expect((await o.getNodeBenchmarkStatus()).run?.state).toBe('aborted'),
      { timeout: 5000 },
    )
    expect(o.modeNode()).toBeNull()
  })
})
