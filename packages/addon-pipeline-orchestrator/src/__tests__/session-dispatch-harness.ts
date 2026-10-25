/**
 * A `SessionDispatchController` over in-memory fakes, for the specs that drive
 * `handleSessionMotion` end to end and read what it logged and attached:
 * `session-motion-source-gate.spec.ts` (the `motionSources` gate) and
 * `session-triggered-by.spec.ts` (D672: the trigger that opened a session).
 */
import type {
  CameraDetectionConfig,
  IScopedLogger,
  MotionSources,
  RunnerCameraConfig,
  RunnerLocalLoad,
} from '@camstack/types'
import { RoundRobinInferenceDeviceRotation } from '../device-balancer.js'
import {
  SessionDispatchController,
  type SessionDispatchControllerDeps,
} from '../session-dispatch-controller.js'

export const NODE = 'hub'

export interface LogLine {
  readonly message: string
  readonly tags: Record<string, unknown>
  readonly meta: Record<string, unknown>
}

interface LogOpts {
  readonly tags?: Record<string, unknown>
  readonly meta?: Record<string, unknown>
}

function capturingLogger(lines: LogLine[]): IScopedLogger {
  const push = (message: string, opts?: LogOpts): void => {
    lines.push({ message, tags: opts?.tags ?? {}, meta: opts?.meta ?? {} })
  }
  const log: Partial<IScopedLogger> = { info: push, warn: push, error: push, debug: push }
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
    motionSources: ['onboard'],
    motionStreamId: 'sub',
    detectionStreamId: 'main',
    motionFps: 2,
    detectionFps: 6,
    motionCooldownMs: 30_000,
    detectionMode: 'on-motion',
    audioMode: 'disabled',
    onboardMotionDrivesAnalyzer: false,
    occupancyRecheckEnabled: false,
    occupancyRecheckSec: 0,
    occupancyRecheckFrames: 0,
    preRollInferenceEnabled: true,
    preRollInferenceFrames: 12,
  }
}

export interface Harness {
  readonly controller: SessionDispatchController
  readonly lines: LogLine[]
  readonly attached: RunnerCameraConfig[]
  readonly setSources: (next: MotionSources) => void
  /** Holds every `attachOn` until the returned release is called. */
  readonly holdAttach: () => () => void
}

interface HarnessOptions {
  readonly sources: MotionSources
}

interface HarnessState {
  sources: MotionSources
  attachGate: Promise<void> | undefined
}

export function makeHarness(opts: HarnessOptions): Harness {
  const lines: LogLine[] = []
  const attached: RunnerCameraConfig[] = []
  const h: HarnessState = { sources: opts.sources, attachGate: undefined }
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
        config: { steps: [], audio: null },
        droppedRoots: [],
      }),
    } as unknown as SessionDispatchControllerDeps['settingsStore'],
    getEligibleInferenceDevices: async () => ({}),
    isNodeInferenceUsable: () => true,
    getInferenceDeviceCaps: async () => ({}),
    readPipelineDevicePin: async () => null,
    inferenceRotation: new RoundRobinInferenceDeviceRotation(),
    attachOn: async (_nodeId: string, config: RunnerCameraConfig) => {
      if (h.attachGate) await h.attachGate
      attached.push(config)
    },
    detachOn: async () => {},
    recordAssignment: () => {},
    dropAssignment: () => {},
    reconcilePlacementFromRunners: async () => {},
    getActiveDetectionConfig: () => ({ ...fakeDetectionConfig(), motionSources: h.sources }),
    dropActiveDetection: () => {},
    listZones: async () => [],
    readPipelinePin: async () => null,
    logger: capturingLogger(lines),
  }
  return {
    controller: new SessionDispatchController(deps),
    lines,
    attached,
    setSources: (next) => {
      h.sources = next
    },
    holdAttach: () => {
      let release: () => void = () => {}
      h.attachGate = new Promise<void>((resolve) => {
        release = () => {
          h.attachGate = undefined
          resolve()
        }
      })
      return () => release()
    },
  }
}
