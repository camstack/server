/**
 * D1065 — a step switch re-attaches only the cameras it changed, and a root
 * switched off on a camera's elected device re-elects that camera. Driven
 * through the addon: the three real setters, the real placement service, a
 * fake runner that records every attach.
 */
import type {
  CameraDetectionConfig,
  InferenceDeviceDescriptor,
  IScopedLogger,
} from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import { CORAL, CORAL_GPU_CATALOG, GPU } from './attach-pipeline-fixtures.js'
import {
  type FakeRunner,
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  makeSilentLogger,
  wireRunnerToBroker,
} from './e2e-helpers.js'

const NODE = 'agent-a'

function probe(
  key: string,
  backend: string,
  format: 'tflite' | 'openvino' | 'onnx',
): InferenceDeviceDescriptor {
  return { key, backend, device: key, format, runtime: 'python', score: 1, available: true }
}

const PROBED = [probe(CORAL, 'edgetpu', 'tflite'), probe(GPU, 'openvino', 'openvino')]
const BOTH_ON = { [CORAL]: { enabled: true, weight: 1 }, [GPU]: { enabled: true, weight: 1 } }

function detection(): CameraDetectionConfig {
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
  }
}

interface WarnLine {
  readonly message: string
  readonly deviceId: unknown
  readonly reason: unknown
}

