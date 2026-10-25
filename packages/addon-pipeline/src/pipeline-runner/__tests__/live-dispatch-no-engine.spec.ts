/**
 * Task 7 — engine-node-local refactor: the LIVE per-camera dispatch must
 * stop forwarding the attach-payload engine into `runPipeline`. The
 * detection-pipeline provider now resolves the executing node's own
 * engine; a stale/foreign `engine` on the attach payload (e.g. an
 * orchestrator that hasn't migrated yet, or a leftover cached config)
 * must never leak into the live `pipelineExecutor.runPipeline.mutate`
 * call. Since D646 no caller sends one at all — the benchmark's per-run
 * engine override is gone from the cap — and this spec keeps pinning the
 * live `runInference` dispatch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import PipelineRunnerAddon from '../index.js'
import type {
  RunnerCameraConfig,
  FrameInput,
  FrameResult,
  PipelineStepInput,
} from '@camstack/types'

/**
 * Typed accessor for the two private entry points the dispatch test needs
 * to drive: `onInitialize` (boots the internal scheduler) and
 * `runInference` (the routing function under test). Mirrors the accessor
 * in `runner-addon-dispatch.spec.ts`.
 */
interface AddonInternals {
  onInitialize(): Promise<unknown>
  runInference(deviceId: number, frame: FrameInput): Promise<FrameResult | null>
}

function asInternals(addon: PipelineRunnerAddon): AddonInternals {
  return addon as unknown as AddonInternals
}

function makeFrameInput(): FrameInput {
  return {
    data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    width: 640,
    height: 480,
    format: 'jpeg',
    timestamp: 1000,
  }
}

function makePipelineResult(): FrameResult {
  return {
    kind: 'frame',
    frameId: 'test-frame',
    deviceId: 1,
    timestamp: 0,
    width: 640,
    height: 480,
    detections: [],
    debug: { totalInferenceMs: 10 },
  }
}

const STEPS: readonly PipelineStepInput[] = [
  {
    addonId: 'object-detection',
    modelId: 'yolov8n',
    enabled: true,
    children: [],
  },
]

function makeFakeCtx() {
  const runFrame = vi.fn().mockResolvedValue(makePipelineResult())
  const runPipeline = vi.fn().mockResolvedValue(makePipelineResult())
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this
    }),
    withTags: vi.fn(function (this: unknown) {
      return this
    }),
  }
  const ctx = {
    id: 'pipeline-runner',
    logger,
    kernel: { localNodeId: 'hub' },
    eventBus: { emit: vi.fn(), subscribe: () => () => {}, getRecent: () => [] },
    api: {
      pipelineExecutor: {
        runFrame: { mutate: runFrame },
        runPipeline: { mutate: runPipeline },
      },
      streamBroker: {},
    },
    settings: {
      readAddonStore: vi.fn(async () => ({})),
      writeAddonStore: vi.fn(async () => undefined),
      readDeviceStore: vi.fn(async () => ({})),
      writeDeviceStore: vi.fn(async () => undefined),
      getSection: vi.fn(async () => ({})),
      setSection: vi.fn(async () => undefined),
    },
  }
  return { ctx, runFrame, runPipeline, logger }
}

function makeConfig(patch: Partial<RunnerCameraConfig> = {}): RunnerCameraConfig {
  return {
    deviceId: 42,
    detectionMode: 'on-motion',
    audioMode: 'always-on',
    motionCooldownMs: 10_000,
    motionFps: 4,
    detectionFps: 10,
    motionStreamId: 'low',
    detectionStreamId: 'low',
    motionSources: ['onboard'], // skips motion broker subscribe
    pipelineEnabled: true,
    onboardMotionDrivesAnalyzer: false,
    // Off, as an absent value read at runtime: these specs are not about them.
    preRollInferenceEnabled: false,
    preRollInferenceFrames: 0,
    occupancyRecheckEnabled: false,
    occupancyRecheckSec: 0,
    occupancyRecheckFrames: 0,
    ...patch,
  }
}

describe('live dispatch omits attach engine (node-local)', () => {
  let addon: PipelineRunnerAddon

  beforeEach(() => {
    addon = new PipelineRunnerAddon()
  })

  afterEach(async () => {
    await addon.shutdown().catch(() => {
      /* ignore */
    })
  })

  it('never forwards `engine` into runPipeline.mutate, even when the attach payload carries one', async () => {
    const { ctx, runPipeline } = makeFakeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()

    // The attach payload still carries an engine (stale orchestrator, cached
    // config, or migration straggler) — the live dispatch must strip it
    // regardless. The provider resolves the node's own engine. A named value,
    // not a literal: the field is not in the type, and that is the point.
    const staleAttach = {
      deviceId: 99,
      engine: { runtime: 'python', backend: 'coreml', format: 'coreml' },
      steps: STEPS,
    }
    await addon.attachCamera(makeConfig(staleAttach))

    await asInternals(addon).runInference(99, makeFrameInput())

    expect(runPipeline).toHaveBeenCalledTimes(1)
    const input = runPipeline.mock.calls[0]![0] as Record<string, unknown>
    expect('engine' in input).toBe(false)
    expect(input['steps']).toEqual(STEPS)
    expect(input['deviceId']).toBe(99)
  })
})
