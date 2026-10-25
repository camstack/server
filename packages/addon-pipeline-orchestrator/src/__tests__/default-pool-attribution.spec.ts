/**
 * The load census credits a single-device node's default-pool sessions to its
 * one eligible device.
 *
 * With exactly one eligible device the balancer leaves `deviceKey` unset
 * (`single-eligible-device`) and the runner's default pool serves the camera —
 * the default pool IS that device (D745). The runner counts per-device sessions
 * by `deviceKey`, so it reported `devices: []` and Load balancing → Node load
 * showed the Mac "1/1 attached" but "0 sessions" on its only accelerator.
 */
import type { AddonApi, IScopedLogger, RunnerLocalLoad } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { AgentLoadService } from '../agent-load-service.js'
import { attributeDefaultPoolSessions } from '../default-pool-attribution.js'
import type { NodeTopologyService } from '../node-topology.js'

function runnerLoad(
  nodeId: string,
  attachedCameras: number,
  devices: RunnerLocalLoad['devices'] = [],
): RunnerLocalLoad {
  return {
    nodeId,
    attachedCameras,
    activeCameras: attachedCameras,
    avgInferenceFps: 0,
    avgInferenceTimeMs: 0,
    queueDepthTotal: 0,
    devices,
    hardware: { hasGpu: false },
  }
}

describe('attributeDefaultPoolSessions', () => {
  it('credits a single-device node default-pool sessions to its one eligible device', () => {
    const load = runnerLoad('mac', 2)

    expect(attributeDefaultPoolSessions(load, ['coreml:all']).devices).toEqual([
      { deviceKey: 'coreml:all', backend: 'coreml', attachedCameras: 2 },
    ])
  })

  it('adds the unattributed sessions onto the sessions already keyed on that device', () => {
    // One camera pinned to the device (keyed), one on the default pool (unkeyed):
    // both run on the same accelerator.
    const load = runnerLoad('n100', 2, [
      { deviceKey: 'openvino:gpu', backend: 'openvino', attachedCameras: 1 },
    ])

    expect(attributeDefaultPoolSessions(load, ['openvino:gpu']).devices).toEqual([
      { deviceKey: 'openvino:gpu', backend: 'openvino', attachedCameras: 2 },
    ])
  })

  it('leaves a multi-device node alone — which device the default pool used is not known', () => {
    const load = runnerLoad('hub', 2, [
      { deviceKey: 'openvino:npu', backend: 'openvino', attachedCameras: 1 },
    ])

    expect(attributeDefaultPoolSessions(load, ['openvino:gpu', 'openvino:npu'])).toBe(load)
  })

  it('leaves the load alone when the eligible set is unknown or empty', () => {
    const load = runnerLoad('mac', 1)

    expect(attributeDefaultPoolSessions(load, null)).toBe(load)
    expect(attributeDefaultPoolSessions(load, [])).toBe(load)
  })

  it('leaves the load alone when every session is already attributed', () => {
    const load = runnerLoad('n100', 1, [
      { deviceKey: 'openvino:gpu', backend: 'openvino', attachedCameras: 1 },
    ])

    expect(attributeDefaultPoolSessions(load, ['openvino:gpu'])).toBe(load)
  })

  it('never mutates the runner answer', () => {
    const load = runnerLoad('mac', 1)
    attributeDefaultPoolSessions(load, ['coreml:all'])

    expect(load.devices).toEqual([])
  })
})

describe('AgentLoadService — the reported load carries the attribution', () => {
  function service(eligible: Record<string, readonly string[] | null>): AgentLoadService {
    const loads: Record<string, RunnerLocalLoad> = {
      mac: runnerLoad('mac', 1),
      hub: runnerLoad('hub', 1, [
        { deviceKey: 'openvino:npu', backend: 'openvino', attachedCameras: 1 },
      ]),
    }
    const api = {
      pipelineRunner: {
        getLocalLoad: { query: async (input: { readonly nodeId: string }) => loads[input.nodeId] },
      },
    } as unknown as AddonApi
    const topology = {
      knownRunnerNodeIds: () => Object.keys(loads),
      isNodeEnabled: () => true,
    } as unknown as NodeTopologyService
    const noop = (): void => undefined
    const logger = { debug: noop, info: noop, warn: noop, error: noop } as unknown as IScopedLogger
    return new AgentLoadService({
      api: () => api,
      topology,
      logger,
      readGlobalSettings: () => ({}),
      eligibleDeviceKeys: async (nodeId) => eligible[nodeId] ?? null,
    })
  }

  it('reports the Mac one session on coreml:all instead of no device at all', async () => {
    const svc = service({ mac: ['coreml:all'], hub: ['openvino:gpu', 'openvino:npu'] })
    await svc.collectAgentLoad()

    const byNode = new Map((await svc.reportedAgentLoad()).map((s) => [s.nodeId, s.load.devices]))
    expect(byNode.get('mac')).toEqual([
      { deviceKey: 'coreml:all', backend: 'coreml', attachedCameras: 1 },
    ])
    expect(byNode.get('hub')).toEqual([
      { deviceKey: 'openvino:npu', backend: 'openvino', attachedCameras: 1 },
    ])
  })

  it('keeps the balancer census raw — the attribution is the report only', async () => {
    const svc = service({ mac: ['coreml:all'] })
    const census = await svc.collectAgentLoad()

    expect(census.find((l) => l.nodeId === 'mac')?.devices).toEqual([])
  })

  it('reports the runner answer unchanged when the eligibility read fails', async () => {
    const svc = new AgentLoadService({
      api: () =>
        ({
          pipelineRunner: { getLocalLoad: { query: async () => runnerLoad('mac', 1) } },
        }) as unknown as AddonApi,
      topology: {
        knownRunnerNodeIds: () => ['mac'],
        isNodeEnabled: () => true,
      } as unknown as NodeTopologyService,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      } as unknown as IScopedLogger,
      readGlobalSettings: () => ({}),
      eligibleDeviceKeys: async () => {
        throw new Error('catalog not answered')
      },
    })
    await svc.collectAgentLoad()

    expect((await svc.reportedAgentLoad())[0]?.load.devices).toEqual([])
  })
})
