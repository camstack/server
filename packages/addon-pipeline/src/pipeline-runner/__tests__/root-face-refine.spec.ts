/**
 * D731 — a root face box is a LOCATION: one face-scoped square from the
 * native lease, the face detector at an effective 160 px input, the best face's
 * landmarks back into the same step for alignment. Never an unaligned embed.
 */
import sharp from 'sharp'
import type {
  FrameHandle,
  FrameResult,
  ObjectDetection,
  PipelineStepInputOutput,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { DetailSubtreeDeps } from '../detail-subtree.js'
import { runDetailSubtree } from '../detail-subtree.js'
import { refineRootFace } from '../root-face-refine.js'

const HANDLE: FrameHandle = {
  shmId: 'seg',
  slot: 0,
  seq: 1,
  width: 3840,
  height: 2160,
  format: 'rgb',
  pts: 0,
  byteLength: 3840 * 2160 * 3,
  nodeId: 'hub',
  slotCount: 4,
}

const FACE_STEP: PipelineStepInputOutput = {
  addonId: 'face-detection',
  modelId: 'yunet-2023mar',
  enabled: true,
  children: [{ addonId: 'face-embedding', modelId: 'auraface-r100', enabled: true }],
}

const LANDMARKS = [
  { x: 60, y: 60 },
  { x: 100, y: 60 },
  { x: 80, y: 80 },
  { x: 65, y: 100 },
  { x: 95, y: 100 },
]

function face(score: number, overrides: Partial<ObjectDetection> = {}): ObjectDetection {
  return {
    id: `f${String(score)}`,
    kind: 'first-level',
    macroClass: 'face',
    score,
    bbox: { x: 40, y: 40, width: 80, height: 80 },
    labels: [],
    landmarks: LANDMARKS,
    ...overrides,
  }
}

function frame(detections: readonly ObjectDetection[]): FrameResult {
  return {
    kind: 'frame',
    frameId: 'f',
    deviceId: 7,
    timestamp: 0,
    width: 640,
    height: 640,
    detections: [...detections],
  }
}

async function squareJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 128, height: 128, channels: 3, background: { r: 200, g: 150, b: 120 } },
  })
    .jpeg()
    .toBuffer()
}

const SUPPLIED = {
  stepId: 'face-detection',
  modelId: 'plus-catalog-640',
  boxes: [
    { bbox: { x: 1010, y: 510, w: 60, h: 80 }, score: 0.9 },
    { bbox: { x: 2000, y: 900, w: 20, h: 20 }, score: 0.4 },
  ],
}

function makeDeps(found: FrameResult | null, embedded: FrameResult | null = null) {
  const warn = vi.fn()
  const runPipeline = vi
    .fn<DetailSubtreeDeps['runPipeline']>()
    .mockResolvedValueOnce(found)
    .mockResolvedValueOnce(embedded)
  const getNativeCrop = vi.fn<DetailSubtreeDeps['getNativeCrop']>(async (_d, _h, norm) => ({
    jpeg: await squareJpeg(),
    width: 128,
    height: 128,
    frameSpace: {
      x: norm.x * HANDLE.width,
      y: norm.y * HANDLE.height,
      w: norm.w * HANDLE.width,
      h: norm.h * HANDLE.height,
    },
  }))
  return {
    deps: { getNativeCrop, runPipeline, logger: { warn } },
    warn,
    runPipeline,
    getNativeCrop,
  }
}

const INPUT = {
  deviceId: 7,
  frameHandle: HANDLE,
  parent: { bbox: { x: 900, y: 400, w: 300, h: 900 }, className: 'person' },
  steps: ['face-detection', 'face-embedding'],
  supplied: SUPPLIED,
}

describe('refineRootFace', () => {
  it('cuts the 1.6× square around the BEST root box from the native lease', async () => {
    const { deps, getNativeCrop } = makeDeps(frame([]))
    await refineRootFace(deps, INPUT, SUPPLIED, FACE_STEP, INPUT.steps, undefined)
    const norm = getNativeCrop.mock.calls[0]?.[2]
    // 80 × 1.6 = 128 px square centred on (1040, 550).
    expect(norm).toEqual({ x: 976 / 3840, y: 486 / 2160, w: 128 / 3840, h: 128 / 2160 })
  })

  it('runs the detector alone on a 640 canvas holding the square at 160 px', async () => {
    const { deps, runPipeline } = makeDeps(frame([]))
    await refineRootFace(deps, INPUT, SUPPLIED, FACE_STEP, INPUT.steps, undefined)
    const [steps, jpeg] = runPipeline.mock.calls[0] ?? []
    expect(steps?.[0]?.children).toEqual([])
    const meta = await sharp(jpeg).metadata()
    expect([meta.width, meta.height]).toEqual([640, 640])
  })

  it('no face in the square ⇒ nothing, logged, the embedder never runs', async () => {
    const { deps, runPipeline, warn } = makeDeps(frame([]))
    const out = await refineRootFace(deps, INPUT, SUPPLIED, FACE_STEP, INPUT.steps, undefined)
    expect(out).toEqual([])
    expect(runPipeline).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      'root face refinement found no face in the square — dropped, never embedded unaligned',
      expect.objectContaining({ tags: { deviceId: 7 } }),
    )
  })

  it('the best face goes back to the step WITH its landmarks; results map to the frame', async () => {
    const embedded = frame([
      face(0.93, { embedding: [0.6, 0.8], embeddingModelId: 'auraface-r100' }),
    ])
    const { deps, runPipeline } = makeDeps(frame([face(0.7), face(0.93)]), embedded)
    const out = await refineRootFace(deps, INPUT, SUPPLIED, FACE_STEP, INPUT.steps, undefined)
    const supplied = runPipeline.mock.calls[1]?.[5]
    expect(supplied).toEqual({
      stepId: 'face-detection',
      modelId: 'yunet-2023mar',
      detections: [{ bbox: [40, 40, 120, 120], score: 0.93, landmarks: LANDMARKS }],
    })
    // The 160 px region is the 128 px square: canvas px × 0.8 + the square's origin.
    expect(out?.[0]?.bbox).toEqual({ x: 976 + 32, y: 486 + 32, w: 64, h: 64 })
    expect(out?.[0]?.embedding).toBeDefined()
  })

  it('no frame handle ⇒ null and a line — the native lease is the only source', async () => {
    const { deps, warn, getNativeCrop } = makeDeps(frame([]))
    const { frameHandle: _h, ...noHandle } = INPUT
    expect(
      await refineRootFace(deps, noHandle, SUPPLIED, FACE_STEP, INPUT.steps, undefined),
    ).toBeNull()
    expect(getNativeCrop).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })
})

describe('runDetailSubtree routes a supplied face to refinement, never to the subject crop', () => {
  it('the subject convention is never asked for a cut', async () => {
    const { deps } = makeDeps(frame([]))
    const resolveCropConvention = vi.fn()
    await runDetailSubtree(
      {
        ...deps,
        resolveChildSteps: () => [FACE_STEP],
        resolveCropConvention,
      },
      INPUT,
    )
    expect(resolveCropConvention).not.toHaveBeenCalled()
  })
})
