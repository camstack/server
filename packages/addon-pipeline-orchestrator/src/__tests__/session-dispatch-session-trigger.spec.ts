/**
 * The session attach carries WHAT OPENED the session (`sessionTrigger`, D672
 * rule 11 as amended 2026-10-06), so the runner's `DetectionPhaseTransition`
 * names the real motion — the camera's own, or an attached sensor by id and
 * name — instead of the `analyzer` it used to claim on onboard-only cameras.
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
  buildSessionTrigger,
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

function makeHarness(
  detectionSources: DetectionSources,
  sensorNameOf?: SessionDispatchControllerDeps['sensorNameOf'],
): {
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
    ...(sensorNameOf ? { sensorNameOf } : {}),
  }
  return { controller: new SessionDispatchController(deps), attached }
}

describe('dispatchDetectionSession — the session trigger rides the attach', () => {
  it('the camera own motion: source onboard, triggeredBy camera', async () => {
    const h = makeHarness(['pipeline'])
    await h.controller.handleSessionMotion(DEVICE_ID, true, undefined, 'onboard', CAMERA_TRIGGER)
    expect(h.attached).toHaveLength(1)
    expect(h.attached[0]!.sessionTrigger).toEqual({
      source: 'onboard',
      triggeredBy: { kind: 'camera' },
    })
  })

  it('an attached sensor: its deviceId and its resolved name', async () => {
    const h = makeHarness(['pipeline'], (cameraId, sensorId) =>
      cameraId === DEVICE_ID && sensorId === 3299 ? 'PIR front door' : undefined,
    )
    await h.controller.handleSessionMotion(DEVICE_ID, true, undefined, 'onboard', {
      kind: 'sensor',
      deviceId: 3299,
    })
    expect(h.attached[0]!.sessionTrigger).toEqual({
      source: 'onboard',
      triggeredBy: { kind: 'sensor', deviceId: 3299 },
      sensorName: 'PIR front door',
    })
  })
})

describe('buildSessionTrigger', () => {
  it('a sensor whose name is not resolved keeps its deviceId and names nothing else', () => {
    expect(
      buildSessionTrigger(DEVICE_ID, 'onboard', { kind: 'sensor', deviceId: 7 }, () => undefined),
    ).toEqual({ source: 'onboard', triggeredBy: { kind: 'sensor', deviceId: 7 } })
  })

  it('never asks a name for the camera itself', () => {
    let asked = false
    const t = buildSessionTrigger(DEVICE_ID, 'device-activity', CAMERA_TRIGGER, () => {
      asked = true
      return 'x'
    })
    expect(t).toEqual({ source: 'device-activity', triggeredBy: { kind: 'camera' } })
    expect(asked).toBe(false)
  })
})
