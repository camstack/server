/**
 * G6 — first dispatch must re-resolve a camera's pipeline for the TARGET
 * node, not leave it on the hub's data.
 *
 * `startDetection` hydrates the attach payload via
 * `resolvePipelineForDevice(deviceId)` BEFORE the camera has an assignment,
 * so it defaults to the hub (`localNodeId`). The balancer inside
 * `dispatchCamera` may then place the camera on a different node. Before
 * this fix, the post-dispatch re-resolve only fired when the hub-resolved
 * config happened to have EMPTY steps — so a camera landing on a non-hub
 * node with a non-empty hub-resolved pipeline kept the HUB's model/settings
 * data (hub `addonDefaults` + the camera×hub override) forever, contradicting
 * the (camera, node) data model even though no engine leaked (the runner
 * still resolves its own format locally).
 *
 * Seam: these tests call `PipelineOrchestratorAddon#startDetection` directly
 * (a public method) with a hand-built `CameraDetectionConfig`, bypassing
 * `buildDetectionConfig`'s stream-broker/profile-slot machinery — that
 * machinery is orthogonal to the re-resolve bug and covered elsewhere
 * (`detection-wiring-e2e.spec.ts`, `bindings-e2e.spec.ts`). This is the
 * smallest seam that drives the real `dispatchCamera` → balancer →
 * post-dispatch-re-resolve → `attachOn` path end to end through a fake
 * two-node broker.
 */
import { afterEach, describe, expect, it } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import {
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  wireRunnerToBroker,
} from './e2e-helpers.js'
import type {
  CameraDetectionConfig,
  PipelineSchema,
  PipelineStepInputOutput,
} from '@camstack/types'
import { CORAL_GPU_CATALOG } from './attach-pipeline-fixtures.js'

function model(id: string, formats: readonly string[] = ['onnx']) {
  return {
    id,
    name: id,
    formats: Object.fromEntries(formats.map((f) => [f, { downloaded: false, sizeMB: 1 }])),
  }
}

/** Single-slot catalog with one 'object-detection' addon — matches the
 * shape used by `pipeline-resolver.spec.ts`'s fixtures. */
function makeCatalog(): PipelineSchema {
  return {
    availableEngines: [],
    selectedEngine: { runtime: 'python', backend: 'cpu', format: 'onnx' },
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
            // Builds for both onnx (hub CPU) and openvino (agent-a accelerators)
            // so the per-DEVICE skip check keeps the step on either format.
            models: [
              model('yolov9s', ['onnx', 'openvino']),
              model('yolov9n', ['onnx', 'openvino']),
            ],
            defaultModelId: 'yolov9s',
            defaultConfidence: 0.5,
          },
        ],
      },
    ],
  }
}

/** Empty catalog — no slots, no addons. */
function makeEmptyCatalog(): PipelineSchema {
  return {
    availableEngines: [],
    selectedEngine: { runtime: 'python', backend: 'cpu', format: 'onnx' },
    slots: [],
  }
}

// Phase 3 slice 2 (Task 2): on-motion cameras no longer standing-dispatch at
// `startDetection` time (they dispatch a session on motion instead), so the
// first-dispatch-node-reresolve bug this file targets — which lives entirely
// in `startDetection`'s STANDING re-resolve block — no longer applies to
// them (`dispatchDetectionSession` resolves the pipeline for the CONFIRMED
// balancer-chosen node directly, so it can't hit this bug class at all).
// `detectionMode: 'always-on'` keeps these tests exercising the standing
// path they were written against.
function makeDetectionConfig(
  overrides: Partial<CameraDetectionConfig> = {},
): CameraDetectionConfig {
  return {
    enabled: true,
    pipelineEnabled: true,
    motionSources: ['analyzer'],
    motionStreamId: 'sub',
    detectionStreamId: 'main',
    motionFps: 4,
    detectionFps: 10,
    motionCooldownMs: 10_000,
    detectionMode: 'always-on',
    audioMode: 'disabled',
    onboardMotionDrivesAnalyzer: true,
    occupancyRecheckEnabled: false,
    occupancyRecheckSec: 30,
    occupancyRecheckFrames: 4,
    preRollInferenceEnabled: true,
    preRollInferenceFrames: 12,
    ...overrides,
  }
}

