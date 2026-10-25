/**
 * Small-subject recovery — the runner half, through `runInference`.
 *
 * The pure decisions are pinned in `small-subject-recovery.spec.ts`. This spec
 * is about the WIRING: the motion mirror is fed from the analyzer path, the
 * crop is resolved from the same process-local lease the full pass used, the
 * executor is asked once per crop with the childless detector and the
 * camera's deviceId (D657: a failed load there is tagged with the camera; an
 * `image` dispatch runs no zone gate, so crop coordinates never meet one), the
 * boxes come back in the result's own space, and the pass is
 * rate-limited per camera.
 */

import type {
  DecodedFrame,
  FrameHandle,
  FrameInput,
  FrameResult,
  ObjectDetection,
  PipelineStepInput,
  RunnerCameraConfig,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeRunnerCameraConfig } from '../../__tests__/support/runner-camera-config.js'
import { localFrameRegistry } from '../../session-decode/local-frame-registry.js'
import type { FrameImage, FrameImageOptions } from '../../session-decode/video-frame-generator.js'
import PipelineRunnerAddon from '../index.js'
import {
  RECOVERY_CROP_MAX_SIDE_PX,
  RECOVERY_CROP_MIN_SIDE_PX,
  RECOVERY_VIEW_PX,
} from '../small-subject-recovery.js'

interface AddonInternals {
  onInitialize(): Promise<unknown>
  runInference(
    deviceId: number,
    frame: FrameInput,
    handle: FrameHandle | undefined,
  ): Promise<FrameResult | null>
  runMotionAnalysis(
    deviceId: number,
    frame: DecodedFrame,
    handle: FrameHandle | undefined,
  ): Promise<void>
}

function asInternals(addon: PipelineRunnerAddon): AddonInternals {
  return addon as unknown as AddonInternals
}

const DEVICE_ID = 101
const NATIVE = { width: 3840, height: 2160 }

const STEPS: readonly PipelineStepInput[] = [
  {
    addonId: 'object-detection',
    modelId: 'yolov9m-320',
    enabled: true,
    children: [{ addonId: 'face-detection', enabled: true, children: [] }],
  },
]

function det(
  id: string,
  macroClass: string,
  bbox: { x: number; y: number; width: number; height: number },
  score = 0.9,
): ObjectDetection {
  return { id, kind: 'first-level', macroClass, score, labels: [], bbox }
}

function fullFrameResult(detections: readonly ObjectDetection[]): FrameResult {
  return {
    kind: 'frame',
    frameId: 'full',
    deviceId: DEVICE_ID,
    timestamp: 1_000,
    width: NATIVE.width,
    height: NATIVE.height,
    detections,
  }
}

function cropResult(detections: readonly ObjectDetection[]): FrameResult {
  return {
    kind: 'frame',
    frameId: 'crop',
    deviceId: 0,
    timestamp: 1_000,
    width: RECOVERY_VIEW_PX,
    height: RECOVERY_VIEW_PX,
    detections,
  }
}

/** A lazy native frame whose views are recorded rather than rendered. */
function makeFrameImage(views: FrameImageOptions[]): FrameImage {
  return {
    width: NATIVE.width,
    height: NATIVE.height,
    format: 'rgb',
    async toBuffer(opts?: FrameImageOptions) {
      if (opts) views.push(opts)
      return new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
    },
    close() {
      /* nothing to free */
    },
  }
}

