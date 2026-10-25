/**
 * D650 round 4 — a REFUSED on-motion session reaches the operator.
 *
 * Through the whole addon: an on-motion camera whose only node cannot run the
 * camera root on the pool the session elects. The session is refused (no
 * attach, no assignment), and `getCameraStatus` — the surface where a standing
 * camera's `pending:<reason>` already appears — says
 * `pending:root-unrunnable:<node>/<device>` instead of `armed:on-motion`. The
 * bootstrap wiring under test: the status reads the ledger's pending reason,
 * then the session controller's last refusal.
 */
import { EventCategory, type CameraDetectionConfig, type PipelineSchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import {
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  wireRunnerToBroker,
} from './e2e-helpers.js'

const NODE = 'agent-a'
const DEVICE_ID = 903

function build(
  formats: readonly string[],
): Record<string, { downloaded: boolean; sizeMB: number }> {
  return Object.fromEntries(formats.map((f) => [f, { downloaded: true, sizeMB: 1 }]))
}

/**
 * The root ships a tflite build only, the node's own engine is openvino and
 * its one device is openvino: the guard excludes the device, the session falls
 * to the default pool, and the resolve cannot run the root there.
 */
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
          defaultModelId: 'ssd',
          defaultConfidence: 0.5,
          models: [{ id: 'ssd', name: 'ssd', formats: build(['tflite']) }],
        },
      ],
    },
  ],
}

function onMotionConfig(): CameraDetectionConfig {
  return {
    enabled: true,
    pipelineEnabled: true,
    motionSources: ['onboard'],
    motionStreamId: 'sub',
    detectionStreamId: 'main',
    motionFps: 4,
    detectionFps: 10,
    motionCooldownMs: 10_000,
    detectionMode: 'on-motion',
    audioMode: 'disabled',
    onboardMotionDrivesAnalyzer: true,
    occupancyRecheckEnabled: false,
    occupancyRecheckSec: 30,
    occupancyRecheckFrames: 4,
    preRollInferenceEnabled: false,
    preRollInferenceFrames: 0,
  }
}

describe('a refused on-motion session shows in the camera status (D650 round 4)', () => {
  let addon: PipelineOrchestratorAddon | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('reasons.detection goes from armed:on-motion to pending:root-unrunnable:<node>/<device>', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: NODE })
    wireRunnerToBroker(broker, NODE, runner)
    broker.addNode(NODE)
    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: [NODE] },
      providers: {
        'pipeline-executor': { getSchema: async () => CATALOG },
        'platform-probe': {
          getCapabilities: () => ({
            nodeId: NODE,
            reachable: true,
            devices: [
              {
                key: 'openvino:npu',
                backend: 'openvino',
                device: 'npu',
                format: 'openvino',
                runtime: 'python',
                score: 10,
                available: true,
              },
            ],
          }),
        },
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)
    const live = addon
    await live.setAgentInferenceDevices({
      agentNodeId: NODE,
      inferenceDevices: { 'openvino:npu': { enabled: true } },
    })
    await live.startDetection(DEVICE_ID, onMotionConfig())

    // Armed, idle, healthy so far.
    const idle = await live.getCameraStatus({ deviceId: DEVICE_ID })
    expect(idle.assignment.reasons.detection).toBe('armed:on-motion')

    eventBus.emit({
      id: 'evt-motion-refused',
      timestamp: new Date(),
      source: { type: 'device', id: DEVICE_ID },
      category: EventCategory.MotionOnMotionChanged,
      data: { deviceId: DEVICE_ID, detected: true, timestamp: Date.now(), source: 'onboard' },
    })

    // `vi.waitFor`, not the helpers' `waitUntil`: that one takes a SYNC
    // predicate, and an async one is a Promise — always truthy, never polled.
    await vi.waitFor(async () => {
      const status = await live.getCameraStatus({ deviceId: DEVICE_ID })
      expect(status.assignment.reasons.detection).toBe(
        `pending:root-unrunnable:${NODE}/default-pool`,
      )
    })
    expect(live.getPipelineAssignment({ deviceId: DEVICE_ID })).toBeNull()
    expect(runner.attachedCameras.has(DEVICE_ID)).toBe(false)
  })
})
