/**
 * D662 — a face whose centre lies outside the UNPADDED person box is not that
 * person's face.
 *
 * The detail plane feeds the face detector a PADDED crop of the person
 * (`deriveDetailCropRect`), so anything in the margin is fair game for the
 * detector. On camera 102 (2026-09-27) a car wheel in that margin was buffered
 * as a face twice (0.51 and 0.81): person box {x:2640,y:526,w:502,h:898}, the
 * "face" at x≈3070 with its top at y≈419 — ABOVE the person's own top edge.
 */
import { describe, expect, it, vi } from 'vitest'
import type {
  DetailParent,
  FrameHandle,
  FrameResult,
  ObjectDetection,
  PipelineStepInputOutput,
} from '@camstack/types'
import { DEFAULT_DETAIL_CROP_CONVENTION } from '@camstack/types'
import { type CropSource, type DetailSubtreeDeps, runDetailSubtree } from '../detail-subtree.js'
import {
  type FaceOutsideParentDrop,
  FaceOutsideParentLog,
  faceCentreInsideParent,
} from '../face-parent-geometry.js'

const DEVICE_ID = 102

/** The person the wheel rode on, frame pixels (track `sfbdv8fm5r`). */
const PERSON = { x: 2640, y: 526, w: 502, h: 898 }
/** The wheel: x≈3070, top y≈419 — centre (3070, 449), 77 px above the person. */
const WHEEL = { x: 3040, y: 419, w: 60, h: 60 }
/** A real face at the top of the same person box. */
const FACE = { x: 2850, y: 540, w: 90, h: 100 }

describe('faceCentreInsideParent', () => {
  it('drops the wheel: its centre is above the unpadded person box', () => {
    expect(faceCentreInsideParent(WHEEL, PERSON)).toBe(false)
  })

  it('keeps a face inside the person box', () => {
    expect(faceCentreInsideParent(FACE, PERSON)).toBe(true)
  })

  it('keeps a head the person box clips at the top, as long as its centre is inside', () => {
    // A detector often puts the person's top edge at the forehead.
    expect(faceCentreInsideParent({ x: 2850, y: 480, w: 90, h: 100 }, PERSON)).toBe(true)
  })

  it('drops a face beside the person (centre left of the box)', () => {
    expect(faceCentreInsideParent({ x: 2560, y: 700, w: 60, h: 60 }, PERSON)).toBe(false)
  })
})

// ── through the real detail plane ────────────────────────────────────────────

/** The padded crop the runner cut: PERSON padded by 0.15, 1:1 pixels. */
const PADDED = { x: 2564.7, y: 391.3, w: 652.6, h: 1167.4 }

function faceDetection(id: string, frame: typeof FACE, score: number): ObjectDetection {
  return {
    id,
    kind: 'first-level',
    macroClass: 'face',
    score,
    // crop space = frame space − crop origin (the crop is 1:1)
    bbox: { x: frame.x - PADDED.x, y: frame.y - PADDED.y, width: frame.w, height: frame.h },
    labels: [],
  }
}

function frameResult(detections: readonly ObjectDetection[]): FrameResult {
  return {
    kind: 'frame',
    frameId: 'f1',
    deviceId: DEVICE_ID,
    timestamp: 0,
    width: PADDED.w,
    height: PADDED.h,
    detections,
  }
}

const HANDLE: FrameHandle = {
  shmId: 'seg-1',
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

const PARENT: DetailParent = { bbox: PERSON, className: 'person' }
const STEP: PipelineStepInputOutput = {
  addonId: 'face-detection',
  modelId: 'yunet-2023mar',
  enabled: true,
}

function depsWith(
  detections: readonly ObjectDetection[],
  recordFaceOutsideParent?: (drop: FaceOutsideParentDrop) => void,
): DetailSubtreeDeps {
  const crop: CropSource = {
    jpeg: Buffer.from('native'),
    width: PADDED.w,
    height: PADDED.h,
    frameSpace: PADDED,
    source: 'native',
  }
  return {
    resolveChildSteps: () => [STEP],
    getNativeCrop: async () => crop,
    runPipeline: async () => frameResult(detections),
    resolveCropConvention: () => DEFAULT_DETAIL_CROP_CONVENTION,
    logger: { warn: () => undefined },
    ...(recordFaceOutsideParent !== undefined ? { recordFaceOutsideParent } : {}),
  }
}

describe('runDetailSubtree — the geometry guard', () => {
  it('returns the real face and not the wheel, and reports the drop per camera', async () => {
    const drops: FaceOutsideParentDrop[] = []
    const result = await runDetailSubtree(
      depsWith([faceDetection('wheel', WHEEL, 0.81), faceDetection('face', FACE, 0.9)], (d) =>
        drops.push(d),
      ),
      { deviceId: DEVICE_ID, frameHandle: HANDLE, parent: PARENT },
    )
    const details = result !== null && 'details' in result ? result.details : []
    expect(details.map((d) => d.score)).toEqual([0.9])
    expect(drops).toHaveLength(1)
    expect(drops[0]?.deviceId).toBe(DEVICE_ID)
    expect(drops[0]?.score).toBe(0.81)
    expect(drops[0]?.parentBbox).toEqual(PERSON)
  })

  it('never drops silently: without a recorder the drop is still logged, tagged with the camera', async () => {
    const warn = vi.fn()
    const deps = { ...depsWith([faceDetection('wheel', WHEEL, 0.81)]), logger: { warn } }
    const result = await runDetailSubtree(deps, {
      deviceId: DEVICE_ID,
      frameHandle: HANDLE,
      parent: PARENT,
    })
    expect(result !== null && 'details' in result ? result.details : null).toEqual([])
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('outside the person box'),
      expect.objectContaining({ tags: { deviceId: DEVICE_ID } }),
    )
  })

  it('leaves non-face details alone (a plate is judged by nobody here)', async () => {
    const plate: ObjectDetection = { ...faceDetection('p', WHEEL, 0.7), macroClass: 'plate' }
    const result = await runDetailSubtree(depsWith([plate]), {
      deviceId: DEVICE_ID,
      frameHandle: HANDLE,
      parent: PARENT,
    })
    expect(result !== null && 'details' in result ? result.details.length : 0).toBe(1)
  })
})

