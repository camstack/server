/**
 * End-to-end gates for inference-device selection on the ON-MOTION dispatch
 * path (`handleSessionMotion` → `dispatchDetectionSession`).
 *
 * These exist because the unit tests in `device-balancer.spec.ts` pass whether
 * or not the rotation is actually WIRED into the dispatcher, and because the
 * selection produced no log line at all — the two failures that together let a
 * fully enabled, available, uncapped, unpinned NPU sit idle indefinitely while
 * every session went to the iGPU.
 */
import { CAMERA_TRIGGER } from '@camstack/types'
import type {
  CameraDetectionConfig,
  IScopedLogger,
  LogTags,
  RunnerCameraConfig,
  RunnerDeviceLoad,
  RunnerLocalLoad,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { RoundRobinInferenceDeviceRotation } from '../device-balancer.js'
import {
  SessionDispatchController,
  type SessionDispatchControllerDeps,
} from '../session-dispatch-controller.js'

const NODE = 'hub'
/** The two OpenVINO devices the live hub reports: both enabled, both available. */
const HUB_DEVICES: Record<string, number> = { 'openvino:npu': 1, 'openvino:gpu': 1 }

interface LogLine {
  readonly message: string
  readonly tags?: LogTags
  readonly meta?: Readonly<Record<string, unknown>>
}

interface LogEntry {
  readonly tags?: LogTags
  readonly meta?: Readonly<Record<string, unknown>>
}

/** Logger that records every `info` line, merging the tags bound via `withTags`. */
function recordingLogger(lines: LogLine[], bound: LogTags = {}): IScopedLogger {
  const log: Partial<IScopedLogger> = {
    info: (message: string, entry?: LogEntry) => {
      lines.push({ message, tags: { ...bound, ...entry?.tags }, meta: entry?.meta })
    },
    warn: () => {},
    error: () => {},
    debug: () => {},
  }
  log.withTags = (tags: LogTags) => recordingLogger(lines, { ...bound, ...tags })
  return log as IScopedLogger
}

function fakeLoad(deviceLoads: Readonly<Record<string, number>>): RunnerLocalLoad {
  return {
    nodeId: NODE,
    attachedCameras: 0,
    activeCameras: 0,
    avgInferenceFps: 0,
    avgInferenceTimeMs: 0,
    queueDepthTotal: 0,
    devices: Object.entries(deviceLoads).map(
      ([deviceKey, attachedCameras]): RunnerDeviceLoad => ({
        deviceKey,
        backend: deviceKey.split(':')[0]!,
        attachedCameras,
      }),
    ),
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

/** Attach payloads carry `deviceKey` structurally; widen without a cast. */
interface AttachedView {
  readonly deviceId: number
  readonly deviceKey?: string
}

interface Harness {
  readonly controller: SessionDispatchController
  readonly attached: AttachedView[]
  readonly lines: LogLine[]
}

interface HarnessOptions {
  readonly eligible?: Record<string, number>
  readonly caps?: Record<string, number>
  readonly pin?: string | null
  /** Live per-device session counts the node reports (`getLocalLoad().devices`). */
  readonly deviceLoads?: Record<string, number>
}

/**
 * One controller with ONE rotation — the production wiring, where every camera
 * on a node draws from the same rotation.
 */
function makeHarness(options: HarnessOptions = {}): Harness {
  const attached: AttachedView[] = []
  const lines: LogLine[] = []
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
      collectAgentLoad: async () => [fakeLoad(options.deviceLoads ?? {})],
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
    getEligibleInferenceDevices: async () => ({ ...(options.eligible ?? HUB_DEVICES) }),
    isNodeInferenceUsable: () => true,
    getInferenceDeviceCaps: async () => ({ ...options.caps }),
    readPipelineDevicePin: async () => options.pin ?? null,
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
    logger: recordingLogger(lines),
  }
  return { controller: new SessionDispatchController(deps), attached, lines }
}

/** The selection lines, in dispatch order. */
function selectionLines(harness: Harness): LogLine[] {
  return harness.lines.filter((l) => l.message === 'inference device selection')
}

describe('on-motion dispatch — the accelerator must not sit idle', () => {
  let harness: Harness

  beforeEach(() => {
    harness = makeHarness()
  })

  it('spreads successive non-overlapping sessions across BOTH devices', async () => {
    // The live shape: four cameras, sessions that never overlap, so every
    // dispatch sees an idle node and every dispatch is a tie. Before the fix
    // all four landed on `openvino:gpu` and the NPU never ran a session.
    for (const deviceId of [101, 102, 103, 104]) {
      await harness.controller.handleSessionMotion(
        deviceId,
        true,
        undefined,
        'analyzer',
        CAMERA_TRIGGER,
      )
    }
    const keys = harness.attached.map((c) => c.deviceKey)
    expect(keys).toEqual(['openvino:gpu', 'openvino:npu', 'openvino:gpu', 'openvino:npu'])
    expect(new Set(keys)).toEqual(new Set(['openvino:gpu', 'openvino:npu']))
  })

  it('logs ONE selection line per dispatch, tagged with the numeric deviceId', async () => {
    await harness.controller.handleSessionMotion(101, true, undefined, 'analyzer', CAMERA_TRIGGER)
    await harness.controller.handleSessionMotion(102, true, undefined, 'analyzer', CAMERA_TRIGGER)

    const selections = selectionLines(harness)
    expect(selections).toHaveLength(2)
    expect(selections.map((l) => l.tags?.deviceId)).toEqual([101, 102])
    expect(selections.map((l) => l.tags?.nodeId)).toEqual([NODE, NODE])
  })

  it('the line names the eligible set, the chosen key and the reason', async () => {
    await harness.controller.handleSessionMotion(101, true, undefined, 'analyzer', CAMERA_TRIGGER)

    expect(selectionLines(harness)[0]?.meta).toEqual({
      path: 'session',
      eligible: ['openvino:gpu', 'openvino:npu'],
      chosen: 'openvino:gpu',
      reason: 'tie-break',
      tied: ['openvino:gpu', 'openvino:npu'],
      tieBreak: 'rotation',
    })
  })

  it('a pin still wins, and the line says so', async () => {
    const pinned = makeHarness({ pin: 'openvino:npu' })
    await pinned.controller.handleSessionMotion(101, true, undefined, 'analyzer', CAMERA_TRIGGER)
    await pinned.controller.handleSessionMotion(102, true, undefined, 'analyzer', CAMERA_TRIGGER)

    expect(pinned.attached.map((c) => c.deviceKey)).toEqual(['openvino:npu', 'openvino:npu'])
    expect(selectionLines(pinned)[0]?.meta).toMatchObject({
      chosen: 'openvino:npu',
      reason: 'pin',
      pin: 'openvino:npu',
    })
  })

  it('a device at its maxSessions cap leaves the tie entirely — the rotation cannot reach it', async () => {
    // The gpu is at 1/1: not a candidate at all, so there is no tie and every
    // dispatch lands on the npu. Fairness must never override a hard cap.
    const capped = makeHarness({
      caps: { 'openvino:gpu': 1 },
      deviceLoads: { 'openvino:gpu': 1 },
    })
    for (const deviceId of [101, 102, 103]) {
      await capped.controller.handleSessionMotion(
        deviceId,
        true,
        undefined,
        'analyzer',
        CAMERA_TRIGGER,
      )
    }
    expect(capped.attached.map((c) => c.deviceKey)).toEqual([
      'openvino:npu',
      'openvino:npu',
      'openvino:npu',
    ])
    expect(selectionLines(capped)[0]?.meta).toMatchObject({
      eligible: ['openvino:gpu', 'openvino:npu'],
      chosen: 'openvino:npu',
      reason: 'capacity',
      tied: ['openvino:npu'],
    })
  })

  it('a single eligible device logs the default-pool fallback rather than nothing', async () => {
    const single = makeHarness({ eligible: { 'openvino:gpu': 1 } })
    await single.controller.handleSessionMotion(101, true, undefined, 'analyzer', CAMERA_TRIGGER)

    expect(single.attached[0]?.deviceKey).toBeUndefined()
    expect(selectionLines(single)[0]?.meta).toEqual({
      path: 'session',
      eligible: ['openvino:gpu'],
      chosen: null,
      reason: 'single-eligible-device',
    })
  })

  it('an empty eligible set is AUDIBLE (the silent case that hid the bug)', async () => {
    const none = makeHarness({ eligible: {} })
    await none.controller.handleSessionMotion(101, true, undefined, 'analyzer', CAMERA_TRIGGER)

    expect(selectionLines(none)[0]?.meta).toMatchObject({
      eligible: [],
      chosen: null,
      reason: 'no-eligible-device',
    })
  })
})