describe('PipelineOrchestratorAddon — startDetection re-resolves for the DISPATCHED node (G6)', () => {
  let addon: PipelineOrchestratorAddon | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('re-attaches with an EMPTY pipeline when the target node has no catalog/addons, even though the hub-resolved config was non-empty', async () => {
    const broker = makeFakeBroker('hub')
    const runnerHub = makeFakeRunner({ nodeId: 'hub' })
    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    wireRunnerToBroker(broker, 'hub', runnerHub)
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    broker.addNode('agent-a')

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        // Only agent-a is detect-enabled (detect ⇒ decode: a separate decoder
        // set no longer exists), so the balancer MUST place the camera on
        // agent-a, never the hub.
        enabledNodes: ['agent-a'],
      },
      providers: {
        'pipeline-executor': {
          getSchema: (input: { nodeId: string }) =>
            input.nodeId === 'hub' ? makeCatalog() : makeEmptyCatalog(),
        },
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.startDetection(104, makeDetectionConfig())

    // Dispatched to agent-a (the only frame-source-eligible node).
    expect(addon.getPipelineAssignment({ deviceId: 104 })?.agentNodeId).toBe('agent-a')

    // The hydrate still defaulted to the hub (the bug condition is real), but
    // since D650 the dispatch resolves for the node AND device it elects, so
    // agent-a gets ONE attach, already correct — no corrective re-attach.
    const attaches104 = runnerA.attachHistory.filter(
      (h) => h.action === 'attach' && h.deviceId === 104,
    )
    expect(attaches104.length).toBe(1)

    // The FINAL attached config on agent-a must reflect agent-a's OWN
    // (empty) catalog/addonDefaults — not the hub's non-empty pipeline.
    const finalConfig = runnerA.attachedCameras.get(104)
    expect(finalConfig?.steps).toEqual([])

    // The hub runner never received an attach for this camera at all.
    expect(runnerHub.attachedCameras.has(104)).toBe(false)
  })

  it('re-attaches with the TARGET node data even when step COUNT matches the hub-resolved config (e.g. a different modelId)', async () => {
    const broker = makeFakeBroker('hub')
    const runnerHub = makeFakeRunner({ nodeId: 'hub' })
    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    wireRunnerToBroker(broker, 'hub', runnerHub)
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    broker.addNode('agent-a')

    const catalog = makeCatalog()
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        // Only agent-a is detect-enabled — the camera must land there.
        enabledNodes: ['agent-a'],
      },
      providers: {
        'pipeline-executor': { getSchema: () => catalog },
        // agent-a exposes TWO accelerators → the device balancer picks a concrete
        // key (equal load/weight ⇒ localeCompare tie-break → `openvino:gpu`).
        'platform-probe': {
          getCapabilities: () => ({
            nodeId: 'agent-a',
            reachable: true,
            devices: [
              probeDevice('openvino:npu', 'openvino', 'npu'),
              probeDevice('openvino:gpu', 'openvino', 'gpu'),
            ],
          }),
        },
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    // agent-a's per-(node,device) BASE pins an explicit, DIFFERENT modelId on the
    // accelerator the balancer will pick (`openvino:gpu`) than whatever the hub
    // resolves (hub has no base → no modelId, data-only). Same catalog, same step
    // COUNT (1) on both nodes — only the step's data differs.
    await addon.setAgentInferenceDevices({
      agentNodeId: 'agent-a',
      inferenceDevices: {
        'openvino:npu': { enabled: true },
        'openvino:gpu': {
          enabled: true,
          steps: { 'object-detection': { modelId: 'agent-a-custom-model' } },
        },
      },
    })

    await addon.startDetection(591, makeDetectionConfig())

    expect(addon.getPipelineAssignment({ deviceId: 591 })?.agentNodeId).toBe('agent-a')

    // Old code checked ONLY `steps.length === 0` post-dispatch — the
    // hub-resolved config already had 1 step, so it would NOT have
    // re-resolved and agent-a would have kept the hub's (no-modelId) step
    // forever. Since D650 the dispatch resolves for the elected (node,
    // device), so the ONE attach already carries agent-a's data.
    const attaches591 = runnerA.attachHistory.filter(
      (h) => h.action === 'attach' && h.deviceId === 591,
    )
    expect(attaches591.length).toBe(1)

    const finalConfig = runnerA.attachedCameras.get(591)
    expect(finalConfig?.steps?.length).toBe(1)
    expect(finalConfig?.steps?.[0]?.modelId).toBe('agent-a-custom-model')
  })

  // orch-F5 — a STANDING (always-on) camera on a node with 2+ enabled inference
  // devices must be device-balanced (its attach carries a concrete `deviceKey`),
  // and the chosen device's per-device model override must be pinned onto the
  // re-resolved step tree. Before the fix, `deviceKey` was set only on the
  // on-motion path, so always-on ran on the runner's single default accelerator.
  function probeDevice(key: string, backend: string, device: string) {
    return {
      key,
      backend,
      device,
      format: 'onnx' as const,
      runtime: 'python' as const,
      score: 100,
      available: true,
    }
  }

  it('device-balances a standing always-on camera and pins the per-device model override on the dispatched node', async () => {
    const broker = makeFakeBroker('hub')
    const runnerHub = makeFakeRunner({ nodeId: 'hub' })
    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    wireRunnerToBroker(broker, 'hub', runnerHub)
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    broker.addNode('agent-a')

    const catalog = makeCatalog()
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['agent-a'] },
      providers: {
        'pipeline-executor': { getSchema: () => catalog },
        // agent-a exposes TWO accelerators → the device balancer picks a concrete
        // key (equal load/weight ⇒ localeCompare tie-break → `openvino:gpu`).
        'platform-probe': {
          getCapabilities: () => ({
            nodeId: 'agent-a',
            reachable: true,
            devices: [
              probeDevice('openvino:npu', 'openvino', 'npu'),
              probeDevice('openvino:gpu', 'openvino', 'gpu'),
            ],
          }),
        },
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    // Enable both accelerators; pin a per-(node,device) base model on the one the
    // balancer will pick (`openvino:gpu`).
    await addon.setAgentInferenceDevices({
      agentNodeId: 'agent-a',
      inferenceDevices: {
        'openvino:npu': { enabled: true },
        'openvino:gpu': { enabled: true, steps: { 'object-detection': { modelId: 'yolov9n' } } },
      },
    })

    await addon.startDetection(107, makeDetectionConfig())

    expect(addon.getPipelineAssignment({ deviceId: 107 })?.agentNodeId).toBe('agent-a')

    const finalConfig = runnerA.attachedCameras.get(107)
    // The standing attach now carries the balancer-chosen accelerator …
    expect(finalConfig?.deviceKey).toBe('openvino:gpu')
    // … and that device's per-device model override is pinned onto the step tree.
    expect(finalConfig?.steps?.[0]?.modelId).toBe('yolov9n')
    // D650 — the standing attach carries the node's jump roster.
    expect(finalConfig?.inferenceDevices?.map((d) => d.deviceKey)).toEqual([
      'openvino:gpu',
      'openvino:npu',
    ])
  })
})