// ── the rate-limited log ─────────────────────────────────────────────────────

describe('FaceOutsideParentLog — per camera, rate-limited, never silent', () => {
  const drop = (deviceId: number): FaceOutsideParentDrop => ({
    deviceId,
    score: 0.81,
    faceBbox: WHEEL,
    parentBbox: PERSON,
  })

  it('logs the first drop at once, then one summary per window with what it held back', () => {
    let now = 0
    const info = vi.fn()
    const log = new FaceOutsideParentLog({
      info,
      now: () => now,
      intervalMs: 60_000,
      schedule: () => undefined,
    })
    log.record(drop(DEVICE_ID))
    log.record(drop(DEVICE_ID))
    log.record(drop(DEVICE_ID))
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0]?.[1]).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: { droppedSinceLastLine: 1 },
    })
    now = 60_000
    log.record(drop(DEVICE_ID))
    expect(info).toHaveBeenCalledTimes(2)
    // The two held back plus this one.
    expect(info.mock.calls[1]?.[1]).toMatchObject({ meta: { droppedSinceLastLine: 3 } })
  })

  it('one camera does not silence another', () => {
    const info = vi.fn()
    const log = new FaceOutsideParentLog({
      info,
      now: () => 0,
      intervalMs: 60_000,
      schedule: () => undefined,
    })
    log.record(drop(101))
    log.record(drop(102))
    expect(info.mock.calls.map((c) => c[1]?.tags?.deviceId)).toEqual([101, 102])
  })

  it('flushes the held-back count when the window closes, even if drops stop', () => {
    const info = vi.fn()
    const timers: { fn: () => void; delayMs: number }[] = []
    const log = new FaceOutsideParentLog({
      info,
      now: () => 0,
      intervalMs: 60_000,
      schedule: (fn, delayMs) => {
        timers.push({ fn, delayMs })
      },
    })
    log.record(drop(DEVICE_ID))
    log.record(drop(DEVICE_ID))
    log.record(drop(DEVICE_ID))
    // One flush armed for the held drops, not one per drop.
    expect(timers).toHaveLength(1)
    expect(timers[0]?.delayMs).toBe(60_000)
    timers[0]?.fn()
    expect(info).toHaveBeenCalledTimes(2)
    expect(info.mock.calls[1]?.[1]).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: { droppedSinceLastLine: 2 },
    })
    // Nothing held ⇒ a flush says nothing.
    timers[0]?.fn()
    expect(info).toHaveBeenCalledTimes(2)
  })
})

describe('runDetailSubtree — the pre-cut crop rung cannot be judged, and says so', () => {
  it('logs, per camera, that the guard could not run on a caller-cut tile', async () => {
    const sharp = (await import('sharp')).default
    const tile = await sharp(Buffer.alloc(20 * 30 * 3, 128), {
      raw: { width: 20, height: 30, channels: 3 },
    })
      .jpeg()
      .toBuffer()
    const warn = vi.fn()
    const face: ObjectDetection = {
      id: 'f',
      kind: 'first-level',
      macroClass: 'face',
      score: 0.9,
      bbox: { x: 2, y: 2, width: 10, height: 10 },
      labels: [],
    }
    const deps: DetailSubtreeDeps = {
      resolveChildSteps: () => [STEP],
      getNativeCrop: async () => null,
      runPipeline: async () => frameResult([face]),
      resolveCropConvention: () => DEFAULT_DETAIL_CROP_CONVENTION,
      logger: { warn },
    }
    const result = await runDetailSubtree(deps, {
      deviceId: DEVICE_ID,
      parent: PARENT,
      cropJpeg: tile.toString('base64'),
    })
    expect(result !== null && 'details' in result ? result.details.length : 0).toBe(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('geometry guard cannot run'),
      expect.objectContaining({ tags: { deviceId: DEVICE_ID } }),
    )
  })
})