function makeFakeCtx(
  analyzeRegions: ReadonlyArray<{ x: number; y: number; w: number; h: number }>,
) {
  const runPipeline = vi.fn()
  const analyze = vi.fn().mockResolvedValue({
    detected: analyzeRegions.length > 0,
    regionCount: analyzeRegions.length,
    regions: analyzeRegions.map((bbox) => ({ bbox, pixelCount: 100, intensity: 200 })),
    rawRegions: [],
    frameWidth: 320,
    frameHeight: 180,
    analysisMs: 1,
  })
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
    capabilities: {
      get: vi.fn((name: string) => (name === 'pipeline-executor' ? {} : undefined)),
    },
    api: {
      pipelineExecutor: { runPipeline: { mutate: runPipeline } },
      motionDetection: { analyze: { mutate: analyze } },
      streamBroker: {
        listAllProfileSlots: { query: vi.fn().mockResolvedValue([]) },
        getStreamWithCodec: { mutate: vi.fn() },
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
  return { ctx, runPipeline, analyze, logger }
}

function makeConfig(): RunnerCameraConfig {
  return makeRunnerCameraConfig({ deviceId: DEVICE_ID, steps: STEPS })
}

const MOTION_FRAME: DecodedFrame = {
  data: Buffer.alloc(320 * 180),
  width: 320,
  height: 180,
  format: 'gray',
  timestamp: 1_000,
}

/** The person-and-dog blob of camera 101 on the 320×180 motion view. */
const BLOB = { x: 211, y: 7, w: 30, h: 63 }
/** The person the full pass found: the left ~55% of the blob. */
const PERSON = det('p', 'person', { x: 2540, y: 90, width: 200, height: 750 })
/** The dog, as the crop pass reports it on the 640 px view. */
const DOG_ON_VIEW = det('d', 'animal', { x: 300, y: 300, width: 200, height: 150 }, 0.82)

describe('PipelineRunnerAddon — small-subject recovery through runInference', () => {
  let addon: PipelineRunnerAddon
  let ref: ReturnType<typeof localFrameRegistry.register>
  const views: FrameImageOptions[] = []

  beforeEach(() => {
    addon = new PipelineRunnerAddon()
    views.length = 0
    ref = localFrameRegistry.register(makeFrameImage(views), { timestamp: 1_000 })
  })

  afterEach(async () => {
    if (ref) localFrameRegistry.release(ref, 'detach')
    await addon.shutdown().catch(() => {
      /* ignore */
    })
  })

  async function boot(regions: ReadonlyArray<{ x: number; y: number; w: number; h: number }>) {
    const fake = makeFakeCtx(regions)
    Object.defineProperty(addon, 'ctx', { value: fake.ctx, configurable: true })
    await asInternals(addon).onInitialize()
    await addon.attachCamera(makeConfig())
    await asInternals(addon).runMotionAnalysis(DEVICE_ID, MOTION_FRAME, undefined)
    return fake
  }

  function frameInput(): FrameInput {
    if (!ref) throw new Error('frame not registered')
    return {
      data: new Uint8Array(0),
      width: ref.width,
      height: ref.height,
      format: 'rgb',
      timestamp: 1_000,
      frameRef: ref,
    }
  }

  it('runs the detector on a native square around the uncovered motion and fuses the box back', async () => {
    const { runPipeline } = await boot([BLOB])
    runPipeline
      .mockResolvedValueOnce(fullFrameResult([PERSON]))
      .mockResolvedValueOnce(cropResult([DOG_ON_VIEW]))

    const result = await asInternals(addon).runInference(DEVICE_ID, frameInput(), undefined)

    expect(runPipeline).toHaveBeenCalledTimes(2)
    const second = runPipeline.mock.calls[1]![0] as Record<string, unknown>
    expect(second['image']).toBeInstanceOf(Uint8Array)
    expect(second['steps']).toEqual([
      { addonId: 'object-detection', modelId: 'yolov9m-320', enabled: true },
    ])
    expect(second['plane']).toBe('frame')
    // The camera's deviceId (D657), so a failed model load on this pass is
    // tagged with it. The provider's zone gate runs only on a runtime
    // `frame`/`frameRef` (or a replay), never on this `image` crop; the
    // tracker gates in frame space downstream.
    expect(second['deviceId']).toBe(DEVICE_ID)

    // The crop was resolved from the SAME lease, at native resolution, as a
    // compressed square view no larger than the crop.
    expect(views).toHaveLength(1)
    const view = views[0]!
    expect(view.format).toBe('jpeg')
    expect(view.resize).toEqual({ width: RECOVERY_VIEW_PX, height: RECOVERY_VIEW_PX })
    const crop = view.crop!
    expect(crop.width).toBe(crop.height)
    expect(crop.width).toBeGreaterThanOrEqual(RECOVERY_CROP_MIN_SIDE_PX)
    expect(crop.width).toBeLessThanOrEqual(RECOVERY_CROP_MAX_SIDE_PX)

    // The full-frame box is untouched; the dog is back in native pixels.
    expect(result?.detections).toHaveLength(2)
    expect(result?.detections[0]).toBe(PERSON)
    const dog = result?.detections[1]
    expect(dog?.macroClass).toBe('animal')
    const scale = crop.width / RECOVERY_VIEW_PX
    expect(dog?.bbox.x).toBeCloseTo(crop.left + DOG_ON_VIEW.bbox.x * scale, 3)
    expect(dog?.bbox.y).toBeCloseTo(crop.top + DOG_ON_VIEW.bbox.y * scale, 3)
    expect(dog?.bbox.width).toBeCloseTo(DOG_ON_VIEW.bbox.width * scale, 3)
    expect(dog?.bbox.height).toBeCloseTo(DOG_ON_VIEW.bbox.height * scale, 3)
  })

  /**
   * Camera 101, 19:54:33 → 19:54:39: the animal track held 9 positions over
   * 1 666 ms, then coasted out its budget and died — while the PERSON went on
   * being detected frame after frame. The full-frame pass had simply stopped
   * seeing the dog. A recovery gated on "the frame produced no detections"
   * would not have run on ONE of those frames, and the track would still have
   * died. This is that shape: a detection elsewhere in the frame, a small
   * uncovered mover, and the pass running anyway.
   */
  it('runs while another subject is still detected — the 101 track-lost shape', async () => {
    const { runPipeline } = await boot([{ x: 100, y: 100, w: 20, h: 20 }])
    runPipeline
      .mockResolvedValueOnce(fullFrameResult([PERSON]))
      .mockResolvedValueOnce(cropResult([DOG_ON_VIEW]))

    const result = await asInternals(addon).runInference(DEVICE_ID, frameInput(), undefined)

    expect(runPipeline).toHaveBeenCalledTimes(2)
    expect(result?.detections).toHaveLength(2)
    expect(result?.detections[0]).toBe(PERSON)
    expect(result?.detections[1]?.macroClass).toBe('animal')
  })

  it('does not run twice inside the per-camera interval', async () => {
    const { runPipeline } = await boot([BLOB])
    runPipeline
      .mockResolvedValueOnce(fullFrameResult([PERSON]))
      .mockResolvedValueOnce(cropResult([DOG_ON_VIEW]))
      .mockResolvedValueOnce(fullFrameResult([PERSON]))

    await asInternals(addon).runInference(DEVICE_ID, frameInput(), undefined)
    const again = await asInternals(addon).runInference(DEVICE_ID, frameInput(), undefined)

    expect(runPipeline).toHaveBeenCalledTimes(3)
    expect(again?.detections).toHaveLength(1)
  })

  it('does not run when the full-frame detections already cover the motion', async () => {
    const { runPipeline } = await boot([BLOB])
    const wholeBlob = det('p', 'person', { x: 2500, y: 60, width: 400, height: 800 })
    runPipeline.mockResolvedValueOnce(fullFrameResult([wholeBlob]))

    const result = await asInternals(addon).runInference(DEVICE_ID, frameInput(), undefined)

    expect(runPipeline).toHaveBeenCalledTimes(1)
    expect(views).toHaveLength(0)
    expect(result?.detections).toEqual([wholeBlob])
  })

  it('does not run without motion regions, and leaves the result untouched', async () => {
    const { runPipeline } = await boot([])
    runPipeline.mockResolvedValueOnce(fullFrameResult([]))

    const result = await asInternals(addon).runInference(DEVICE_ID, frameInput(), undefined)

    expect(runPipeline).toHaveBeenCalledTimes(1)
    expect(result?.detections).toEqual([])
  })

  it('keeps the full-frame result when the crop pass throws', async () => {
    const { runPipeline, logger } = await boot([BLOB])
    runPipeline
      .mockResolvedValueOnce(fullFrameResult([PERSON]))
      .mockRejectedValueOnce(new Error('pool gone'))

    const result = await asInternals(addon).runInference(DEVICE_ID, frameInput(), undefined)

    expect(result?.detections).toEqual([PERSON])
    expect(logger.warn).toHaveBeenCalledWith(
      'small-subject recovery: crop pass failed — full-frame result kept',
      expect.objectContaining({ meta: expect.objectContaining({ error: 'pool gone' }) }),
    )
  })
})
