/**
 * D1065 — `resolvePipeline` (the preview the admin UI shows) is what an
 * attach WOULD run: it goes through placement (`previewAttachPipeline`), so it
 * elects a device and reads that device's format, roster and switches. A
 * node-level resolve that bypasses placement judges every step by the node's
 * selected engine instead, and shows a pipeline no attach runs.
 *
 * The node here defaults to the Coral's engine (tflite) but only its GPU is
 * eligible: face-detection has an openvino build and no tflite one, so the
 * preview shows it only when it went through the election.
 */
import type { PipelineStepInputOutput } from '@dominevo/types'
import { afterEach, describe, expect, it } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import { CORAL_GPU_CATALOG, GPU } from './attach-pipeline-fixtures.js'
import {
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  wireRunnerToBroker,
} from './e2e-helpers.js'

const NODE = 'agent-a'
const DEVICE_ID = 77

function childIds(steps: readonly PipelineStepInputOutput[]): readonly string[] {
  return (steps.find((s) => s.addonId === 'object-detection')?.children ?? []).map((c) => c.addonId)
}

describe('resolvePipeline previews through placement (D1065)', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  async function boot(): Promise<PipelineOrchestratorAddon> {
    const broker = makeFakeBroker('hub')
    wireRunnerToBroker(broker, NODE, makeFakeRunner({ nodeId: NODE }))
    broker.addNode(NODE)
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: [NODE] },
      providers: {
        'pipeline-executor': { getSchema: async () => CORAL_GPU_CATALOG },
        'platform-probe': {
          getCapabilities: () => ({
            nodeId: NODE,
            reachable: true,
            devices: [
              {
                key: GPU,
                backend: 'openvino',
                device: 'gpu',
                format: 'openvino',
                runtime: 'python',
                score: 1,
                available: true,
              },
            ],
          }),
        },
      },
    })
    const booted = new PipelineOrchestratorAddon()
    await booted.initialize(ctx)
    await booted.setAgentInferenceDevices({
      agentNodeId: NODE,
      inferenceDevices: { [GPU]: { enabled: true } },
    })
    await booted.setCameraStepToggle({
      deviceId: DEVICE_ID,
      addonId: 'face-detection',
      enabled: true,
    })
    return booted
  }

  it("shows the elected device's steps, and that device's switches", async () => {
    addon = await boot()
    const preview = await addon.resolvePipeline({ deviceId: DEVICE_ID, agentNodeId: NODE })
    // The GPU was elected: face-detection runs there.
    expect(childIds(preview.steps)).toContain('face-detection')

    await addon.setDeviceStepEnabled({
      agentNodeId: NODE,
      deviceKey: GPU,
      stepId: 'face-detection',
      enabled: false,
    })
    const switched = await addon.resolvePipeline({ deviceId: DEVICE_ID, agentNodeId: NODE })
    expect(childIds(switched.steps)).not.toContain('face-detection')
  })
})
