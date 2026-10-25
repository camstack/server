/**
 * D650 round 4 — an UNREACHABLE device probe changes nothing (D49).
 *
 * The re-place paths elect against a node's last COMPLETED device probe. A
 * probe that could not reach the node came back as `reachable:false` with an
 * empty device list, and that empty list was recorded as an answer: it
 * overwrote a good last-known list (every device gone — the camera fell to the
 * default pool), and it turned a never-answered node into an "answered with
 * nothing" one after a single failure, so `device-health-unavailable` never
 * fired again. Now an unreachable probe keeps the last known list and leaves a
 * never-answered node unanswered.
 */
import type { PipelineSchema } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import {
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  wireRunnerToBroker,
} from './e2e-helpers.js'

const NODE = 'agent-a'
const CORAL = 'edgetpu:usb'
const NPU = 'openvino:npu'

function build(
  formats: readonly string[],
): Record<string, { downloaded: boolean; sizeMB: number }> {
  return Object.fromEntries(formats.map((f) => [f, { downloaded: true, sizeMB: 1 }]))
}

/** The root ships for both devices, so the guard excludes neither. */
const CATALOG: PipelineSchema = {
  availableEngines: [],
  selectedEngine: { runtime: 'python', backend: 'openvino', format: 'openvino' },
  slots: [
    {
      id: 'detector',
      label: 'Detector',
      priority: 0,
      parentSlot: null,
      addons: [
        {
          id: 'object-detection',
          name: 'object-detection',
          slot: 'detector',
          inputClasses: [],
          outputClasses: ['person'],
          childSlots: [],
          defaultModelId: 'yolo',
          defaultConfidence: 0.5,
          models: [{ id: 'yolo', name: 'yolo', formats: build(['openvino', 'tflite']) }],
        },
      ],
    },
  ],
}

function device(key: string, format: string) {
  const [backend, dev] = key.split(':')
  return { key, backend, device: dev, format, runtime: 'python', score: 10, available: true }
}

interface Booted {
  readonly addon: PipelineOrchestratorAddon
  /** Flip the node's platform probe between answering and throwing. */
  readonly setReachable: (reachable: boolean) => void
  /** The node leaves the cluster (`AgentOffline`). */
  readonly departNode: () => void
}

async function boot(reachableAtStart: boolean): Promise<Booted> {
  const broker = makeFakeBroker('hub')
  const runner = makeFakeRunner({ nodeId: NODE })
  wireRunnerToBroker(broker, NODE, runner)
  broker.addNode(NODE)
  let reachable = reachableAtStart
  const devices = [device(CORAL, 'tflite'), device(NPU, 'openvino')]
  const { ctx } = makeFakeContext({
    addonConfig: { moleculerBroker: broker },
    initialGlobalSettings: { enabledNodes: [NODE] },
    providers: {
      'pipeline-executor': { getSchema: async () => CATALOG },
      'platform-probe': {
        getCapabilities: () => {
          if (!reachable) throw new Error('node probe unreachable')
          return { nodeId: NODE, reachable: true, devices }
        },
      },
    },
  })
  const addon = new PipelineOrchestratorAddon()
  await addon.initialize(ctx)
  await addon.setAgentInferenceDevices({
    agentNodeId: NODE,
    inferenceDevices: { [CORAL]: { enabled: true }, [NPU]: { enabled: true } },
  })
  return {
    addon,
    setReachable: (r) => {
      reachable = r
    },
    departNode: () => broker.removeNode(NODE),
  }
}

/** Let the single-flight background refresh started by a cached read finish. */
async function refreshSettles(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30))
}

describe('an unreachable device probe changes nothing (D650 round 4)', () => {
  let addon: PipelineOrchestratorAddon | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('a node whose probe has never answered stays device-health-unavailable across a failed refresh', async () => {
    const booted = await boot(false)
    addon = booted.addon

    const first = await addon.resolveEligibleInferenceDevicesIfCached(NODE)
    expect(first).toEqual({ kind: 'unavailable', nodeId: NODE, what: 'device-health' })
    await refreshSettles()

    // The failed refresh must not have been recorded as "answered with nothing".
    const second = await addon.resolveEligibleInferenceDevicesIfCached(NODE)
    expect(second).toEqual({ kind: 'unavailable', nodeId: NODE, what: 'device-health' })
  })

  it('a node that LEAVES is forgotten: a re-place waits for a fresh probe, not the list it left with', async () => {
    // Pre-ship review M4: a node that returns with a different accelerator set
    // must not be elected against its old list.
    const booted = await boot(true)
    addon = booted.addon
    await addon.resolveEligibleInferenceDevices(NODE, 'await-catalog')
    expect((await addon.resolveEligibleInferenceDevicesIfCached(NODE)).kind).toBe('eligible')

    booted.setReachable(false) // gone for real: nothing answers
    booted.departNode()

    expect(await addon.resolveEligibleInferenceDevicesIfCached(NODE)).toEqual({
      kind: 'unavailable',
      nodeId: NODE,
      what: 'device-health',
    })
  })

  it('a good last-known device list survives an unreachable refresh', async () => {
    const booted = await boot(true)
    addon = booted.addon
    // A first placement probes live and records the completed answer.
    expect(
      Object.keys(await addon.resolveEligibleInferenceDevices(NODE, 'await-catalog')).toSorted(),
    ).toEqual([CORAL, NPU])

    booted.setReachable(false)
    const served = await addon.resolveEligibleInferenceDevicesIfCached(NODE) // starts a refresh
    await refreshSettles()
    const after = await addon.resolveEligibleInferenceDevicesIfCached(NODE)

    for (const outcome of [served, after]) {
      expect(outcome.kind).toBe('eligible')
      if (outcome.kind === 'eligible') {
        expect(Object.keys(outcome.eligible).toSorted()).toEqual([CORAL, NPU])
      }
    }
  })
})
