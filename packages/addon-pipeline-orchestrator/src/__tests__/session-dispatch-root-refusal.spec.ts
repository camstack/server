/**
 * D650 rounds 3–4 — an on-motion SESSION whose elected device cannot run the
 * camera root is refused: no attach, no assignment. The refusal is said once
 * per change of state per camera (not on every motion edge) and is exposed as
 * the camera's pending reason, so the camera status can show it where a
 * standing camera's `pending:<reason>` already appears.
 *
 * Real `PipelineSettingsStore` over the Coral + GPU fixture; the camera is
 * pinned onto `coreml:ane`, a device the catalog ships no object-detection
 * build for. Faked: the balancer inputs and the transport.
 */
import { CAMERA_TRIGGER } from '@camstack/types'
import type {
  CameraDetectionConfig,
  IScopedLogger,
  RunnerCameraConfig,
  RunnerLocalLoad,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { RoundRobinInferenceDeviceRotation } from '../device-balancer.js'
import {
  SessionDispatchController,
  type SessionDispatchControllerDeps,
} from '../session-dispatch-controller.js'
import { CORAL, NODE, makeRealStore, seedCoralGpuNode } from './attach-pipeline-fixtures.js'
import { makeSilentLogger } from './e2e-helpers.js'

const DEVICE_ID = 43
const ANE = 'coreml:ane'

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

function onMotionConfig(): CameraDetectionConfig {
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
    preRollInferenceEnabled: false,
    preRollInferenceFrames: 0,
  }
}

interface Harness {
  readonly controller: SessionDispatchController
  readonly attached: RunnerCameraConfig[]
  readonly recorded: number[]
  readonly errors: string[]
  readonly infos: string[]
  /** Move the camera's soft device pin the balancer honours. */
  readonly setPin: (deviceKey: string) => void
}

async function makeHarness(): Promise<Harness> {
  const { store } = makeRealStore()
  await seedCoralGpuNode(store)
  const attached: RunnerCameraConfig[] = []
  const recorded: number[] = []
  const errors: string[] = []
  const infos: string[] = []
  const logger: IScopedLogger = {
    ...makeSilentLogger(),
    error: (message: string) => void errors.push(message),
    info: (message: string) => void infos.push(message),
  }
  // `withTags` must hand back the SAME capturing logger.
  const capturing: IScopedLogger = { ...logger, withTags: () => capturing }
  let pin = ANE
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
    getEligibleInferenceDevices: async () => ({ [CORAL]: 1, [ANE]: 1 }),
    isNodeInferenceUsable: () => true,
    getInferenceDeviceCaps: async () => ({}),
    readPipelineDevicePin: async () => pin,
    inferenceRotation: new RoundRobinInferenceDeviceRotation(),
    attachOn: async (_nodeId: string, config: RunnerCameraConfig) => {
      attached.push(config)
    },
    detachOn: async () => {},
    recordAssignment: (deviceId) => {
      recorded.push(deviceId)
    },
    dropAssignment: () => {},
    reconcilePlacementFromRunners: async () => {},
    getActiveDetectionConfig: () => onMotionConfig(),
    dropActiveDetection: () => {},
    listZones: async () => [],
    readPipelinePin: async () => null,
    logger: capturing,
  }
  return {
    controller: new SessionDispatchController(deps),
    attached,
    recorded,
    errors,
    infos,
    setPin: (deviceKey) => {
      pin = deviceKey
    },
  }
}

const REFUSED = 'detection session refused — the elected device cannot run the camera root'

describe('an on-motion session on a device that cannot run the camera root (D650)', () => {
  it('is refused: no attach, no assignment, and the reason is exposed', async () => {
    const h = await makeHarness()

    await h.controller.handleSessionMotion(DEVICE_ID, true, undefined, 'analyzer', CAMERA_TRIGGER)

    expect(h.attached).toEqual([])
    expect(h.recorded).toEqual([])
    expect(h.errors.filter((e) => e === REFUSED)).toHaveLength(1)
    expect(h.controller.refusalReason(DEVICE_ID)).toBe(`root-unrunnable:${NODE}/${ANE}`)
  })

  it('says it ONCE per change of state, not on every motion edge', async () => {
    const h = await makeHarness()

    await h.controller.handleSessionMotion(DEVICE_ID, true, undefined, 'analyzer', CAMERA_TRIGGER)
    await h.controller.handleSessionMotion(DEVICE_ID, true, undefined, 'analyzer', CAMERA_TRIGGER)
    await h.controller.handleSessionMotion(DEVICE_ID, true, undefined, 'analyzer', CAMERA_TRIGGER)

    expect(h.errors.filter((e) => e === REFUSED)).toHaveLength(1)
  })

  it('a session that opens clears the refusal, and says so', async () => {
    const h = await makeHarness()
    await h.controller.handleSessionMotion(DEVICE_ID, true, undefined, 'analyzer', CAMERA_TRIGGER)
    expect(h.controller.refusalReason(DEVICE_ID)).toBeDefined()

    h.setPin(CORAL)
    await h.controller.handleSessionMotion(DEVICE_ID, true, undefined, 'analyzer', CAMERA_TRIGGER)

    expect(h.attached).toHaveLength(1)
    expect(h.attached[0]?.deviceKey).toBe(CORAL)
    expect(h.controller.refusalReason(DEVICE_ID)).toBeUndefined()
    expect(h.infos.some((m) => m.startsWith('detection session refusal cleared'))).toBe(true)
  })

  it('stopping the camera forgets its refusal', async () => {
    const h = await makeHarness()
    await h.controller.handleSessionMotion(DEVICE_ID, true, undefined, 'analyzer', CAMERA_TRIGGER)

    await h.controller.stopForDevice(DEVICE_ID)

    expect(h.controller.refusalReason(DEVICE_ID)).toBeUndefined()
  })
})
