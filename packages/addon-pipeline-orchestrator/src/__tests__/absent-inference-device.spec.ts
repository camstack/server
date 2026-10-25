/**
 * D919 — a device the node no longer has.
 *
 * 2026-10-23: the Coral USB moved from the hub to another node. Once the probe
 * stops reporting it (the platform-probe re-probe), the orchestrator must
 *  - re-elect without it on the next eligibility read (the existing
 *    device-set-change path), whatever its stored `enabled`;
 *  - show it as ABSENT (not merely unavailable) with its settings kept;
 *  - let the operator forget it — and refuse to forget a device that is
 *    present, or anything on a node whose probe did not answer.
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
  /** Plug the Coral in or pull it out of the node's probe answer. */
  readonly setCoral: (present: boolean) => void
  readonly setReachable: (reachable: boolean) => void
  readonly lines: readonly string[]
  /** The node of every `live device set changed` line, in order. */
  readonly setChangedFor: readonly unknown[]
}

async function boot(): Promise<Booted> {
  const broker = makeFakeBroker('hub')
  const runner = makeFakeRunner({ nodeId: NODE })
  wireRunnerToBroker(broker, NODE, runner)
  broker.addNode(NODE)
  let coral = true
  let reachable = true
  const { ctx } = makeFakeContext({
    addonConfig: { moleculerBroker: broker },
    initialGlobalSettings: { enabledNodes: [NODE] },
    providers: {
      'pipeline-executor': { getSchema: async () => CATALOG },
      'platform-probe': {
        getCapabilities: () => {
          if (!reachable) throw new Error('node probe unreachable')
          const devices = coral
            ? [device(CORAL, 'tflite'), device(NPU, 'openvino')]
            : [device(NPU, 'openvino')]
          return { nodeId: NODE, reachable: true, devices }
        },
      },
    },
  })
  const lines: string[] = []
  const setChangedFor: unknown[] = []
  const info = ctx.logger.info.bind(ctx.logger)
  ctx.logger.info = (msg, opts) => {
    lines.push(msg)
    if (msg === 'inference devices: the live device set changed') {
      setChangedFor.push(opts?.meta?.['nodeId'])
    }
    info(msg, opts)
  }
  const addon = new PipelineOrchestratorAddon()
  await addon.initialize(ctx)
  await addon.setAgentInferenceDevices({
    agentNodeId: NODE,
    inferenceDevices: { [CORAL]: { enabled: true, weight: 3 }, [NPU]: { enabled: true } },
  })
  return {
    addon,
    setCoral: (p) => {
      coral = p
    },
    setReachable: (r) => {
      reachable = r
    },
    lines,
    setChangedFor,
  }
}

describe('a device the node no longer has (D919)', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('the election follows the probe: a Coral that left is no longer elected, and coming back it is', async () => {
    const booted = await boot()
    addon = booted.addon
    const before = await addon.resolveEligibleInferenceDevices(NODE, 'await-catalog')
    expect(Object.keys(before).toSorted()).toEqual([CORAL, NPU])

    booted.setCoral(false)
    const after = await addon.resolveEligibleInferenceDevices(NODE, 'await-catalog')
    // Stored `enabled:true` does not make an absent device eligible.
    expect(Object.keys(after)).toEqual([NPU])
    // The re-place paths elect against the same, new list.
    const cached = await addon.resolveEligibleInferenceDevicesIfCached(NODE)
    expect(cached.kind === 'eligible' ? Object.keys(cached.eligible) : cached).toEqual([NPU])
    // Counted for THIS node: the auto benchmark also probes the never-probed
    // hub at boot, and the fake answers for every node.
    expect(booted.setChangedFor.filter((n) => n === NODE)).toHaveLength(2) // the first answer, then the Coral leaving

    booted.setCoral(true)
    const back = await addon.resolveEligibleInferenceDevices(NODE, 'await-catalog')
    expect(Object.keys(back).toSorted()).toEqual([CORAL, NPU])
  })

  it('the view shows the departed device as ABSENT with its settings kept', async () => {
    const booted = await boot()
    addon = booted.addon
    booted.setCoral(false)
    const view = await addon.getNodeInferenceDevices({ nodeId: NODE })
    const coral = view.devices.find((d) => d.key === CORAL)
    expect(coral).toMatchObject({
      presence: 'absent',
      available: false,
      enabled: true,
      weight: 3,
      exclusion: 'unavailable',
    })
    expect(view.devices.find((d) => d.key === NPU)?.presence).toBe('present')
  })

  it('forget deletes only the absent key; the rest of the map is kept', async () => {
    const booted = await boot()
    addon = booted.addon
    booted.setCoral(false)
    await addon.forgetInferenceDevice({ agentNodeId: NODE, deviceKey: CORAL })
    const view = await addon.getNodeInferenceDevices({ nodeId: NODE })
    expect(view.devices.map((d) => d.key)).toEqual([NPU])
    expect(view.devices[0]).toMatchObject({ enabled: true, presence: 'present' })
    expect(booted.lines).toContain('inference device forgotten — its stored settings were deleted')
  })

  it('forget refuses a device that is present', async () => {
    const booted = await boot()
    addon = booted.addon
    await expect(
      addon.forgetInferenceDevice({ agentNodeId: NODE, deviceKey: CORAL }),
    ).rejects.toThrow(/present on node/)
    const view = await addon.getNodeInferenceDevices({ nodeId: NODE })
    expect(view.devices.find((d) => d.key === CORAL)?.weight).toBe(3)
  })

  it('forget refuses on a node whose probe did not answer, and the view claims nothing', async () => {
    const booted = await boot()
    addon = booted.addon
    booted.setReachable(false)
    await expect(
      addon.forgetInferenceDevice({ agentNodeId: NODE, deviceKey: CORAL }),
    ).rejects.toThrow(/did not answer/)
    const view = await addon.getNodeInferenceDevices({ nodeId: NODE })
    expect(view.reachable).toBe(false)
    expect(view.devices.every((d) => d.presence === 'unknown')).toBe(true)
  })

  it('the shares view gives the departed device no share, even with its stored weight (manual)', async () => {
    const booted = await boot()
    addon = booted.addon
    await addon.setShareSource({ source: 'manual' })
    booted.setCoral(false)
    const shares = await addon.getEffectiveShares()
    const node = shares.nodes.find((n) => n.nodeId === NODE)
    expect(node?.devices.map((d) => d.deviceKey)).toEqual([NPU])
    expect(node?.devices[0]).toMatchObject({ configuredPct: 100, effectivePct: 100 })
  })
})