// D650 — the standing pipeline is resolved AFTER device election, for the
// elected device + its jump roster. A node whose DEFAULT engine format is
// tflite (Coral + GPU) used to hydrate a face-less tree on restart and keep it
// even when the GPU was then elected (same node, non-empty steps ⇒ the
// old post-dispatch correction never fired).
describe('standing dispatch on a tflite-default node (D650)', () => {
  let addon: PipelineOrchestratorAddon | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  function coralCpuProbe() {
    return {
      nodeId: 'agent-a',
      reachable: true,
      devices: [
        {
          key: 'openvino:gpu',
          backend: 'openvino',
          device: 'gpu',
          format: 'openvino' as const,
          runtime: 'python' as const,
          score: 10,
          available: true,
        },
        {
          key: 'edgetpu:usb',
          backend: 'edgetpu',
          device: 'usb',
          format: 'tflite' as const,
          runtime: 'python' as const,
          score: 10,
          available: true,
        },
      ],
    }
  }

  async function boot(): Promise<{
    addon: PipelineOrchestratorAddon
    runnerA: ReturnType<typeof makeFakeRunner>
  }> {
    const broker = makeFakeBroker('hub')
    const runnerHub = makeFakeRunner({ nodeId: 'hub' })
    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    wireRunnerToBroker(broker, 'hub', runnerHub)
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    broker.addNode('agent-a')
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['agent-a'] },
      providers: {
        'pipeline-executor': { getSchema: () => CORAL_GPU_CATALOG },
        'platform-probe': { getCapabilities: () => coralCpuProbe() },
      },
    })
    const booted = new PipelineOrchestratorAddon()
    await booted.initialize(ctx)
    await booted.setAgentInferenceDevices({
      agentNodeId: 'agent-a',
      inferenceDevices: {
        'edgetpu:usb': { enabled: true },
        'openvino:gpu': { enabled: true, steps: { 'face-detection': { modelId: 'scrfd-10g' } } },
      },
    })
    return { addon: booted, runnerA }
  }

  function faceOf(steps: readonly PipelineStepInputOutput[] | undefined) {
    const root = (steps ?? []).find((s) => s.addonId === 'object-detection')
    return (root?.children ?? []).find((c) => c.addonId === 'face-detection')
  }

  it('restart → GPU elected → faces kept, provisioned from the GPU base', async () => {
    const booted = await boot()
    addon = booted.addon
    // The node default engine is the Coral (tflite); the operator pins the GPU.
    await addon.setPipelineDevicePin({ deviceId: 593, deviceKey: 'openvino:gpu' })

    await addon.startDetection(593, makeDetectionConfig())

    const finalConfig = booted.runnerA.attachedCameras.get(593)
    expect(finalConfig?.deviceKey).toBe('openvino:gpu')
    expect(faceOf(finalConfig?.steps)?.modelId).toBe('scrfd-10g')
  })

  it('a re-dispatch from a ledger config re-provisions from structure, dropping a stale device and roster', async () => {
    const booted = await boot()
    addon = booted.addon
    await addon.startDetection(594, makeDetectionConfig())
    const live = booted.runnerA.attachedCameras.get(594)
    expect(live).toBeDefined()

    // What the pending-retry / remote-health paths hand back: a ledger config
    // that is already provisioned and names a device this node does not have.
    await addon.dispatchCamera({
      ...live!,
      deviceKey: 'openvino:npu',
      inferenceDevices: [{ deviceKey: 'openvino:npu', weight: 1, maxSessions: null }],
      steps: [{ addonId: 'object-detection', enabled: true, modelId: 'stale-pin', children: [] }],
    })

    const redone = booted.runnerA.attachedCameras.get(594)
    expect(redone?.deviceKey).not.toBe('openvino:npu')
    expect(redone?.inferenceDevices?.map((d) => d.deviceKey)).toEqual([
      'edgetpu:usb',
      'openvino:gpu',
    ])
    const root = (redone?.steps ?? []).find((s) => s.addonId === 'object-detection')
    expect(root?.modelId).not.toBe('stale-pin')
    expect(faceOf(redone?.steps)).toBeDefined()
  })
})
