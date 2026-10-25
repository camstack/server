/**
 * `pipelineOrchestrator.resetNodePipelineDefaults` — the HONEST per-node
 * reset that replaced the executor's legacy `resetToDefault` (which cleared a
 * dead persisted step-tree seed nothing in the live path read).
 *
 * Asserts, against the real store handlers:
 *   1. every per-(node,device) base `steps` map in the node's
 *      `agentSettings.inferenceDevices` is stripped (each accelerator reverts
 *      to its format default) while enabled/weight survive;
 *   2. a camera's toggles and camera-semantic settings are left alone — a
 *      camera carries no model to clear (D927);
 *   3. the returned `effectiveModelId` is the object-detection default of
 *      the accelerator that would host the camera root on that node, read
 *      from `getNodeInferenceDevices` (a model is chosen by the accelerator
 *      that runs it, D927) — never from an executor-computed node tree;
 *   4. a node with no persisted settings resets idempotently (no-op, still
 *      returns the effective model).
 */
import { afterEach, describe, expect, it } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import { makeFakeBroker, makeFakeContext } from './e2e-helpers.js'

/** `defaultModelIdForDevice('openvino:npu')` — the accelerator's format default. */
const NPU_DEFAULT_MODEL = 'yolov9m-320-int8'

describe('PipelineOrchestrator — resetNodePipelineDefaults', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  async function boot() {
    const broker = makeFakeBroker('hub')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      providers: {
        // Every node but 'agent-gone' reports one NPU: the accelerator whose
        // format default the reset reports as the effective model.
        'platform-probe': {
          getCapabilities: (input?: { readonly nodeId?: string }) => {
            if (input?.nodeId === 'agent-gone') throw new Error('node offline')
            return {
              devices: [
                {
                  key: 'openvino:npu',
                  backend: 'openvino',
                  device: 'npu',
                  format: 'openvino',
                  runtime: 'python',
                  score: 10,
                  available: true,
                },
              ],
            }
          },
        },
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)
    return { ctx }
  }

  it('strips per-(node,device) base steps from the node inferenceDevices and keeps enabled/weight', async () => {
    await boot()

    await addon!.setAgentInferenceDevices({
      agentNodeId: 'hub',
      inferenceDevices: {
        'openvino:npu': {
          enabled: true,
          weight: 2,
          steps: {
            'object-detection': { modelId: 'yolo26s-int8', settings: { minConfidence: 0.4 } },
          },
        },
        'openvino:gpu': { enabled: false },
      },
    })

    const result = await addon!.resetNodePipelineDefaults({ agentNodeId: 'hub' })
    expect(result.success).toBe(true)

    const after = await addon!.getAgentSettings({ agentNodeId: 'hub' })
    // base steps stripped — each accelerator reverts to its format default.
    expect(after?.inferenceDevices?.['openvino:npu']?.steps).toBeUndefined()
    // enabled + weight survive — the reset clears the base, not the opt-in.
    expect(after?.inferenceDevices?.['openvino:npu']?.enabled).toBe(true)
    expect(after?.inferenceDevices?.['openvino:npu']?.weight).toBe(2)
    expect(after?.inferenceDevices?.['openvino:gpu']?.enabled).toBe(false)
  })

  it("leaves a camera's toggles and camera-semantic settings alone — a camera carries no model (D927)", async () => {
    await boot()
    await addon!.setCameraStepToggle({ deviceId: 7, addonId: 'face-detection', enabled: false })
    await addon!.setCameraStepSettings({
      deviceId: 7,
      addonId: 'object-detection',
      settings: { enabledClasses: ['person'] },
    })

    await addon!.resetNodePipelineDefaults({ agentNodeId: 'hub' })

    const cam7 = await addon!.getCameraSettings({ deviceId: 7 })
    expect(cam7?.stepToggles).toEqual({ 'face-detection': false })
    expect(cam7?.stepSettings).toEqual({ 'object-detection': { enabledClasses: ['person'] } })
  })

  it('returns the effective model of the node', async () => {
    await boot()

    const result = await addon!.resetNodePipelineDefaults({ agentNodeId: 'hub' })

    // Effective model = the format default of the accelerator that hosts the
    // camera root — what will ACTUALLY run once the base steps are stripped.
    expect(result.effectiveModelId).toBe(NPU_DEFAULT_MODEL)
  })

  it('degrades to effectiveModelId=null when the node probe fails (node offline)', async () => {
    await boot()

    const result = await addon!.resetNodePipelineDefaults({ agentNodeId: 'agent-gone' })
    expect(result.success).toBe(true)
    expect(result.effectiveModelId).toBeNull()
  })

  it('is idempotent — resetting a node with no persisted settings is a harmless no-op', async () => {
    await boot()

    const first = await addon!.resetNodePipelineDefaults({ agentNodeId: 'agent-fresh' })
    const second = await addon!.resetNodePipelineDefaults({ agentNodeId: 'agent-fresh' })
    expect(first.success).toBe(true)
    expect(second).toEqual(first)
  })
})
