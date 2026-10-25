/**
 * D737 through `runInference`: a camera whose root is YOLO26-seg and whose
 * `segmentation` step is on — the step is not dispatched, the root's mask is
 * the detection's mask with the step's `refinedBbox`, and one INFO line says
 * the root supplies the step. With the plain root the step is dispatched.
 */
import {
  type FrameInput,
  type FrameResult,
  type DecodedFrame,
  type PipelineStepInput,
  type RunnerCameraConfig,
  type SystemEvent,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PipelineRunnerAddon from '../index.js'

/**
 * TEST TYPE BOUNDARY: `onInitialize`, `runInference` and `emitInferenceResult`
 * are private to the addon; same internals view as the packageLooked spec.
 */
interface AddonInternals {
  onInitialize(): Promise<unknown>
  runInference(deviceId: number, frame: FrameInput): Promise<FrameResult | null>
  emitInferenceResult(
    deviceId: number,
    frame: DecodedFrame,
    result: FrameResult,
    handle: undefined,
  ): void
}
function asInternals(addon: PipelineRunnerAddon): AddonInternals {
  return addon as unknown as AddonInternals
}

/** A 2×2 mask, top row on: its largest component is the box's top half. */
const MASK = Buffer.from(Uint8Array.from([255, 255, 0, 0])).toString('base64')

const RESULT: FrameResult = {
  kind: 'frame',
  frameId: 'f',
  deviceId: 101,
  timestamp: 0,
  width: 640,
  height: 480,
  detections: [
    {
      id: 'd1',
      kind: 'first-level',
      macroClass: 'person',
      score: 0.83,
      bbox: { x: 10, y: 20, width: 40, height: 60 },
      labels: [],
      mask: MASK,
      maskWidth: 2,
      maskHeight: 2,
    },
  ],
}

const FRAME: FrameInput = {
  data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
  width: 640,
  height: 480,
  format: 'jpeg',
  timestamp: 1000,
}

function tree(rootModelId: string): readonly PipelineStepInput[] {
  return [
    {
      addonId: 'object-detection',
      modelId: rootModelId,
      enabled: true,
      children: [{ addonId: 'segmentation', modelId: 'u2netp', enabled: true }],
    },
  ]
}

function makeCtx() {
  const runPipeline = vi.fn().mockResolvedValue(RESULT)
  const emitted: SystemEvent[] = []
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
    eventBus: {
      emit: (e: SystemEvent) => {
        emitted.push(e)
      },
      subscribe: () => () => {},
      getRecent: () => [],
    },
    api: {
      addons: {
        listCapabilityProviders: {
          query: vi.fn().mockResolvedValue([{ addonId: 'model-studio', isActive: true }]),
        },
      },
      customModelRegistry: {
        listModels: {
          query: vi.fn().mockResolvedValue([]),
        },
      },
      pipelineExecutor: {
        runFrame: { mutate: vi.fn().mockResolvedValue(RESULT) },
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
  return { ctx, runPipeline, emitted, logger }
}

const CONFIG: RunnerCameraConfig = {
  deviceId: 101,
  detectionMode: 'on-motion',
  audioMode: 'always-on',
  motionCooldownMs: 10_000,
  motionFps: 4,
  detectionFps: 10,
  motionStreamId: 'low',
  detectionStreamId: 'low',
  motionSources: ['onboard'],
  pipelineEnabled: true,
  onboardMotionDrivesAnalyzer: false,
  preRollInferenceEnabled: false,
  preRollInferenceFrames: 0,
  occupancyRecheckEnabled: false,
  occupancyRecheckSec: 0,
  occupancyRecheckFrames: 0,
  steps: tree('yolo26n-seg'),
}

describe('mask supply through runInference', () => {
  let addon: PipelineRunnerAddon

  beforeEach(() => {
    addon = new PipelineRunnerAddon()
  })

  afterEach(async () => {
    await addon.shutdown().catch(() => {})
  })

  it('a seg root: segmentation is not dispatched and the root mask is the result', async () => {
    const { ctx, runPipeline } = makeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()
    await addon.attachCamera(CONFIG)
    const result = await asInternals(addon).runInference(101, FRAME)
    const steps: readonly PipelineStepInput[] = runPipeline.mock.calls[0]?.[0]?.steps ?? []
    expect(steps.map((s) => s.addonId)).toEqual(['object-detection'])
    expect(steps[0]?.children ?? []).toEqual([])
    const d = result?.detections[0]
    expect(d?.mask).toBe(MASK)
    expect(d?.refinedBbox).toEqual({ x: 10, y: 20, width: 40, height: 30 })
  })

  it('a plain root: segmentation runs its own model', async () => {
    const { ctx, runPipeline } = makeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()
    await addon.attachCamera({ ...CONFIG, steps: tree('yolo26n') })
    await asInternals(addon).runInference(101, FRAME)
    const steps: readonly PipelineStepInput[] = runPipeline.mock.calls[0]?.[0]?.steps ?? []
    expect((steps[0]?.children ?? []).map((c) => c.addonId)).toEqual(['segmentation'])
  })

  it('logs that the root supplies segmentation, once', async () => {
    const { ctx, logger } = makeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    Object.defineProperty(addon, '_ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()
    await addon.attachCamera(CONFIG)
    await asInternals(addon).runInference(101, FRAME)
    await asInternals(addon).runInference(101, FRAME)
    const lines = logger.info.mock.calls.filter(
      (c) =>
        c[0] === 'root model supplies a pipeline step — the step is not dispatched' &&
        (c[1] as { meta: { stepId: string } }).meta.stepId === 'segmentation',
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]?.[1]).toMatchObject({
      tags: { deviceId: 101 },
      meta: { rootModelId: 'yolo26n-seg', kind: 'mask' },
    })
  })
})
