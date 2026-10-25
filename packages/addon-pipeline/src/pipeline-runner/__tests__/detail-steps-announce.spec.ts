/**
 * Task 5 — two-plane live dispatch: the runner's `runInference` call site
 * must dispatch on the `'frame'` plane (root steps only — crop children are
 * served per-track via `pipelineRunner.runDetailSubtree`), and the emitted
 * `PipelineInferenceResultPayload` must announce which of the camera's
 * configured child steps a track-level consumer can dispatch, and on what
 * cadence — derived once at attach time from the step catalog
 * (`detection-pipeline/registry/step-definitions.ts`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeRunnerCameraConfig } from '../../__tests__/support/runner-camera-config.js'
import PipelineRunnerAddon from '../index.js'
import { EventCategory } from '@camstack/types'
import type {
  DecodedFrame,
  FrameInput,
  FrameResult,
  PipelineInferenceResultPayload,
  PipelineStepInputOutput,
  RunnerCameraConfig,
  SystemEvent,
} from '@camstack/types'

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

function makeFrameInput(): FrameInput {
  return {
    data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    width: 640,
    height: 480,
    format: 'jpeg',
    timestamp: 1000,
  }
}

function makeDecodedFrame(): DecodedFrame {
  return {
    data: Buffer.alloc(4),
    width: 640,
    height: 480,
    format: 'rgb',
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

// Tree: object-detection (root) → face-detection (child) → face-embedding
// (grandchild). Both face-detection and face-embedding are catalog child
// steps (inputClasses !== null) so both must appear in the announce;
// object-detection is a root step (inputClasses === null) and must not.
const STEPS: readonly PipelineStepInputOutput[] = [
  {
    addonId: 'object-detection',
    modelId: 'yolo26n',
    enabled: true,
    children: [
      {
        addonId: 'face-detection',
        modelId: 'scrfd-2.5g',
        enabled: true,
        children: [
          {
            addonId: 'face-embedding',
            modelId: 'arcface-r100',
            enabled: true,
          },
        ],
      },
    ],
  },
]

function makeFakeCtx() {
  const runPipeline = vi.fn().mockResolvedValue(makePipelineResult())
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
      pipelineExecutor: {
        runFrame: { mutate: vi.fn() },
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

function makeConfig(patch: Partial<RunnerCameraConfig> = {}): RunnerCameraConfig {
  return makeRunnerCameraConfig({
    deviceId: 42,
    motionCooldownMs: 10_000,
    motionSources: ['onboard'],
    ...patch,
  })
}

describe('live dispatch — frame plane + detailSteps announce', () => {
  let addon: PipelineRunnerAddon

  beforeEach(() => {
    addon = new PipelineRunnerAddon()
  })

  afterEach(async () => {
    await addon.shutdown().catch(() => {
      /* ignore */
    })
  })

  it("dispatches runPipeline.mutate on the 'frame' plane", async () => {
    const { ctx, runPipeline } = makeFakeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()

    await addon.attachCamera(makeConfig({ deviceId: 99, steps: STEPS }))
    await asInternals(addon).runInference(99, makeFrameInput())

    expect(runPipeline).toHaveBeenCalledTimes(1)
    const input = runPipeline.mock.calls[0]![0] as Record<string, unknown>
    expect(input['plane']).toBe('frame')
  })

  it('announces the enabled child steps + cadence from the catalog on the emitted payload', async () => {
    const { ctx, emitted } = makeFakeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()

    await addon.attachCamera(makeConfig({ deviceId: 1, steps: STEPS }))

    asInternals(addon).emitInferenceResult(1, makeDecodedFrame(), makePipelineResult(), undefined)

    const inferenceEvents = emitted.filter(
      (e) => e.category === EventCategory.PipelineInferenceResult,
    )
    expect(inferenceEvents).toHaveLength(1)
    const data = inferenceEvents[0]!.data as PipelineInferenceResultPayload
    expect(data.detailSteps).toBeDefined()

    const byStepId = new Map((data.detailSteps ?? []).map((s) => [s.stepId, s]))
    expect(byStepId.size).toBe(2)

    expect(byStepId.get('face-detection')).toEqual({
      stepId: 'face-detection',
      inputClasses: ['person'],
      // PERIODIC (not improve): the detector geometry re-runs on a steady
      // cadence to keep the live-overlay true-box glued to the moving face;
      // the dispatcher composes whether the embedding child rides along.
      cadence: { trigger: 'periodic', minIntervalMs: 1000 },
    })
    expect(byStepId.get('face-embedding')).toEqual({
      stepId: 'face-embedding',
      inputClasses: ['face'],
      cadence: { trigger: 'improve', minIntervalMs: 1000, stickyOnConfidence: 0.6 },
    })

    // object-detection is a root step (inputClasses === null) — never announced.
    expect(byStepId.has('object-detection')).toBe(false)
  })

  // D692: an EMPTY announce is an answer — "no recogniser runs on this camera" — which the
  // notification centre's grouped-window outlook reads as final. Omitting the field made
  // every such camera read `unknown` (pending) and every grouped window there wait its
  // full deadline.
  it('announces an EMPTY detailSteps list for a camera with no child steps configured', async () => {
    const { ctx, emitted } = makeFakeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()

    await addon.attachCamera(
      makeConfig({
        deviceId: 2,
        steps: [{ addonId: 'object-detection', modelId: 'yolo26n', enabled: true }],
      }),
    )

    asInternals(addon).emitInferenceResult(2, makeDecodedFrame(), makePipelineResult(), undefined)

    const inferenceEvents = emitted.filter(
      (e) => e.category === EventCategory.PipelineInferenceResult,
    )
    expect(inferenceEvents).toHaveLength(1)
    const data = inferenceEvents[0]!.data as PipelineInferenceResultPayload
    expect(data.detailSteps).toEqual([])
  })
})
