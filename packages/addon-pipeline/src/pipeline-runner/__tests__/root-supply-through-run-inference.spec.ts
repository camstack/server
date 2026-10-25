/**
 * D730 through `runInference`: a camera whose root runs a plus catalog model that
 * supplies `package-detection` and `animal-classifier` (both default ON) — the
 * package root is never dispatched, the root admits `package` at the package
 * step's threshold, every frame is a package look, the linked label carries
 * the detection score, the announce says the classifier is supplied, and one
 * INFO line per (camera, step) says so.
 */
import {
  type DecodedFrame,
  EventCategory,
  type FrameInput,
  type FrameResult,
  plusCatalogLabelFields,
  type ModelCatalogEntry,
  type PipelineInferenceResultPayload,
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

const PLUS_LABELS = ['person', 'car', 'deer', 'dog', 'package'] as const
const PLUS: ModelCatalogEntry = {
  id: 'frigate-plus',
  name: 'plus catalog',
  description: '',
  formats: {},
  inputSize: { width: 320, height: 320 },
  labels: PLUS_LABELS.map((l) => ({ id: l, name: l })),
  provider: 'frigate',
  ...plusCatalogLabelFields(PLUS_LABELS),
}

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
      macroClass: 'animal',
      score: 0.83,
      bbox: { x: 0, y: 0, width: 10, height: 10 },
      labels: [
        {
          label: 'deer',
          score: 0,
          tier: 1,
          stepId: 'detector-link:animal-classifier',
          modelId: 'frigate-plus',
        },
      ],
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

const TREE: readonly PipelineStepInput[] = [
  {
    addonId: 'object-detection',
    modelId: PLUS.id,
    enabled: true,
    children: [
      {
        addonId: 'animal-classifier',
        enabled: true,
        settings: { enabledClasses: ['deer', 'dog'] },
      },
    ],
  },
  { addonId: 'package-detection', enabled: true, settings: { minConfidencePackage: 0.7 } },
]

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
          query: vi.fn().mockResolvedValue([{ stepId: 'object-detection', entry: PLUS }]),
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
  steps: TREE,
}

describe('root supply through runInference', () => {
  let addon: PipelineRunnerAddon

  beforeEach(() => {
    addon = new PipelineRunnerAddon()
  })

  afterEach(async () => {
    await addon.shutdown().catch(() => {})
  })

  it('the package root stands down and the camera root is the package result, every frame', async () => {
    const { ctx, runPipeline } = makeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()
    await addon.attachCamera(CONFIG)

    for (const call of [0, 1]) {
      const result = await asInternals(addon).runInference(101, FRAME)
      const steps: readonly PipelineStepInput[] = runPipeline.mock.calls[call]?.[0]?.steps ?? []
      expect(steps.map((s) => s.addonId)).toEqual(['object-detection'])
      expect(steps[0]?.settings).toMatchObject({
        enabledMacroClasses: ['person', 'vehicle', 'animal', 'package'],
        minConfidencePackage: 0.7,
      })
      expect(result?.packageLooked).toBe(true)
      expect(result?.detections[0]?.labels[0]?.score).toBe(0.83)
    }
  })

  it('announces the animal classifier as filled by the root model', async () => {
    const { ctx, emitted } = makeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()
    await addon.attachCamera(CONFIG)
    const result = await asInternals(addon).runInference(101, FRAME)
    if (result === null) throw new Error('no result')
    asInternals(addon).emitInferenceResult(
      101,
      { data: Buffer.alloc(4), width: 640, height: 480, format: 'rgb', timestamp: 1000 },
      result,
      undefined,
    )
    const payload = emitted.find((e) => e.category === EventCategory.PipelineInferenceResult)
      ?.data as PipelineInferenceResultPayload | undefined
    expect(payload?.detailSteps?.find((s) => s.stepId === 'animal-classifier')?.filledBy).toBe(
      'frigate-plus',
    )
  })

  it('logs ONE info per (camera, step) when the root first supplies it', async () => {
    const { ctx, logger } = makeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    // The line goes through the non-throwing accessor, which reads the backing field.
    Object.defineProperty(addon, '_ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()
    await addon.attachCamera(CONFIG)
    await asInternals(addon).runInference(101, FRAME)
    await asInternals(addon).runInference(101, FRAME)
    const lines = logger.info.mock.calls.filter(
      (c) => c[0] === 'root model supplies a pipeline step — the step is not dispatched',
    )
    // Only the steps this camera RUNS: its tree has no vehicle-classifier, so
    // the root does not "supply" it however well it could (D736).
    expect(lines.map((c) => (c[1] as { meta: { stepId: string } }).meta.stepId).sort()).toEqual([
      'animal-classifier',
      'package-detection',
    ])
    for (const c of lines) expect(c[1]).toMatchObject({ tags: { deviceId: 101 } })
  })
})
