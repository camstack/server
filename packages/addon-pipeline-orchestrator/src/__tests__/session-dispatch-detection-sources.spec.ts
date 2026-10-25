/**
 * The session attach carries WHICH ROOT DETECTOR the operator picked.
 *
 * `RunnerCameraConfig.detectionSources` is OPTIONAL, so a build site that
 * forgets it compiles silently — and the transport's `withCapInputDefaults`
 * then fills the gap with the cap's declared default `['pipeline']` before the
 * runner sees the payload. The operator's `['onboard']` was stored, resolved,
 * and carried all the way to the session literal, where it was dropped and
 * replaced by a default that looks exactly like a deliberate choice.
 *
 * It only ever affected ON-MOTION cameras — the always-on branch goes through
 * `buildRunnerConfig`, which carries the field — which is why the feature
 * appeared to work when tested on the wrong camera. On the operator's hub the
 * runner logged `detectionSources=["pipeline"] runsOnboard=false` for a camera
 * whose stored value was `['onboard']`.
 *
 * A default that silently replaces an explicit pick is the worst kind: nothing
 * fails, nothing logs, and the feature is simply inert.
 */
import { CAMERA_TRIGGER } from '@camstack/types'
import type {
  CameraDetectionConfig,
  DetectionSources,
  IScopedLogger,
  RunnerCameraConfig,
  RunnerLocalLoad,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'

import {
  SessionDispatchController,
  type SessionDispatchControllerDeps,
} from '../session-dispatch-controller.js'
import { RoundRobinInferenceDeviceRotation } from '../device-balancer.js'

const NODE = 'hub'
const DEVICE_ID = 106

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

/** An on-motion camera — the branch that drops the field. */
function detectionConfig(detectionSources: DetectionSources): CameraDetectionConfig {
  return {
    enabled: true,
    pipelineEnabled: true,
    motionSources: ['onboard'],
    motionStreamId: 'sub',
    detectionStreamId: 'main',
    motionFps: 2,
    detectionFps: 6,
    motionCooldownMs: 30_000,
    detectionMode: 'on-motion',
    audioMode: 'disabled',
    onboardMotionDrivesAnalyzer: true,
    occupancyRecheckEnabled: true,
    occupancyRecheckSec: 300,
    occupancyRecheckFrames: 4,
    preRollInferenceEnabled: true,
    preRollInferenceFrames: 12,
    detectionSources,
  } as CameraDetectionConfig
}

function makeHarness(detectionSources: DetectionSources): {
  controller: SessionDispatchController
  attached: RunnerCameraConfig[]
} {
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
        new Map(keys.map((k) => [k, { base: {}, override: {} }])),
      resolvePipelineForDeviceWithRoots: async () => ({
        config: {
          steps: [{ addonId: 'object-detection', enabled: true }],
          audio: null,
        },
        droppedRoots: [],
      }),
    } as unknown as SessionDispatchControllerDeps['settingsStore'],
    getEligibleInferenceDevices: async () => ({}),
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
    getActiveDetectionConfig: () => detectionConfig(detectionSources),
    dropActiveDetection: () => {},
    listZones: async () => [],
    readPipelinePin: async () => null,
    logger: fakeLogger(),
  }
  return { controller: new SessionDispatchController(deps), attached }
}

describe('dispatchDetectionSession — the root detector the operator picked', () => {
  it('carries ["onboard"] to the runner, instead of letting the default replace it', async () => {
    const h = makeHarness(['onboard'])
    await h.controller.handleSessionMotion(DEVICE_ID, true, undefined, 'onboard', CAMERA_TRIGGER)
    expect(h.attached).toHaveLength(1)
    expect(h.attached[0]!.detectionSources).toEqual(['onboard'])
  })

  it('carries a BOTH-detectors pick whole', async () => {
    const h = makeHarness(['pipeline', 'onboard'])
    await h.controller.handleSessionMotion(DEVICE_ID, true, undefined, 'onboard', CAMERA_TRIGGER)
    expect(h.attached[0]!.detectionSources).toEqual(['pipeline', 'onboard'])
  })

  // The control: the ordinary pick must still arrive, or a green test above
  // could be satisfied by hard-coding onboard.
  it('carries the ordinary ["pipeline"] pick too', async () => {
    const h = makeHarness(['pipeline'])
    await h.controller.handleSessionMotion(DEVICE_ID, true, undefined, 'onboard', CAMERA_TRIGGER)
    expect(h.attached[0]!.detectionSources).toEqual(['pipeline'])
  })

  // The field must be PRESENT on the payload, not merely equal after defaults.
  // An absent key is what the transport fills in, and that is the whole defect.
  it('sets the key explicitly — an absent one is what the default merge eats', async () => {
    const h = makeHarness(['onboard'])
    await h.controller.handleSessionMotion(DEVICE_ID, true, undefined, 'onboard', CAMERA_TRIGGER)
    expect(Object.hasOwn(h.attached[0]!, 'detectionSources')).toBe(true)
  })
})
