/**
 * D650 — a rebalance MIGRATION re-resolves the attach for the TARGET node:
 * it elects the target's device, strips the source node's `deviceKey` /
 * roster, attaches what the target resolves (empty included), and counts the
 * sessions it hands each accelerator within the pass so it cannot overshoot a
 * device's `maxSessions`.
 */
import type { PipelineSchema, RunnerCameraConfig } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import {
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  makeRunnerCameraConfig,
  waitUntil,
  wireRunnerToBroker,
} from './e2e-helpers.js'
import type { ZoneRulesProvider } from '../zone-rules-provider.js'

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

const EMPTY_CATALOG: PipelineSchema = { ...CATALOG, slots: [] }

function device(key: string, format: string) {
  const [backend, dev] = key.split(':')
  return { key, backend, device: dev, format, runtime: 'python', score: 10, available: true }
}

/** agent-a: two openvino devices; agent-b: a Coral and an NPU. */
const PROBE: Readonly<Record<string, ReturnType<typeof device>[]>> = {
  'agent-a': [device('openvino:gpu', 'openvino'), device('openvino:npu', 'openvino')],
  'agent-b': [device('edgetpu:usb', 'tflite'), device('openvino:npu', 'openvino')],
}

interface Booted {
  readonly addon: PipelineOrchestratorAddon
  readonly runnerA: ReturnType<typeof makeFakeRunner>
  readonly runnerB: ReturnType<typeof makeFakeRunner>
}

async function boot(
  catalogFor: (nodeId: string) => PipelineSchema | Promise<PipelineSchema>,
): Promise<Booted> {
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
    providers: {
      'pipeline-executor': { getSchema: (input: { nodeId: string }) => catalogFor(input.nodeId) },
      'platform-probe': {
        getCapabilities: (input?: { nodeId?: string }) => ({
          nodeId: input?.nodeId ?? 'hub',
          reachable: true,
          devices: PROBE[input?.nodeId ?? ''] ?? [],
        }),
      },
    },
  })
  const addon = new PipelineOrchestratorAddon()
  await addon.initialize(ctx)
  await addon.setAgentInferenceDevices({
    agentNodeId: 'agent-a',
    inferenceDevices: { 'openvino:gpu': { enabled: true }, 'openvino:npu': { enabled: true } },
  })
  return { addon, runnerA, runnerB }
}

/** Put `deviceIds` on agent-a, then take agent-a out of detection so they all migrate. */
async function migrateAllToB(
  addon: PipelineOrchestratorAddon,
  deviceIds: readonly number[],
): Promise<void> {
  for (const deviceId of deviceIds) {
    const r = await addon.dispatchCamera(makeRunnerCameraConfig(deviceId))
    expect(r.kind).toBe('assigned')
  }
  await addon.setAgentCapabilities({ agentNodeId: 'agent-b', detect: true })
  await addon.setAgentCapabilities({ agentNodeId: 'agent-a', detect: false })
  await warmCatalog(addon, 'agent-b')
  await addon.rebalance()
}

/**
 * A migration elects against the target's LAST ANSWERED device probe and its
 * CACHED catalog (D650 rounds 2–3). The dispatcher's own live eligibility read
 * — what a first placement and the session refresher do — warms both.
 */
async function warmCatalog(addon: PipelineOrchestratorAddon, nodeId: string): Promise<void> {
  await addon.resolveEligibleInferenceDevices(nodeId, 'await-catalog')
}

