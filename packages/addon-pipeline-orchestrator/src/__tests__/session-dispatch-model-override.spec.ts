/**
 * Dispatch-level test for the C7.2/C7.4 per-device model override: driving
 * `handleSessionMotion` → `dispatchDetectionSession` and asserting the attach
 * payload's step tree carries the operator's per-device model pin for the
 * chosen accelerator (and is untouched when there is no override).
 */
import { CAMERA_TRIGGER } from '@camstack/types'
import type {
  CameraDetectionConfig,
  DeviceStepConfig,
  IScopedLogger,
  PipelineStepInputOutput,
  RunnerCameraConfig,
  RunnerLocalLoad,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'

/**
 * Attach payloads carry `deviceKey` structurally (the runner reads it) but it
 * is not declared on `RunnerCameraConfig`; `steps` is declared optional. This
 * widening view exposes both for assertions without a cast — a plain
 * assignment from `RunnerCameraConfig` narrows into it cleanly.
 */
interface AttachedView {
  readonly deviceKey?: string
  readonly steps?: readonly PipelineStepInputOutput[]
}
import {
  SessionDispatchController,
  type SessionDispatchControllerDeps,
} from '../session-dispatch-controller.js'
import { RoundRobinInferenceDeviceRotation } from '../device-balancer.js'

const NODE = 'hub'
const DEVICE_ID = 42

function fakeLogger(): IScopedLogger {
  const log: Partial<IScopedLogger> = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }
  log.withTags = () => log as IScopedLogger
  return log as IScopedLogger
}

function fakeLoad(): RunnerLocalLoad {
  return {
    nodeId: NODE,
    attachedCameras: 0,
    activeCameras: 0,
    avgInferenceFps: 0,
    avgInferenceTimeMs: 0,
    queueDepthTotal: 0,
    devices: [],
    hardware: { hasGpu: false },
  }
}

function fakeDetectionConfig(): CameraDetectionConfig {
  return {
    enabled: true,
    pipelineEnabled: true,
    motionSources: ['analyzer'],
    motionStreamId: 'sub',
    detectionStreamId: 'sub',
    motionFps: 2,
    detectionFps: 6,
    motionCooldownMs: 30_000,
    detectionMode: 'on-motion',
    audioMode: 'disabled',
    onboardMotionDrivesAnalyzer: true,
    occupancyRecheckEnabled: false,
    occupancyRecheckSec: 0,
    occupancyRecheckFrames: 0,
    preRollInferenceEnabled: true,
    preRollInferenceFrames: 12,
  }
}

const RESOLVED_STEPS = [
  { addonId: 'object-detection', enabled: true, modelId: 'yolo26n' },
  { addonId: 'clip-embedding', enabled: true },
] as const

interface Harness {
  readonly controller: SessionDispatchController
  readonly attached: RunnerCameraConfig[]
}