describe('step switch re-attach (D1065)', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  async function boot(
    logger?: IScopedLogger,
  ): Promise<{ addon: PipelineOrchestratorAddon; runner: FakeRunner }> {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: NODE })
    wireRunnerToBroker(broker, NODE, runner)
    broker.addNode(NODE)
    const { ctx } = makeFakeContext({
      ...(logger ? { logger } : {}),
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: [NODE] },
      providers: {
        'pipeline-executor': { getSchema: async () => CORAL_GPU_CATALOG },
        'platform-probe': {
          getCapabilities: () => ({ nodeId: NODE, reachable: true, devices: PROBED }),
        },
      },
    })
    const booted = new PipelineOrchestratorAddon()
    await booted.initialize(ctx)
    await booted.setAgentInferenceDevices({ agentNodeId: NODE, inferenceDevices: BOTH_ON })
    addon = booted
    return { addon: booted, runner }
  }

  /** Two always-on cameras: 101 elects the Coral, 102 the GPU. */
  async function bootWithCameras(logger?: IScopedLogger): Promise<{
    addon: PipelineOrchestratorAddon
    runner: FakeRunner
    attachesSince: (deviceId: number) => number
  }> {
    const booted = await boot(logger)
    await booted.addon.startDetection(101, detection())
    await booted.addon.startDetection(102, detection())
    expect(booted.runner.attachedCameras.get(101)?.deviceKey).toBe(CORAL)
    expect(booted.runner.attachedCameras.get(102)?.deviceKey).toBe(GPU)
    const baseline = (id: number): number =>
      booted.runner.attachHistory.filter((h) => h.action === 'attach' && h.deviceId === id).length
    const before = { 101: baseline(101), 102: baseline(102) }
    return {
      ...booted,
      attachesSince: (id) => baseline(id) - (id === 101 ? before[101] : before[102]),
    }
  }

  function faceOf(runner: FakeRunner, deviceId: number): boolean {
    const root = runner.attachedCameras
      .get(deviceId)
      ?.steps?.find((s) => s.addonId === 'object-detection')
    return (root?.children ?? []).some((c) => c.addonId === 'face-detection')
  }

  /** Camera 101 turns face-detection OFF itself: it never runs the step, whatever is switched. */
  async function bootWithFaceOffCamera(): Promise<Awaited<ReturnType<typeof bootWithCameras>>> {
    const booted = await bootWithCameras()
    await booted.addon.setCameraStepToggle({
      deviceId: 101,
      addonId: 'face-detection',
      enabled: false,
    })
    expect(faceOf(booted.runner, 101)).toBe(false)
    expect(faceOf(booted.runner, 102)).toBe(true)
    return booted
  }

  it('a cluster switch re-attaches only the cameras whose pipeline changed', async () => {
    const { addon: a, runner, attachesSince } = await bootWithFaceOffCamera()
    const from101 = attachesSince(101)
    const from102 = attachesSince(102)

    await a.setClusterStepMode({ stepId: 'face-detection', mode: 'off' })

    expect(faceOf(runner, 102)).toBe(false)
    expect(attachesSince(102) - from102).toBe(1)
    // Camera 101 never ran the step: its attach is not touched.
    expect(attachesSince(101) - from101).toBe(0)
  })

  it('a node switch re-attaches only the cameras whose pipeline changed', async () => {
    const { addon: a, runner, attachesSince } = await bootWithFaceOffCamera()
    const from101 = attachesSince(101)
    const from102 = attachesSince(102)

    await a.setNodeStepEnabled({ agentNodeId: NODE, stepId: 'face-detection', enabled: false })

    expect(faceOf(runner, 102)).toBe(false)
    expect(attachesSince(102) - from102).toBe(1)
    expect(attachesSince(101) - from101).toBe(0)
  })

  it('a device switch re-attaches the cameras whose steps or roster changed, once', async () => {
    const { addon: a, runner, attachesSince } = await bootWithCameras()
    const from101 = attachesSince(101)
    const from102 = attachesSince(102)

    await a.setDeviceStepEnabled({
      agentNodeId: NODE,
      deviceKey: GPU,
      stepId: 'face-detection',
      enabled: false,
    })
    // The GPU camera loses the step; the Coral camera loses the jump to it.
    expect(faceOf(runner, 101)).toBe(false)
    expect(faceOf(runner, 102)).toBe(false)
    expect(attachesSince(101) - from101).toBe(1)
    expect(attachesSince(102) - from102).toBe(1)

    // The same switch again resolves to the same attach: nobody re-attaches.
    await a.setDeviceStepEnabled({
      agentNodeId: NODE,
      deviceKey: GPU,
      stepId: 'face-detection',
      enabled: false,
    })
    expect(attachesSince(101) - from101).toBe(1)
    expect(attachesSince(102) - from102).toBe(1)
  })

  it('nothing set leaves every camera as it was', async () => {
    const { addon: a, attachesSince } = await bootWithCameras()
    await a.setClusterStepMode({ stepId: 'face-detection', mode: null })
    await a.setNodeStepEnabled({ agentNodeId: NODE, stepId: 'face-detection', enabled: null })
    await a.setDeviceStepEnabled({
      agentNodeId: NODE,
      deviceKey: GPU,
      stepId: 'face-detection',
      enabled: null,
    })
    expect(attachesSince(101)).toBe(0)
    expect(attachesSince(102)).toBe(0)
  })

  it('the root switched off on the elected device re-elects the camera off that device', async () => {
    const { addon: a, runner } = await bootWithCameras()

    await a.setDeviceStepEnabled({
      agentNodeId: NODE,
      deviceKey: CORAL,
      stepId: 'object-detection',
      enabled: false,
    })

    // The GPU is the only eligible device left, so the camera rides the node's
    // default pool — never the Coral — and still carries its root.
    const moved = runner.attachedCameras.get(101)
    expect(moved?.deviceKey).not.toBe(CORAL)
    expect(moved?.steps?.some((s) => s.addonId === 'object-detection')).toBe(true)
    expect(addon?.getPipelineAssignment({ deviceId: 101 })?.agentNodeId).toBe(NODE)
  })

  it('a root nothing can host is named with the camera tag, never silent', async () => {
    const lines: WarnLine[] = []
    const logger: IScopedLogger = {
      ...makeSilentLogger(),
      warn: (message, ctx) =>
        void lines.push({ message, deviceId: ctx?.tags?.deviceId, reason: ctx?.meta?.['reason'] }),
    }
    const { addon: a } = await bootWithCameras(logger)

    await a.setNodeStepEnabled({ agentNodeId: NODE, stepId: 'object-detection', enabled: false })

    const named = lines.filter((l) => l.message.includes('no device able to host the camera root'))
    expect(named.map((l) => l.deviceId).toSorted()).toEqual([101, 102])
    expect(named.every((l) => typeof l.reason === 'string' && l.reason.length > 0)).toBe(true)
  })
})
