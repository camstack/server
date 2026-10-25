/**
 * Task 6 — `runDetailSubtree` (two-plane design, detail plane). Exercises the
 * deps-injected pure function directly: crop resolution (native hit / cropJpeg
 * fallback / neither), exact bbox reprojection arithmetic, the "camera not
 * attached" short-circuit, the `steps` subset filter, and the tree-walking
 * helper's transitive-child inclusion (face-detection pulls face-embedding).
 */
import { describe, it, expect, vi } from 'vitest'
import type {
  DetailCropConvention,
  DetailParent,
  FrameHandle,
  FrameResult,
  ObjectDetection,
  PipelineStepInputOutput,
} from '@camstack/types'
import { DEFAULT_DETAIL_CROP_CONVENTION, deriveDetailCropRect } from '@camstack/types'
import { assertDetailSubtreeResult } from '../../__tests__/support/detail-subtree-outcome.js'
import {
  type CropSource,
  type DetailSubtreeDeps,
  findMatchingDetailSteps,
  pruneChildStepsToRequested,
  runDetailSubtree,
  type StepClassDefinition,
} from '../detail-subtree.js'
import type { DetailStepPlacement } from '../device-jump.js'

const DEVICE_ID = 42

/** Deps every case needs but only a few assert on. */
const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const baseDeps = {
  resolveCropConvention: () => DEFAULT_DETAIL_CROP_CONVENTION,
  logger: silentLogger,
}

function makeFrameHandle(overrides: Partial<FrameHandle> = {}): FrameHandle {
  return {
    shmId: 'seg-1',
    slot: 0,
    seq: 1,
    width: 640,
    height: 360,
    format: 'rgb',
    pts: 0,
    byteLength: 640 * 360 * 3,
    nodeId: 'hub',
    slotCount: 4,
    ...overrides,
  }
}

function makeParent(overrides: Partial<DetailParent> = {}): DetailParent {
  return {
    bbox: { x: 100, y: 100, w: 50, h: 80 },
    className: 'person',
    ...overrides,
  }
}

function makeStep(overrides: Partial<PipelineStepInputOutput> = {}): PipelineStepInputOutput {
  return {
    addonId: 'face-detection',
    modelId: 'scrfd-2.5g',
    enabled: true,
    ...overrides,
  }
}

function makeDetection(overrides: Partial<ObjectDetection> = {}): ObjectDetection {
  return {
    id: 'd1',
    kind: 'first-level',
    macroClass: 'face',
    score: 0.9,
    bbox: { x: 100, y: 120, width: 40, height: 60 },
    labels: [],
    ...overrides,
  }
}

function makeFrameResult(detections: readonly ObjectDetection[]): FrameResult {
  return {
    kind: 'frame',
    frameId: 'f1',
    deviceId: DEVICE_ID,
    timestamp: 0,
    width: 260,
    height: 416,
    detections,
  }
}

