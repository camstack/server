/**
 * D650 — dispatch-level: a camera elected onto the Coral (`edgetpu:usb`, tflite,
 * object detector only) keeps its detail steps, and a step the runner jumps to
 * `openvino:gpu` is provisioned from THAT device's per-(node,device) base and
 * the camera's override for THAT device.
 *
 * The store is the REAL `PipelineSettingsStore` over an in-memory durable
 * state: the catalog gate, the base fold and the per-camera override are all
 * read by production code. The fakes are only the transport (`getSchema`,
 * `getBindings`) and the balancer inputs. Before D650 the live hub warned
 * `face-detection:no-compatible-model,…` on every Coral session and ran object
 * detection only.
 */
import { CAMERA_TRIGGER } from '@camstack/types'
import {
  createDurableState,
  type AddonContext,
  type CameraDetectionConfig,
  type DurableState,
  type PipelineStepInputOutput,
  type RunnerCameraConfig,
  type RunnerInferenceDevice,
  type RunnerLocalLoad,
} from '@camstack/types'
import type { ZodType } from 'zod'
import { describe, expect, it } from 'vitest'
import { PipelineSettingsStore } from '../pipeline-settings-store.js'
import {
  SessionDispatchController,
  type SessionDispatchControllerDeps,
} from '../session-dispatch-controller.js'
import { RoundRobinInferenceDeviceRotation } from '../device-balancer.js'
import { makeSilentLogger } from './e2e-helpers.js'

const NODE = 'hub'
const DEVICE_ID = 42
const CORAL = 'edgetpu:usb'
const GPU = 'openvino:gpu'

/** Attach payloads carry `deviceKey`/`inferenceDevices`; a widening view for assertions. */
interface AttachedView {
  readonly deviceKey?: string
  readonly steps?: readonly PipelineStepInputOutput[]
  readonly inferenceDevices?: readonly RunnerInferenceDevice[]
}

function build(
  formats: readonly string[],
): Record<string, { downloaded: boolean; sizeMB: number }> {
  return Object.fromEntries(formats.map((f) => [f, { downloaded: true, sizeMB: 1 }]))
}

/** The hub's catalog shape: tflite ships ONLY the object detector. */
const CORAL_HUB_CATALOG = {
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
          defaultModelId: 'yolov9s',
          defaultConfidence: 0.5,
          models: [
            { id: 'yolov9s', name: 'yolov9s', formats: build(['openvino', 'onnx']) },
            { id: 'ssd-edgetpu', name: 'ssd-edgetpu', formats: build(['tflite']) },
          ],
        },
      ],
    },
    {
      id: 'cropper',
      label: 'Cropper',
      priority: 1,
      parentSlot: 'detector',
      addons: [
        {
          id: 'face-detection',
          name: 'face-detection',
          slot: 'cropper',
          inputClasses: ['person'],
          outputClasses: ['face'],
          childSlots: [],
          defaultModelId: 'scrfd-2.5g',
          defaultConfidence: 0.5,
          models: [
            { id: 'scrfd-2.5g', name: 'scrfd-2.5g', formats: build(['openvino', 'onnx']) },
            { id: 'scrfd-10g', name: 'scrfd-10g', formats: build(['openvino', 'onnx']) },
          ],
        },
      ],
    },
  ],
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

function makeStore(): PipelineSettingsStore {
  let blob: Record<string, unknown> = {}
  const state = <T>(key: string, schema: ZodType<T>, fallback: T): DurableState<T> =>
    createDurableState<T>({
      key,
      schema,
      fallback,
      read: async () => blob,
      write: async (patch) => {
        blob = { ...blob, ...patch }
      },
    })
  const api = {
    pipelineExecutor: { getSchema: { query: async (): Promise<unknown> => CORAL_HUB_CATALOG } },
    deviceManager: {
      getBindings: {
        query: async (): Promise<unknown> => ({
          entries: [{ capName: 'detection-pipeline', kind: 'wrapped' }],
        }),
      },
    },
  }
  const acquireCapability = (async (): Promise<unknown> =>
    undefined) as AddonContext['acquireCapability']
  return new PipelineSettingsStore({
    state,
    api: () => api as never,
    acquireCapability,
    getAssignmentNode: () => NODE,
    hasPackageZone: async () => false,
    logger: makeSilentLogger(),
  })
}

async function dispatchOnCoral(store: PipelineSettingsStore): Promise<AttachedView> {
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
    settingsStore: store,
    getEligibleInferenceDevices: async () => ({ [CORAL]: 1, [GPU]: 1 }),
    isNodeInferenceUsable: () => true,
    getInferenceDeviceCaps: async () => ({}),
    // The balancer put this camera on the Coral.
    readPipelineDevicePin: async () => CORAL,
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
    logger: makeSilentLogger(),
  }
  await new SessionDispatchController(deps).handleSessionMotion(
    DEVICE_ID,
    true,
    undefined,
    'analyzer',
    CAMERA_TRIGGER,
  )
  expect(attached).toHaveLength(1)
  return attached[0]!
}

describe('session dispatch on the Coral — same-node detail-step delegation (D650)', () => {
  it('keeps face-detection in the tree and provisions the jump target from ITS base + the camera layer', async () => {
    const store = makeStore()
    await store.writeAgentSettings(NODE, {
      maxCameras: null,
      inferenceDevices: {
        [CORAL]: { enabled: true, steps: { 'object-detection': { modelId: 'ssd-edgetpu' } } },
        [GPU]: {
          enabled: true,
          steps: { 'face-detection': { modelId: 'scrfd-10g', settings: { minFaceSize: 30 } } },
        },
      },
    })
    await store.writeCameraStepSettings(DEVICE_ID, 'face-detection', { minFaceSize: 40 })

    const cfg = await dispatchOnCoral(store)

    expect(cfg.deviceKey).toBe(CORAL)
    // The root stays on the elected device, with the elected device's model.
    const root = (cfg.steps ?? []).find((s) => s.addonId === 'object-detection')
    expect(root?.modelId).toBe('ssd-edgetpu')
    // The detail step is no longer starved by the gate…
    const face = (root?.children ?? []).find((c) => c.addonId === 'face-detection')
    expect(face).toBeDefined()
    // …and the elected (tflite) device lends it no model of its own.
    expect(face?.modelId).toBeUndefined()

    // The roster the runner jumps within carries the TARGET's provisioning:
    // its base model, the settings folded node-wide, the camera's settings
    // layer on top (the same on every device, D927).
    const gpu = (cfg.inferenceDevices ?? []).find((d) => d.deviceKey === GPU)
    expect(gpu?.steps?.['face-detection']).toEqual({
      modelId: 'scrfd-10g',
      settings: { minFaceSize: 40 },
    })
    const coral = (cfg.inferenceDevices ?? []).find((d) => d.deviceKey === CORAL)
    expect(coral?.steps).toBeDefined()
    expect(coral?.steps?.['face-detection']?.modelId).toBeUndefined()
  })
})
