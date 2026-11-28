/**
 * D1065 — the device election never elects a device the camera ROOT is
 * switched off on. The root is `object-detection`; it is judged by the same
 * `gateStep` the attach path runs (cluster mode, node switch) plus the device's
 * own step switch, so the election and the attach can never disagree about
 * where the root may run.
 */
import type { InferenceDeviceDescriptor } from '@dominevo/types'
import { afterEach, describe, expect, it } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import {
  makeRootCapabilityGuard,
  makeRootSwitchGuard,
  resolveInferenceDeviceEligibility,
} from '../inference-device-model.js'
import { CORAL, CORAL_GPU_CATALOG, GPU } from './attach-pipeline-fixtures.js'
import {
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  wireRunnerToBroker,
} from './e2e-helpers.js'

function probe(
  key: string,
  backend: string,
  format: 'tflite' | 'openvino' | 'onnx',
): InferenceDeviceDescriptor {
  return { key, backend, device: key, format, runtime: 'python', score: 1, available: true }
}

const PROBED = [probe(CORAL, 'edgetpu', 'tflite'), probe(GPU, 'openvino', 'openvino')]
const CPU_PROBE = probe('cpu', 'cpu', 'onnx')

const BOTH_ON = { [CORAL]: { enabled: true, weight: 1 }, [GPU]: { enabled: true, weight: 1 } }

function elect(
  node: Parameters<typeof makeRootSwitchGuard>[2],
  clusterModes: Parameters<typeof makeRootSwitchGuard>[1] = {},
  probed: readonly InferenceDeviceDescriptor[] = PROBED,
  stored: Parameters<typeof resolveInferenceDeviceEligibility>[1] = BOTH_ON,
) {
  return resolveInferenceDeviceEligibility(
    probed,
    stored,
    makeRootCapabilityGuard(CORAL_GPU_CATALOG),
    undefined,
    makeRootSwitchGuard(CORAL_GPU_CATALOG, clusterModes, node),
  )
}

describe('election root guard (D1065)', () => {
  it('both devices elect when nothing is switched off', () => {
    expect(Object.keys(elect(undefined).eligible).toSorted()).toEqual([CORAL, GPU].toSorted())
  })

  it('a device whose root step is switched off is not elected, and says why', () => {
    const node = {
      inferenceDevices: {
        [CORAL]: { enabled: true, steps: { 'object-detection': { enabled: false } } },
        [GPU]: { enabled: true },
      },
    }
    const { eligible, excluded } = elect(node)
    expect(Object.keys(eligible)).toEqual([GPU])
    expect(excluded).toContainEqual({ key: CORAL, reason: 'root-switched-off', format: 'tflite' })
  })

  it('a node switch on the root elects no device of that node', () => {
    const { eligible, excluded } = elect({ stepEnabled: { 'object-detection': false } })
    expect(eligible).toEqual({})
    expect(excluded.map((e) => e.reason)).toEqual(['root-switched-off', 'root-switched-off'])
  })

  it('cluster OFF on the root elects nothing', () => {
    expect(elect(undefined, { 'object-detection': 'off' }).eligible).toEqual({})
  })

  it('an accelerator with the root switched off does not suppress the CPU fallback', () => {
    const node = {
      inferenceDevices: {
        [GPU]: { enabled: true, steps: { 'object-detection': { enabled: false } } },
      },
    }
    const stored = { [GPU]: { enabled: true, weight: 1 }, cpu: { enabled: true, weight: 1 } }
    const { eligible } = elect(node, {}, [probe(GPU, 'openvino', 'openvino'), CPU_PROBE], stored)
    expect(Object.keys(eligible)).toEqual(['cpu'])
  })
})

describe('the dispatcher and the device view obey the root switch (D1065)', () => {
  const NODE = 'agent-a'
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
          getCapabilities: () => ({ nodeId: NODE, reachable: true, devices: PROBED }),
        },
      },
    })
    const booted = new PipelineOrchestratorAddon()
    await booted.initialize(ctx)
    await booted.setAgentInferenceDevices({ agentNodeId: NODE, inferenceDevices: BOTH_ON })
    return booted
  }

  it('a device switch on the root drops that device from the election and names it', async () => {
    addon = await boot()
    const before = await addon.resolveEligibleInferenceDevices(NODE, 'await-catalog')
    expect(Object.keys(before).toSorted()).toEqual([CORAL, GPU].toSorted())

    await addon.setDeviceStepEnabled({
      agentNodeId: NODE,
      deviceKey: CORAL,
      stepId: 'object-detection',
      enabled: false,
    })
    const after = await addon.resolveEligibleInferenceDevices(NODE, 'await-catalog')
    expect(Object.keys(after)).toEqual([GPU])
    const view = await addon.getNodeInferenceDevices({ nodeId: NODE })
    expect(view.devices.find((d) => d.key === CORAL)?.exclusion).toBe('root-switched-off')
  })

  it('a node switch on the root elects nothing on that node', async () => {
    addon = await boot()
    await addon.setNodeStepEnabled({
      agentNodeId: NODE,
      stepId: 'object-detection',
      enabled: false,
    })
    expect(await addon.resolveEligibleInferenceDevices(NODE, 'await-catalog')).toEqual({})
  })
})