describe('runDetailSubtree', () => {
  it('(a) native hit — runs the matched step(s) and maps the bbox back to frame space with exact arithmetic', async () => {
    const frameHandle = makeFrameHandle()
    const parent = makeParent()
    const step = makeStep()
    const detection = makeDetection()

    // Padding 0.15 of a {x:100,y:100,w:50,h:80} bbox, clamped to 640x360:
    //   padX = 7.5, padY = 12
    //   x1=92.5 y1=88 x2=157.5 y2=192 -> w=65 h=104
    const expectedPaddedPixelRect = { x: 92.5, y: 88, w: 65, h: 104 }
    const expectedNormalizedBbox = {
      x: 92.5 / 640,
      y: 88 / 360,
      w: 65 / 640,
      h: 104 / 360,
    }
    const crop: CropSource = {
      jpeg: Buffer.from('native-crop-jpeg'),
      width: 260, // 4x the padded pixel width (65) -> scaleX = 0.25
      height: 416, // 4x the padded pixel height (104) -> scaleY = 0.25
      frameSpace: expectedPaddedPixelRect,
      source: 'native',
    }

    const getNativeCrop = vi.fn().mockResolvedValue(crop)
    const runPipeline = vi.fn().mockResolvedValue(makeFrameResult([detection]))
    const resolveChildSteps = vi.fn().mockReturnValue([step])

    const deps: DetailSubtreeDeps = {
      ...baseDeps,
      resolveChildSteps,
      getNativeCrop,
      runPipeline,
    }

    const result = await runDetailSubtree(deps, {
      deviceId: DEVICE_ID,
      frameHandle,
      parent,
    })

    expect(getNativeCrop).toHaveBeenCalledTimes(1)
    const [calledDeviceId, calledHandle, calledBbox] = getNativeCrop.mock.calls[0] as [
      number,
      FrameHandle,
      { x: number; y: number; w: number; h: number },
    ]
    expect(calledDeviceId).toBe(DEVICE_ID)
    expect(calledHandle).toBe(frameHandle)
    expect(calledBbox.x).toBeCloseTo(expectedNormalizedBbox.x, 10)
    expect(calledBbox.y).toBeCloseTo(expectedNormalizedBbox.y, 10)
    expect(calledBbox.w).toBeCloseTo(expectedNormalizedBbox.w, 10)
    expect(calledBbox.h).toBeCloseTo(expectedNormalizedBbox.h, 10)

    expect(runPipeline).toHaveBeenCalledTimes(1)
    // Step-tree device jump (phase 1): a 4th `deviceKey` arg is passed per step
    // (undefined here — no `placeStep` dep wired in this test). A NATIVE
    // hit ALSO forwards a `nativeCropRef` (handle + the crop's frame-space rect)
    // so the executor can re-cut leaf child ROIs at native resolution.
    expect(runPipeline).toHaveBeenCalledWith([step], crop.jpeg, DEVICE_ID, undefined, {
      handle: frameHandle,
      cropFrameSpace: expectedPaddedPixelRect,
    })

    expect(result).not.toBeNull()
    assertDetailSubtreeResult(result)
    expect(result.details).toHaveLength(1)
    const [detail] = result.details
    expect(detail!.stepId).toBe('face-detection')
    expect(detail!.className).toBe('face')
    expect(detail!.score).toBe(0.9)
    // frameBbox = frameSpace.origin + cropBbox * (frameSpace.size / cropPixelSize)
    //   scaleX = 65/260 = 0.25, scaleY = 104/416 = 0.25
    //   x = 92.5 + 100*0.25 = 117.5, y = 88 + 120*0.25 = 118
    //   w = 40*0.25 = 10, h = 60*0.25 = 15
    expect(detail!.bbox).toEqual({ x: 117.5, y: 118, w: 10, h: 15 })
  })

  it('(b) native miss + cropJpeg fallback — decodes the fallback jpeg and runs the pipeline on it', async () => {
    const sharp = (await import('sharp')).default
    const rawRgb = Buffer.alloc(20 * 30 * 3, 128)
    const fallbackJpeg = await sharp(rawRgb, { raw: { width: 20, height: 30, channels: 3 } })
      .jpeg()
      .toBuffer()

    const parent = makeParent({ bbox: { x: 10, y: 20, w: 30, h: 40 }, className: 'vehicle' })
    const step = makeStep({ addonId: 'plate-detection' })
    const detection = makeDetection({
      macroClass: 'plate',
      bbox: { x: 0, y: 0, width: 20, height: 30 },
    })

    const getNativeCrop = vi.fn().mockResolvedValue(null)
    const runPipeline = vi.fn().mockResolvedValue(makeFrameResult([detection]))
    const resolveChildSteps = vi.fn().mockReturnValue([step])

    const deps: DetailSubtreeDeps = {
      ...baseDeps,
      resolveChildSteps,
      getNativeCrop,
      runPipeline,
    }

    const result = await runDetailSubtree(deps, {
      deviceId: DEVICE_ID,
      frameHandle: makeFrameHandle(),
      cropJpeg: fallbackJpeg.toString('base64'),
      parent,
    })

    expect(getNativeCrop).toHaveBeenCalledTimes(1) // attempted first, missed
    expect(runPipeline).toHaveBeenCalledTimes(1)
    const [calledSteps, calledImage, calledDeviceId, , calledNativeRef] = runPipeline.mock
      .calls[0] as [readonly PipelineStepInputOutput[], Buffer, number, unknown, unknown]
    expect(calledSteps).toEqual([step])
    expect(calledImage.equals(fallbackJpeg)).toBe(true)
    expect(calledDeviceId).toBe(DEVICE_ID)
    // Fallback (downscaled tile) path: no live native reference, so children
    // stay on the tile — `nativeCropRef` MUST be absent.
    expect(calledNativeRef).toBeUndefined()

    assertDetailSubtreeResult(result)
    expect(result.details).toHaveLength(1)
    // No frame dims available on the fallback path — frameSpace falls back to
    // the parent's own (unpadded) frame-space rect; crop is 20x30 (probed from
    // the jpeg), so scale is 30/20=1.5 and 40/30≈1.333.
    expect(result.details[0]!.bbox).toEqual({ x: 10, y: 20, w: 30, h: 40 })
  })

  it('(b3) step-tree device jump — the placement (device AND step as provisioned there) is forwarded to runPipeline per step', async () => {
    const stepA = makeStep({ addonId: 'face-detection' })
    const stepB = makeStep({ addonId: 'plate-detection' })

    const cropFrameSpace = { x: 0, y: 0, w: 100, h: 100 }
    const getNativeCrop = vi.fn().mockResolvedValue({
      jpeg: Buffer.from('crop'),
      width: 100,
      height: 100,
      frameSpace: cropFrameSpace,
      source: 'native' as const,
    } satisfies CropSource)
    const runPipeline = vi.fn().mockResolvedValue(makeFrameResult([]))
    const resolveChildSteps = vi.fn().mockReturnValue([stepA, stepB])
    // Jump face-detection onto openvino:npu, provisioned for it (D650); leave
    // plate-detection on the default.
    const jumpedA: PipelineStepInputOutput = { ...stepA, modelId: 'npu-target-model' }
    const placeStep = vi.fn(
      (_deviceId: number, step: PipelineStepInputOutput): DetailStepPlacement =>
        step.addonId === 'face-detection'
          ? {
              deviceKey: 'openvino:npu',
              step: jumpedA,
              decision: { kind: 'jumped', deviceKey: 'openvino:npu', reason: 'auto' },
              provisioned: true,
            }
          : { deviceKey: undefined, step, decision: null, provisioned: false },
    )

    const deps: DetailSubtreeDeps = {
      ...baseDeps,
      resolveChildSteps,
      getNativeCrop,
      runPipeline,
      placeStep,
    }

    const frameHandle = makeFrameHandle()
    await runDetailSubtree(deps, {
      deviceId: DEVICE_ID,
      frameHandle,
      parent: makeParent(),
    })

    expect(placeStep).toHaveBeenCalledTimes(2)
    // Native hit ⇒ each step's runPipeline ALSO gets the `nativeCropRef`.
    const nativeCropRef = { handle: frameHandle, cropFrameSpace }
    expect(runPipeline).toHaveBeenNthCalledWith(
      1,
      [jumpedA],
      expect.any(Buffer),
      DEVICE_ID,
      'openvino:npu',
      nativeCropRef,
    )
    expect(runPipeline).toHaveBeenNthCalledWith(
      2,
      [stepB],
      expect.any(Buffer),
      DEVICE_ID,
      undefined,
      nativeCropRef,
    )
  })

  it('(b2) no frameHandle at all — cropJpeg fallback used directly, native never attempted', async () => {
    const sharp = (await import('sharp')).default
    const rawRgb = Buffer.alloc(10 * 10 * 3, 64)
    const fallbackJpeg = await sharp(rawRgb, { raw: { width: 10, height: 10, channels: 3 } })
      .jpeg()
      .toBuffer()

    const getNativeCrop = vi.fn().mockResolvedValue(null)
    const runPipeline = vi.fn().mockResolvedValue(makeFrameResult([]))
    const resolveChildSteps = vi.fn().mockReturnValue([makeStep()])

    const deps: DetailSubtreeDeps = {
      ...baseDeps,
      resolveChildSteps,
      getNativeCrop,
      runPipeline,
    }

    await runDetailSubtree(deps, {
      deviceId: DEVICE_ID,
      cropJpeg: fallbackJpeg.toString('base64'),
      parent: makeParent(),
    })

    expect(getNativeCrop).not.toHaveBeenCalled()
    expect(runPipeline).toHaveBeenCalledTimes(1)
  })

  it('(c) camera not attached — resolveChildSteps returns null, result is the TYPED refusal, no crop/run work happens', async () => {
    const getNativeCrop = vi.fn()
    const runPipeline = vi.fn()
    const resolveChildSteps = vi.fn().mockReturnValue(null)

    const deps: DetailSubtreeDeps = {
      ...baseDeps,
      resolveChildSteps,
      getNativeCrop,
      runPipeline,
    }

    const result = await runDetailSubtree(deps, {
      deviceId: DEVICE_ID,
      frameHandle: makeFrameHandle(),
      parent: makeParent(),
    })

    // DISCRIMINATED from the two null outcomes ("no matching step" / "no crop
    // source"): the caller must be able to stop its crop ladder on a refusal
    // that names the SESSION, not this dispatch.
    expect(result).toEqual({ refusal: 'not-attached' })
    expect(getNativeCrop).not.toHaveBeenCalled()
    expect(runPipeline).not.toHaveBeenCalled()
  })

  it('(c2) attached but no matching child steps — empty match short-circuits to null', async () => {
    const getNativeCrop = vi.fn()
    const runPipeline = vi.fn()
    const resolveChildSteps = vi.fn().mockReturnValue([])

    const deps: DetailSubtreeDeps = {
      ...baseDeps,
      resolveChildSteps,
      getNativeCrop,
      runPipeline,
    }

    const result = await runDetailSubtree(deps, {
      deviceId: DEVICE_ID,
      frameHandle: makeFrameHandle(),
      parent: makeParent(),
    })

    expect(result).toBeNull()
    expect(getNativeCrop).not.toHaveBeenCalled()
  })

  // ── frameJpeg: THE RUNNER CUTS ────────────────────────────────────────
  //
  // The embedding rebuild used to cut its own crop (0.2 margin + squaring)
  // and encode it directly through `embeddingEncoder.encode`, while the live
  // path cut 0.15 unsquared through the pipeline. Same `object-clip` index,
  // two feature spaces. `frameJpeg` is what removes the second derivation:
  // the caller ships the full frame and the RUNNER applies the one convention.

  /** A JPEG whose top-left quadrant is red and the rest black — lets a test
   *  assert WHICH rectangle was cut, not merely that something was. */
  async function quadrantJpeg(width: number, height: number): Promise<Buffer> {
    const sharp = (await import('sharp')).default
    const raw = Buffer.alloc(width * height * 3, 0)
    for (let y = 0; y < height / 2; y++) {
      for (let x = 0; x < width / 2; x++) {
        raw[(y * width + x) * 3] = 255
      }
    }
    return sharp(raw, { raw: { width, height, channels: 3 } })
      .jpeg()
      .toBuffer()
  }

  it('(g) frameJpeg — the runner derives the crop rect with deriveDetailCropRect and cuts it itself', async () => {
    const frame = await quadrantJpeg(640, 360)
    // Deliberately NOT the default, and not the rebuild's old 0.2 either: if
    // this branch carried its own constant the numbers below could not match.
    const convention: DetailCropConvention = { paddingRatio: 0.37, square: false }
    const parent = makeParent({ bbox: { x: 100, y: 100, w: 50, h: 80 }, className: 'dog' })

    const runPipeline = vi.fn().mockResolvedValue(makeFrameResult([]))
    const getNativeCrop = vi.fn()
    const deps: DetailSubtreeDeps = {
      ...baseDeps,
      resolveCropConvention: () => convention,
      resolveChildSteps: vi.fn().mockReturnValue([makeStep({ addonId: 'clip-embedding' })]),
      getNativeCrop,
      runPipeline,
    }

    await runDetailSubtree(deps, {
      deviceId: DEVICE_ID,
      frameJpeg: frame.toString('base64'),
      parent,
      steps: ['clip-embedding'],
    })

    // No frame handle ⇒ the native lease is never consulted.
    expect(getNativeCrop).not.toHaveBeenCalled()
    expect(runPipeline).toHaveBeenCalledTimes(1)

    // The SAME function the live (frameHandle) path uses, called with the same
    // arguments — not a re-derivation that happens to agree today.
    const expected = deriveDetailCropRect(parent.bbox, 640, 360, convention)
    const sharp = (await import('sharp')).default
    const cutJpeg = runPipeline.mock.calls[0]![1] as Buffer
    const meta = await sharp(cutJpeg).metadata()
    expect(meta.width).toBe(Math.round(expected.w))
    expect(meta.height).toBe(Math.round(expected.h))
    // A crop cut with the old 0.2 margin would be 70x112; with 0.15, 65x104.
    expect(meta.width).not.toBe(70)
    expect(meta.width).not.toBe(65)
  })

  it('(g2) frameJpeg — the crop the runner cuts is IDENTICAL to what the frameHandle path asks for', async () => {
    // The proof that the rebuild and the live path now share one derivation:
    // run both branches over the same parent box and frame dimensions, and
    // compare the rectangle each one produced.
    const convention: DetailCropConvention = { paddingRatio: 0.25, square: true }
    const parent = makeParent({ bbox: { x: 300, y: 120, w: 60, h: 140 }, className: 'dog' })
    const frameWidth = 640
    const frameHeight = 360

    // LIVE branch — records the normalized bbox handed to the native lease.
    const getNativeCrop = vi.fn().mockResolvedValue(null)
    await runDetailSubtree(
      {
        ...baseDeps,
        resolveCropConvention: () => convention,
        resolveChildSteps: vi.fn().mockReturnValue([makeStep({ addonId: 'clip-embedding' })]),
        getNativeCrop,
        runPipeline: vi.fn().mockResolvedValue(makeFrameResult([])),
      },
      {
        deviceId: DEVICE_ID,
        frameHandle: makeFrameHandle({ width: frameWidth, height: frameHeight }),
        parent,
      },
    )
    const nativeNorm = getNativeCrop.mock.calls[0]![2] as {
      x: number
      y: number
      w: number
      h: number
    }
    const liveRect = {
      x: nativeNorm.x * frameWidth,
      y: nativeNorm.y * frameHeight,
      w: nativeNorm.w * frameWidth,
      h: nativeNorm.h * frameHeight,
    }

    // REBUILD branch — records the pixel rect the runner extracted.
    const frame = await quadrantJpeg(frameWidth, frameHeight)
    const runPipeline = vi.fn().mockResolvedValue(makeFrameResult([]))
    const result = await runDetailSubtree(
      {
        ...baseDeps,
        resolveCropConvention: () => convention,
        resolveChildSteps: vi.fn().mockReturnValue([makeStep({ addonId: 'clip-embedding' })]),
        getNativeCrop: vi.fn(),
        runPipeline,
      },
      { deviceId: DEVICE_ID, frameJpeg: frame.toString('base64'), parent },
    )
    expect(result).not.toBeNull()

    const sharp = (await import('sharp')).default
    const cutMeta = await sharp(runPipeline.mock.calls[0]![1] as Buffer).metadata()
    expect(cutMeta.width).toBe(Math.round(liveRect.w))
    expect(cutMeta.height).toBe(Math.round(liveRect.h))
  })

  it('(g3) a pre-cut cropJpeg is STILL passed through untouched, even under a non-default convention', async () => {
    // The dispatcher's lease-miss retry supplies a tile it already cut. The
    // runner must not re-pad it — the two inputs mean different things and
    // that distinction is the whole reason `frameJpeg` is a separate field.
    const sharp = (await import('sharp')).default
    const tile = await sharp(Buffer.alloc(20 * 30 * 3, 128), {
      raw: { width: 20, height: 30, channels: 3 },
    })
      .jpeg()
      .toBuffer()

    const runPipeline = vi.fn().mockResolvedValue(makeFrameResult([]))
    const deps: DetailSubtreeDeps = {
      ...baseDeps,
      resolveCropConvention: () => ({ paddingRatio: 0.9, square: true }),
      resolveChildSteps: vi.fn().mockReturnValue([makeStep()]),
      getNativeCrop: vi.fn().mockResolvedValue(null),
      runPipeline,
    }

    await runDetailSubtree(deps, {
      deviceId: DEVICE_ID,
      cropJpeg: tile.toString('base64'),
      parent: makeParent(),
    })

    const passed = runPipeline.mock.calls[0]![1] as Buffer
    expect(passed.equals(tile)).toBe(true)
  })

  it('(g4) frameJpeg loses to frameHandle — a live caller with a lease still takes the zero-copy path', async () => {
    const frame = await quadrantJpeg(64, 64)
    const crop: CropSource = {
      jpeg: Buffer.from('native'),
      width: 10,
      height: 10,
      frameSpace: { x: 0, y: 0, w: 10, h: 10 },
      source: 'native',
    }
    const getNativeCrop = vi.fn().mockResolvedValue(crop)
    const runPipeline = vi.fn().mockResolvedValue(makeFrameResult([]))

    await runDetailSubtree(
      {
        ...baseDeps,
        resolveChildSteps: vi.fn().mockReturnValue([makeStep()]),
        getNativeCrop,
        runPipeline,
      },
      {
        deviceId: DEVICE_ID,
        frameHandle: makeFrameHandle(),
        frameJpeg: frame.toString('base64'),
        parent: makeParent(),
      },
    )

    expect(getNativeCrop).toHaveBeenCalledTimes(1)
    expect((runPipeline.mock.calls[0]![1] as Buffer).equals(crop.jpeg)).toBe(true)
  })

  it('(g5) a detached camera is LOUD — warn tagged with the numeric deviceId, never a silent null', async () => {
    const warn = vi.fn()
    const result = await runDetailSubtree(
      {
        ...baseDeps,
        logger: { ...silentLogger, warn },
        resolveChildSteps: vi.fn().mockReturnValue(null),
        getNativeCrop: vi.fn(),
        runPipeline: vi.fn(),
      },
      { deviceId: DEVICE_ID, frameJpeg: 'x', parent: makeParent(), steps: ['clip-embedding'] },
    )

    expect(result).toEqual({ refusal: 'not-attached' })
    expect(warn).toHaveBeenCalledTimes(1)
    const [message, extras] = warn.mock.calls[0] as [string, { tags?: { deviceId?: number } }]
    expect(message).toMatch(/not attached/i)
    expect(extras.tags?.deviceId).toBe(DEVICE_ID)
  })

  it('(g6) the requested step is not enabled in the tree — the log says WHICH step, not just "no result"', async () => {
    const warn = vi.fn()
    const result = await runDetailSubtree(
      {
        ...baseDeps,
        logger: { ...silentLogger, warn },
        resolveChildSteps: vi.fn().mockReturnValue([]),
        getNativeCrop: vi.fn(),
        runPipeline: vi.fn(),
      },
      { deviceId: DEVICE_ID, frameJpeg: 'x', parent: makeParent(), steps: ['clip-embedding'] },
    )

    expect(result).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    const [message, extras] = warn.mock.calls[0] as [
      string,
      { tags?: { deviceId?: number }; meta?: Record<string, unknown> },
    ]
    expect(message).toMatch(/no matching detail step/i)
    expect(extras.tags?.deviceId).toBe(DEVICE_ID)
    expect(extras.meta?.['requestedSteps']).toEqual(['clip-embedding'])
    expect(extras.meta?.['parentClass']).toBe('person')
  })

  it('(d) steps filter is forwarded to resolveChildSteps verbatim', async () => {
    const crop: CropSource = {
      jpeg: Buffer.from('x'),
      width: 10,
      height: 10,
      frameSpace: { x: 0, y: 0, w: 10, h: 10 },
      source: 'native',
    }
    const getNativeCrop = vi.fn().mockResolvedValue(crop)
    const runPipeline = vi.fn().mockResolvedValue(makeFrameResult([]))
    const resolveChildSteps = vi.fn().mockReturnValue([makeStep({ addonId: 'face-detection' })])

    const deps: DetailSubtreeDeps = {
      ...baseDeps,
      resolveChildSteps,
      getNativeCrop,
      runPipeline,
    }

    await runDetailSubtree(deps, {
      deviceId: DEVICE_ID,
      frameHandle: makeFrameHandle(),
      parent: makeParent(),
      steps: ['face-detection'],
    })

    expect(resolveChildSteps).toHaveBeenCalledWith(DEVICE_ID, 'person', ['face-detection'])
  })

  it('(f) task 6b — a clip-embedding-only subtree maps the synthesized full-crop detection to the padded parent rect, embedding attached', async () => {
    const frameHandle = makeFrameHandle()
    const parent = makeParent({ bbox: { x: 50, y: 60, w: 20, h: 30 }, className: 'vehicle' })
    const step = makeStep({ addonId: 'clip-embedding', modelId: 'mobileclip-s1' })

    // The padded parent rect the crop covers, in FRAME-space pixels (exact
    // arithmetic is already exercised in test (a) — this test's focus is
    // the clip-embedding-only end-to-end shape, not the padding math).
    const paddedFrameSpace = { x: 42.5, y: 55.5, w: 30, h: 39 }
    const crop: CropSource = {
      jpeg: Buffer.from('clip-crop-jpeg'),
      width: 64,
      height: 64,
      frameSpace: paddedFrameSpace,
      source: 'native',
    }

    const embeddingNorm = [0.1, 0.2, 0.3, 0.4]
    // Mirrors `PipelineExecutor`'s root-level classifier/embedding synthesis
    // (task 6b): a clip-embedding chain promoted to a subtree ROOT yields
    // ONE detection covering the ENTIRE crop, carrying the embedding — the
    // same shape `executeChildren` produces when clip-embedding runs as a
    // CHILD of object-detection.
    const syntheticDetection = makeDetection({
      id: 'd1',
      kind: 'first-level',
      macroClass: 'embedding',
      score: 1,
      bbox: { x: 0, y: 0, width: crop.width, height: crop.height },
      labels: [{ label: 'embedding:4d', score: 1 }],
      embedding: embeddingNorm,
      embeddingModelId: 'mobileclip-s1',
    })

    const getNativeCrop = vi.fn().mockResolvedValue(crop)
    const runPipeline = vi.fn().mockResolvedValue(makeFrameResult([syntheticDetection]))
    const resolveChildSteps = vi.fn().mockReturnValue([step])

    const deps: DetailSubtreeDeps = {
      ...baseDeps,
      resolveChildSteps,
      getNativeCrop,
      runPipeline,
    }

    const result = await runDetailSubtree(deps, {
      deviceId: DEVICE_ID,
      frameHandle,
      parent,
    })

    assertDetailSubtreeResult(result)
    expect(result.details).toHaveLength(1)
    const [detail] = result.details
    expect(detail!.stepId).toBe('clip-embedding')
    expect(detail!.className).toBe('embedding')
    expect(detail!.score).toBe(1)
    // The synthesized detection spans the ENTIRE crop, so mapping it back
    // to frame space collapses to exactly the padded parent rect the crop
    // covers — the same rect `resolveCrop` requested from `getNativeCrop`.
    expect(detail!.bbox).toEqual(crop.frameSpace)
    expect(detail!.embedding).toBe(
      Buffer.from(Float32Array.from(embeddingNorm).buffer).toString('base64'),
    )
  })

  // Strict-`steps` pruning (F4): `resolveChildSteps`/`filter` only selects the
  // top-level `face-detection` root — its `face-embedding` child rides along.
  // `runDetailSubtree` must prune that child to exactly the requested set so a
  // periodic geometry-only refresh does NOT re-run ArcFace.
  //
  // The mocked runPipeline mimics the executor: it emits an `embedding` on the
  // result ONLY when the `face-embedding` child is still present on the step it
  // is asked to run, so the pruning's effect is observable in the details.
  const faceStepWithEmbeddingChild = (): PipelineStepInputOutput => ({
    addonId: 'face-detection',
    modelId: 'scrfd-2.5g',
    enabled: true,
    children: [{ addonId: 'face-embedding', modelId: 'arcface-r100', enabled: true }],
  })

  const embeddingAwareRunPipeline = (): ReturnType<typeof vi.fn> =>
    vi.fn(async (steps: readonly PipelineStepInputOutput[]) => {
      const hasEmbeddingChild = steps.some((s) =>
        (s.children ?? []).some((c) => c.addonId === 'face-embedding'),
      )
      // Inside the 40×60 crop (and so inside the parent): the D662 geometry
      // guard drops a face whose centre falls outside the person box, and the
      // shared fixture's box lies beyond this crop's own edge.
      const detection = makeDetection({
        bbox: { x: 10, y: 10, width: 20, height: 30 },
        ...(hasEmbeddingChild ? { embedding: [0.1, 0.2, 0.3, 0.4] } : {}),
      })
      return makeFrameResult([detection])
    })

  const cropFor = (): CropSource => ({
    jpeg: Buffer.from('crop'),
    width: 40,
    height: 60,
    frameSpace: { x: 100, y: 100, w: 50, h: 80 },
    source: 'native',
  })

  it('(g) steps: [face-detection, face-embedding] — keeps the embedding child, embedding present in results', async () => {
    const runPipeline = embeddingAwareRunPipeline()
    const resolveChildSteps = vi.fn().mockReturnValue([faceStepWithEmbeddingChild()])
    const getNativeCrop = vi.fn().mockResolvedValue(cropFor())
    const deps: DetailSubtreeDeps = {
      ...baseDeps,
      resolveChildSteps,
      getNativeCrop,
      runPipeline,
    }

    const result = await runDetailSubtree(deps, {
      deviceId: DEVICE_ID,
      frameHandle: makeFrameHandle(),
      parent: makeParent(),
      steps: ['face-detection', 'face-embedding'],
    })

    const [ranSteps] = runPipeline.mock.calls[0] as [readonly PipelineStepInputOutput[]]
    expect(ranSteps[0]!.children).toHaveLength(1)
    expect(ranSteps[0]!.children![0]!.addonId).toBe('face-embedding')
    assertDetailSubtreeResult(result)
    expect(result.details).toHaveLength(1)
    expect(result.details[0]!.embedding).toBeDefined()
  })

  it('(h) steps: [face-detection] — prunes the embedding child, face bbox present but NO embedding', async () => {
    const runPipeline = embeddingAwareRunPipeline()
    const resolveChildSteps = vi.fn().mockReturnValue([faceStepWithEmbeddingChild()])
    const getNativeCrop = vi.fn().mockResolvedValue(cropFor())
    const deps: DetailSubtreeDeps = {
      ...baseDeps,
      resolveChildSteps,
      getNativeCrop,
      runPipeline,
    }

    const result = await runDetailSubtree(deps, {
      deviceId: DEVICE_ID,
      frameHandle: makeFrameHandle(),
      parent: makeParent(),
      steps: ['face-detection'],
    })

    const [ranSteps] = runPipeline.mock.calls[0] as [readonly PipelineStepInputOutput[]]
    expect(ranSteps[0]!.addonId).toBe('face-detection')
    expect(ranSteps[0]!.children).toHaveLength(0)
    assertDetailSubtreeResult(result)
    expect(result.details).toHaveLength(1)
    expect(result.details[0]!.className).toBe('face')
    expect(result.details[0]!.bbox).toBeDefined()
    expect(result.details[0]!.embedding).toBeUndefined()
  })

  it('(i) steps omitted — no pruning, the full configured chain (embedding child) rides along', async () => {
    const runPipeline = embeddingAwareRunPipeline()
    const resolveChildSteps = vi.fn().mockReturnValue([faceStepWithEmbeddingChild()])
    const getNativeCrop = vi.fn().mockResolvedValue(cropFor())
    const deps: DetailSubtreeDeps = {
      ...baseDeps,
      resolveChildSteps,
      getNativeCrop,
      runPipeline,
    }

    const result = await runDetailSubtree(deps, {
      deviceId: DEVICE_ID,
      frameHandle: makeFrameHandle(),
      parent: makeParent(),
    })

    const [ranSteps] = runPipeline.mock.calls[0] as [readonly PipelineStepInputOutput[]]
    expect(ranSteps[0]!.children).toHaveLength(1)
    assertDetailSubtreeResult(result)
    expect(result.details[0]!.embedding).toBeDefined()
  })
})