describe('rebalance migration re-resolves for the target (D650)', () => {
  let addon: PipelineOrchestratorAddon | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('elects the target device and strips the source deviceKey and roster', async () => {
    const booted = await boot(() => CATALOG)
    addon = booted.addon
    await addon.setAgentInferenceDevices({
      agentNodeId: 'agent-b',
      inferenceDevices: { 'edgetpu:usb': { enabled: true }, 'openvino:npu': { enabled: true } },
    })
    await addon.dispatchCamera(makeRunnerCameraConfig(700))
    const source = addon.getPipelineAssignment({ deviceId: 700 })
    expect(source?.agentNodeId).toBe('agent-a')

    await addon.setAgentCapabilities({ agentNodeId: 'agent-b', detect: true })
    await addon.setAgentCapabilities({ agentNodeId: 'agent-a', detect: false })
    await warmCatalog(addon, 'agent-b')
    await addon.rebalance()

    expect(addon.getPipelineAssignment({ deviceId: 700 })?.agentNodeId).toBe('agent-b')
    const moved: RunnerCameraConfig | undefined = booted.runnerB.attachedCameras.get(700)
    // agent-a's election was `openvino:gpu`, which agent-b does not have.
    expect(moved?.deviceKey).not.toBe('openvino:gpu')
    expect(['edgetpu:usb', 'openvino:npu']).toContain(moved?.deviceKey)
    expect(moved?.inferenceDevices?.map((d) => d.deviceKey)).toEqual([
      'edgetpu:usb',
      'openvino:npu',
    ])
  })

  it('a target whose executor never answers costs the camera its move, not the pass', async () => {
    const never = new Promise<PipelineSchema>(() => {})
    const booted = await boot((nodeId) => (nodeId === 'agent-b' ? never : CATALOG))
    addon = booted.addon
    const r = await addon.dispatchCamera(makeRunnerCameraConfig(730))
    expect(r.kind).toBe('assigned')
    await addon.setAgentCapabilities({ agentNodeId: 'agent-b', detect: true })
    await addon.setAgentCapabilities({ agentNodeId: 'agent-a', detect: false })

    let timer: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([
      addon.rebalance(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('rebalance pass hung on a wedged target')), 3_000)
      }),
    ]).finally(() => clearTimeout(timer))

    // …and the pass SAYS what it could not do, so a manual rebalance toward a
    // node that has not answered does not read as "nothing to do".
    expect(result.migrated).toBe(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.deviceId).toBe(730)
    expect(result.skipped[0]?.targetNodeId).toBe('agent-b')
    expect(result.skipped[0]?.reason).toMatch(/-unavailable:agent-b$/)

    // Not moved, not detached: still on its source.
    expect(addon.getPipelineAssignment({ deviceId: 730 })?.agentNodeId).toBe('agent-a')
    expect(booted.runnerA.attachedCameras.has(730)).toBe(true)
    expect(booted.runnerB.attachedCameras.has(730)).toBe(false)
  })

  it('attaches what the target resolves, even EMPTY — never the cached source tree', async () => {
    const booted = await boot((nodeId) => (nodeId === 'agent-b' ? EMPTY_CATALOG : CATALOG))
    addon = booted.addon
    // One device left on agent-b: a node electing among several devices names
    // one (the Coral is enabled by default now, D912, beside the NPU), and this
    // spec is about a node with NOTHING to elect.
    await addon.setAgentInferenceDevices({
      agentNodeId: 'agent-b',
      inferenceDevices: { 'edgetpu:usb': { enabled: false } },
    })
    await migrateAllToB(addon, [701])

    const moved = booted.runnerB.attachedCameras.get(701)
    expect(moved).toBeDefined()
    expect(moved?.steps).toEqual([])
    // Nothing on agent-b can host the root, so no device is elected there —
    // and agent-a's `openvino:gpu` election and roster must not ride along.
    expect(moved?.deviceKey).toBeUndefined()
    expect(moved?.inferenceDevices).toBeUndefined()
  })

  it('one pass never gives an accelerator more sessions than its maxSessions', async () => {
    const booted = await boot(() => CATALOG)
    addon = booted.addon
    await addon.setAgentInferenceDevices({
      agentNodeId: 'agent-b',
      inferenceDevices: {
        'edgetpu:usb': { enabled: true, maxSessions: 1 },
        'openvino:npu': { enabled: true, maxSessions: 1 },
      },
    })
    await migrateAllToB(addon, [710, 711, 712])

    const perDevice = new Map<string, number>()
    for (const deviceId of [710, 711, 712]) {
      const key = booted.runnerB.attachedCameras.get(deviceId)?.deviceKey
      if (key !== undefined) perDevice.set(key, (perDevice.get(key) ?? 0) + 1)
    }
    expect(booted.runnerB.attachedCameras.size).toBe(3)
    for (const count of perDevice.values()) expect(count).toBeLessThanOrEqual(1)
  })
})

// D650 — the package-zone re-attach, wired through `orchestrator-bootstrap`:
// a `package` rule change re-attaches the camera through the one owner, on
// the device it is already elected onto, with that device's provisioning.
describe('package-zone re-attach through the bootstrap wiring (D650)', () => {
  let addon: PipelineOrchestratorAddon | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('keeps the elected device, its roster and its pin', async () => {
    const booted = await boot(() => CATALOG)
    addon = booted.addon
    await addon.setAgentInferenceDevices({
      agentNodeId: 'agent-a',
      inferenceDevices: {
        'openvino:gpu': { enabled: true, steps: { 'object-detection': { modelId: 'gpu-pin' } } },
        'openvino:npu': { enabled: true, steps: { 'object-detection': { modelId: 'npu-pin' } } },
      },
    })
    await addon.dispatchCamera(makeRunnerCameraConfig(720))
    const runnerA = booted.runnerA
    const before = runnerA.attachHistory.filter((h) => h.action === 'attach' && h.deviceId === 720)
    const elected = runnerA.attachedCameras.get(720)?.deviceKey
    expect(elected).toBeDefined()
    const pin = elected === 'openvino:gpu' ? 'gpu-pin' : 'npu-pin'

    const rules = (addon as unknown as { zoneRulesProvider: ZoneRulesProvider }).zoneRulesProvider
    await rules.setRules({ deviceId: 720, stage: 'package', rules: [] })
    await waitUntil(
      () =>
        runnerA.attachHistory.filter((h) => h.action === 'attach' && h.deviceId === 720).length >
        before.length,
      2_000,
    )

    const reattached = runnerA.attachedCameras.get(720)
    expect(reattached?.deviceKey).toBe(elected)
    expect(reattached?.inferenceDevices?.map((d) => d.deviceKey)).toEqual([
      'openvino:gpu',
      'openvino:npu',
    ])
    expect(reattached?.steps?.[0]?.modelId).toBe(pin)
  })
})
