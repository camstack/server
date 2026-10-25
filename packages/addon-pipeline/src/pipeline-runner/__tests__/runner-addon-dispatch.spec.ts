/**
 * Phase 3 — pipeline-runner stateless dispatch.
 *
 * Exercises PipelineRunnerAddon.runInference routing: when the attach
 * payload carries `steps` the runner calls the new stateless
 * `pipelineExecutor.runPipeline`; when it does not, the legacy
 * `runFrame` path is kept (migration window — Phase 4 removes the
 * fallback). Empty `steps` is a valid "no-op" pipeline: the runner
 * skips the call entirely and returns null.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import PipelineRunnerAddon from '../index.js'
import type {
  FrameRef,
  RunnerCameraConfig,
  FrameInput,
  FrameResult,
  PipelineStepInput,
} from '@camstack/types'

/**
 * Typed accessor for the two private entry points the dispatch tests
 * need to drive: `onInitialize` (boots the internal scheduler) and
 * `runInference` (the routing function under test). Narrow on purpose
 * — the suite exercises nothing else behind the private boundary.
 */
interface AddonInternals {
  onInitialize(): Promise<unknown>
  runInference(deviceId: number, frame: FrameInput): Promise<FrameResult | null>
}

const LOCAL_REF: FrameRef = {
  registryId: 'local-process',
  id: 'frame-1',
  width: 1920,
  height: 1080,
  format: 'rgb',
  timestamp: 1000,
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
      streamBroker: {
        // Session-decode acquire surface: resolve the profile a camStream
        // feeds, then acquire the copy restream. `high`/`low` map 1:1 to a
        // same-named profile for these fixtures.
        listAllProfileSlots: {
          query: vi.fn().mockResolvedValue([
            { deviceId: 77, sourceCamStreamId: 'high', profile: 'high' },
            { deviceId: 42, sourceCamStreamId: 'low', profile: 'low' },
          ]),
        },
        getStreamWithCodec: {
          mutate: vi.fn().mockResolvedValue({
            url: 'rtsp://127.0.0.1/copy',
            videoCodec: 'H264',
            pipelineKey: 'pk-test',
          }),
        },
        releaseStreamWithCodec: { mutate: vi.fn().mockResolvedValue(undefined) },
      },
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

describe('PipelineRunnerAddon — stateless dispatch (Phase 3)', () => {
  let addon: PipelineRunnerAddon

  beforeEach(() => {
    addon = new PipelineRunnerAddon()
  })

  afterEach(async () => {
    await addon.shutdown().catch(() => {
      /* ignore */
    })
  })

  it('runInference calls runPipeline when the camera has a non-empty steps tree', async () => {
    const { ctx, runFrame, runPipeline } = makeFakeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    // Directly invoke the addon's init so the runner boots; we bypass the
    // BaseAddon.initialize wrapper to avoid pulling in settings hydration.
    await asInternals(addon).onInitialize()

    await addon.attachCamera(
      makeConfig({
        deviceId: 42,
        steps: STEPS,
      }),
    )

    const result = await asInternals(addon).runInference(42, makeFrameInput())

    expect(result).toBeTruthy()
    expect(runPipeline).toHaveBeenCalledTimes(1)
    expect(runFrame).not.toHaveBeenCalled()
    const call = runPipeline.mock.calls[0]![0] as Record<string, unknown>
    expect(call['deviceId']).toBe(42)
    expect(call['steps']).toEqual(STEPS)
    // Engine is node-local now — the live dispatch never forwards
    // `config.engine`, even when the attach payload carries one.
    expect(call).not.toHaveProperty('engine')
    expect(call['frame']).toBeTruthy()
  })

  it('passes a frameRef without inline pixels when the executor is co-located', async () => {
    const { ctx, runPipeline } = makeFakeCtx()
    Object.assign(ctx, {
      capabilities: {
        get: vi.fn((name: string) => (name === 'pipeline-executor' ? {} : undefined)),
      },
    })
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()
    await addon.attachCamera(makeConfig({ deviceId: 47, steps: STEPS }))

    await asInternals(addon).runInference(47, {
      ...makeFrameInput(),
      data: new Uint8Array(0),
      width: LOCAL_REF.width,
      height: LOCAL_REF.height,
      frameRef: LOCAL_REF,
    })

    const call = runPipeline.mock.calls[0]![0] as Record<string, unknown>
    expect(call['frameRef']).toEqual(LOCAL_REF)
    expect(call).not.toHaveProperty('frame')
    expect(call).not.toHaveProperty('image')
  })

  it('runInference skips the call (returns null) when steps is an empty array', async () => {
    const { ctx, runFrame, runPipeline } = makeFakeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()

    await addon.attachCamera(
      makeConfig({
        deviceId: 43,
        steps: [],
      }),
    )

    const result = await asInternals(addon).runInference(43, makeFrameInput())

    expect(result).toBeNull()
    expect(runPipeline).not.toHaveBeenCalled()
    expect(runFrame).not.toHaveBeenCalled()
  })

  it('runInference returns null when the camera has no steps in its attach payload (Phase 4)', async () => {
    // Phase 4 removed the legacy `runFrame` fallback. A camera attached
    // without a `steps` tree means the orchestrator never hydrated the
    // config from `pipelines[deviceId]` — the runner logs a warn and
    // skips the frame rather than silently inferring on a global tree.
    const { ctx, runPipeline } = makeFakeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()

    await addon.attachCamera(makeConfig({ deviceId: 44 }))

    const result = await asInternals(addon).runInference(44, makeFrameInput())

    expect(result).toBeNull()
    expect(runPipeline).not.toHaveBeenCalled()
  })

  it('runInference omits engine from the runPipeline payload when attach carries none', async () => {
    const { ctx, runPipeline } = makeFakeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()

    await addon.attachCamera(
      makeConfig({
        deviceId: 45,
        steps: STEPS,
        // engine intentionally omitted — executor picks its default.
      }),
    )

    await asInternals(addon).runInference(45, makeFrameInput())

    const call = runPipeline.mock.calls[0]![0] as Record<string, unknown>
    expect(call).not.toHaveProperty('engine')
    expect(call['steps']).toEqual(STEPS)
  })

  it('attachCamera log mentions the chosen dispatch path', async () => {
    const { ctx, logger } = makeFakeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()

    await addon.attachCamera(
      makeConfig({
        deviceId: 46,
        steps: STEPS,
      }),
    )

    const attachCall = logger.info.mock.calls.find(
      (args: unknown[]) => args[0] === 'attachCamera',
    ) as [string, { meta?: Record<string, unknown> }] | undefined
    expect(attachCall).toBeDefined()
    // Engine is node-local now — the log label is a static marker, not
    // derived from `config.engine`.
    expect(attachCall![1]?.meta).toMatchObject({
      dispatch: 'runPipeline(1step)',
      engine: 'node-local',
    })
  })

  it('an always-on camera opens its detection frame subscription on attach', async () => {
    // Regression: `registerCamera` fires a SYNCHRONOUS `subscribe` for an
    // always-on camera (initial phase = active). `handleDetectionStreamChange`
    // early-returns when the attachment is missing, so if `this.attached` is
    // set AFTER `registerCamera` the subscribe is silently dropped and the
    // always-on camera never decodes (detection stays at 0 fps). The attachment
    // must be registered BEFORE `registerCamera`.
    const { ctx } = makeFakeCtx()
    Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
    await asInternals(addon).onInitialize()

    await addon.attachCamera(
      makeConfig({
        deviceId: 77,
        detectionMode: 'always-on',
        detectionStreamId: 'high',
        steps: STEPS,
      }),
    )
    // The subscribe is async (handleDetectionStreamChange → subscribeDetectionFrames
    // → startDetectionSessionDecode → guarded acquire of the copy restream).
    await new Promise((r) => setTimeout(r, 30))

    // Session-decode is the only decode path: the always-on camera acquires its
    // detection restream on attach (the profile-slot lookup + getStreamWithCodec).
    const getStreamWithCodec = ctx.api.streamBroker.getStreamWithCodec.mutate
    expect(getStreamWithCodec).toHaveBeenCalled()
    const arg = getStreamWithCodec.mock.calls[0]![0] as Record<string, unknown>
    expect(arg['deviceId']).toBe(77)
    expect(arg['profile']).toBe('high')
    expect(arg['video']).toBe('copy')
  })
})