describe('pruneChildStepsToRequested', () => {
  const faceDetectionWithEmbedding: PipelineStepInputOutput = {
    addonId: 'face-detection',
    modelId: 'scrfd-2.5g',
    enabled: true,
    children: [{ addonId: 'face-embedding', modelId: 'arcface-r100', enabled: true }],
  }

  it('drops a child whose id is not in the requested set', () => {
    const pruned = pruneChildStepsToRequested(faceDetectionWithEmbedding, ['face-detection'])
    expect(pruned.children).toHaveLength(0)
    // Pure: the input is not mutated.
    expect(faceDetectionWithEmbedding.children).toHaveLength(1)
  })

  it('keeps a child whose id is in the requested set', () => {
    const pruned = pruneChildStepsToRequested(faceDetectionWithEmbedding, [
      'face-detection',
      'face-embedding',
    ])
    expect(pruned.children).toHaveLength(1)
    expect(pruned.children![0]!.addonId).toBe('face-embedding')
  })

  it('prunes recursively through grandchildren', () => {
    const tree: PipelineStepInputOutput = {
      addonId: 'face-detection',
      enabled: true,
      children: [
        {
          addonId: 'face-embedding',
          enabled: true,
          children: [{ addonId: 'identity-refiner', enabled: true }],
        },
      ],
    }
    const pruned = pruneChildStepsToRequested(tree, ['face-detection', 'face-embedding'])
    expect(pruned.children).toHaveLength(1)
    // grandchild `identity-refiner` is not requested → dropped.
    expect(pruned.children![0]!.children).toHaveLength(0)
  })

  it('is a no-op for a leaf step (no children)', () => {
    const leaf: PipelineStepInputOutput = { addonId: 'face-detection', enabled: true }
    expect(pruneChildStepsToRequested(leaf, [])).toBe(leaf)
  })
})