function makeHarness(
  base: Record<string, DeviceStepConfig>,
  eligibleDevices: Record<string, number> = { 'openvino:npu': 1, 'openvino:gpu': 1 },
): Harness {
  const attached: RunnerCameraConfig[] = []
  const deps: SessionDispatchControllerDeps = {
    ledger: {
      hasAssignment: () => false,
      hasPending: () => false,
      markDispatching: () => ({ dispose: () => {} }),
    } as unknown as SessionDispatchControllerDeps['ledger'],
    topology: {
      detectionEligibleNodes: () => [NODE],
    } as unknown as SessionDispatchControllerDeps['topology'],
    loadService: {
      collectAgentLoad: async () => [fakeLoad()],
    } as unknown as SessionDispatchControllerDeps['loadService'],
    settingsStore: {
      buildNodeCaps: async () => ({}),
      buildNodeWeights: async () => ({}),
      readDeviceProvisioning: async (_d: number, _n: string, keys: readonly string[]) =>
        new Map(keys.map((k) => [k, { base: { ...base }, override: {} }])),
      resolvePipelineForDeviceWithRoots: async () => ({
        config: {
          steps: RESOLVED_STEPS.map((s) => ({ ...s })),
          audio: null,
        },
        droppedRoots: [],
      }),
    } as unknown as SessionDispatchControllerDeps['settingsStore'],
    // Two enabled devices ⇒ pickInferenceDevice returns a concrete key, which
    // triggers the override. Equal load/weight ⇒ a TIE, and each harness gets a
    // FRESH rotation whose first slot is `openvino:gpu` (index 0 of the sorted
    // tied set). The rotation itself is exercised in
    // `inference-device-selection.spec.ts`.
    getEligibleInferenceDevices: async () => eligibleDevices,
    isNodeInferenceUsable: () => true,
    getInferenceDeviceCaps: async () => ({}),
    readPipelineDevicePin: async () => null,
    inferenceRotation: new RoundRobinInferenceDeviceRotation(),
    attachOn: async (_nodeId: string, config: RunnerCameraConfig) => {
      attached.push(config)
    },
    detachOn: async () => {},
    recordAssignment: () => {},
    dropAssignment: () => {},
    reconcilePlacementFromRunners: async () => {},
    getActiveDetectionConfig: () => fakeDetectionConfig(),
    dropActiveDetection: () => {},
    listZones: async () => [],
    readPipelinePin: async () => null,
    logger: fakeLogger(),
  }
  return { controller: new SessionDispatchController(deps), attached }
}

describe('dispatchDetectionSession — per-device model override', () => {
  let harness: Harness

  it('rewrites the object-detection step modelId to the device override on attach', async () => {
    harness = makeHarness({ 'object-detection': { modelId: 'yolov9m-320-int8' } })
    await harness.controller.handleSessionMotion(
      DEVICE_ID,
      true,
      undefined,
      'analyzer',
      CAMERA_TRIGGER,
    )

    expect(harness.attached).toHaveLength(1)
    const cfg: AttachedView = harness.attached[0]!
    const steps = cfg.steps ?? []
    expect(cfg.deviceKey).toBe('openvino:gpu')
    const detector = steps.find((s) => s.addonId === 'object-detection')
    expect(detector?.modelId).toBe('yolov9m-320-int8')
    // Sibling step untouched.
    expect(steps.find((s) => s.addonId === 'clip-embedding')?.modelId).toBeUndefined()
  })

  it('a default-pool dispatch (no elected deviceKey) still attaches the node step SETTINGS', async () => {
    // 2026-08-21 sheep incident, second leg: a single-eligible-device node
    // (`pickInferenceDevice` → default-pool, `deviceKey` unset — the macmini
    // shape) used to skip the per-(node,device) base entirely, so the
    // animal-classifier species allow-list stored on that node never reached
    // the session even though the node's only accelerator carried the copy.
    harness = makeHarness(
      { 'clip-embedding': { settings: { enabledClasses: ['dog'] } } },
      { 'coreml:all': 1 },
    )
    await harness.controller.handleSessionMotion(
      DEVICE_ID,
      true,
      undefined,
      'analyzer',
      CAMERA_TRIGGER,
    )

    expect(harness.attached).toHaveLength(1)
    const cfg: AttachedView = harness.attached[0]!
    // default pool: no elected device on the attach…
    expect(cfg.deviceKey).toBeUndefined()
    // …but the node-scoped settings still provision the step.
    const step = (cfg.steps ?? []).find((s) => s.addonId === 'clip-embedding')
    expect(step?.settings).toEqual({ enabledClasses: ['dog'] })
  })

  it('no override ⇒ the resolved step models are unchanged', async () => {
    harness = makeHarness({})
    await harness.controller.handleSessionMotion(
      DEVICE_ID,
      true,
      undefined,
      'analyzer',
      CAMERA_TRIGGER,
    )

    expect(harness.attached).toHaveLength(1)
    const cfg: AttachedView = harness.attached[0]!
    const steps = cfg.steps ?? []
    expect(steps.find((s) => s.addonId === 'object-detection')?.modelId).toBe('yolo26n')
  })
})