describe('findMatchingDetailSteps', () => {
  const catalog: Record<string, StepClassDefinition> = {
    'object-detection': { inputClasses: null },
    'face-detection': { inputClasses: ['person'] },
    'face-embedding': { inputClasses: ['face'] },
    'plate-detection': { inputClasses: ['vehicle'] },
    'plate-ocr': { inputClasses: ['plate'] },
  }
  const lookup = (stepId: string): StepClassDefinition | null => catalog[stepId] ?? null

  it('(e) matches a nested child step and keeps its OWN nested children (transitive inclusion)', () => {
    const tree: readonly PipelineStepInputOutput[] = [
      {
        addonId: 'object-detection',
        modelId: 'yolo26n',
        enabled: true,
        children: [
          {
            addonId: 'face-detection',
            modelId: 'scrfd-2.5g',
            enabled: true,
            children: [{ addonId: 'face-embedding', modelId: 'arcface-r100', enabled: true }],
          },
        ],
      },
    ]

    const matches = findMatchingDetailSteps(tree, 'person', lookup)

    expect(matches).toHaveLength(1)
    expect(matches[0]!.addonId).toBe('face-detection')
    // face-embedding rides along unchanged as a nested child — NOT hoisted
    // to a separate top-level match.
    expect(matches[0]!.children).toHaveLength(1)
    expect(matches[0]!.children![0]!.addonId).toBe('face-embedding')
  })

  it('does not match a disabled step, and does not recurse into a disabled branch', () => {
    const tree: readonly PipelineStepInputOutput[] = [
      {
        addonId: 'object-detection',
        enabled: true,
        children: [{ addonId: 'face-detection', enabled: false }],
      },
    ]

    expect(findMatchingDetailSteps(tree, 'person', lookup)).toHaveLength(0)
  })

  it('applies the filter to keep only the requested top-level match', () => {
    const tree: readonly PipelineStepInputOutput[] = [
      {
        addonId: 'object-detection',
        enabled: true,
        children: [
          { addonId: 'face-detection', enabled: true },
          { addonId: 'plate-detection', enabled: true, children: [] },
        ],
      },
    ]

    // Both face-detection (inputClasses ['person']) matches 'person'; plate-detection does not.
    const matches = findMatchingDetailSteps(tree, 'person', lookup, ['face-detection'])
    expect(matches).toHaveLength(1)
    expect(matches[0]!.addonId).toBe('face-detection')
  })
})

describe('runDetailSubtree — a root-supplied plate (D730)', () => {
  it('maps the frame-space root box into the crop and hands it to the executor', async () => {
    const frameHandle = makeFrameHandle()
    const crop: CropSource = {
      jpeg: Buffer.from('vehicle-crop'),
      width: 200,
      height: 100,
      frameSpace: { x: 100, y: 100, w: 400, h: 200 },
      source: 'native',
    }
    const plateStep = makeStep({
      addonId: 'plate-detection',
      modelId: 'yolox-tiny-plate',
      children: [{ addonId: 'plate-ocr', enabled: true }],
    })
    const runPipeline = vi.fn().mockResolvedValue(makeFrameResult([]))
    const deps: DetailSubtreeDeps = {
      ...baseDeps,
      resolveChildSteps: vi.fn().mockReturnValue([plateStep]),
      getNativeCrop: vi.fn().mockResolvedValue(crop),
      runPipeline,
    }
    await runDetailSubtree(deps, {
      deviceId: DEVICE_ID,
      frameHandle,
      parent: makeParent({ className: 'vehicle', bbox: { x: 120, y: 120, w: 360, h: 160 } }),
      steps: ['plate-detection', 'plate-ocr'],
      supplied: {
        stepId: 'plate-detection',
        modelId: 'frigate-plus',
        boxes: [{ bbox: { x: 300, y: 260, w: 40, h: 20 }, score: 0.66 }],
      },
    })
    // scale 0.5: x = (300-100)*0.5 = 100, y = (260-100)*0.5 = 80
    expect(runPipeline.mock.calls[0]?.[5]).toEqual({
      stepId: 'plate-detection',
      modelId: 'frigate-plus',
      detections: [{ bbox: [100, 80, 120, 90], score: 0.66 }],
    })
  })

  it('a root box entirely outside the crop runs nothing, and says so', async () => {
    const warn = vi.fn()
    const runPipeline = vi.fn()
    await runDetailSubtree(
      {
        ...baseDeps,
        logger: { ...silentLogger, warn },
        resolveChildSteps: vi.fn().mockReturnValue([makeStep({ addonId: 'plate-detection' })]),
        getNativeCrop: vi.fn().mockResolvedValue({
          jpeg: Buffer.from('c'),
          width: 100,
          height: 100,
          frameSpace: { x: 0, y: 0, w: 100, h: 100 },
          source: 'native',
        }),
        runPipeline,
      },
      {
        deviceId: DEVICE_ID,
        frameHandle: makeFrameHandle(),
        parent: makeParent({ className: 'vehicle' }),
        supplied: {
          stepId: 'plate-detection',
          modelId: 'frigate-plus',
          boxes: [{ bbox: { x: 300, y: 300, w: 10, h: 5 }, score: 0.5 }],
        },
      },
    )
    expect(runPipeline).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      'runDetailSubtree: the root-supplied boxes fall outside the crop — nothing to read',
      expect.objectContaining({ tags: { deviceId: DEVICE_ID } }),
    )
  })
})
