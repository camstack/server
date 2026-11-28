/**
 * The confirmation gate re-judges a birth on a crop that shows the subject at
 * a scale the detector can score — a square window FOUR times the subject's
 * longer side — never on the subject padded 15% and blown up to fill the model
 * input.
 *
 * Camera 1441, 2026-11-17 13:34:38 UTC: track `9meh6be4xk`, a person walking
 * (live 0.35–0.65), was retracted with `bestScore 0.107` on its native crop.
 * The same frame, replayed through the same `yolov9m-640-int8`:
 *
 *   full 640 letterbox (subject ~15×45 px in the input)        0.70
 *   the gate's crop: box + 15% (127×394), letterboxed to 640    0.00
 *   square window 4× the long side (1212 px), capped 320 wide   0.71
 *
 * Over the nine person frames of that passage the old crop cleared the 0.4 bar
 * 3 times and the 4× window 8 times. The old crop was not wrong in its
 * coordinates or its aspect (it is letterboxed, not stretched): it was wrong in
 * SCALE — the subject filled ~77% of the input, 1.6–2× magnified soft native
 * pixels, a view the detector that made the claim never saw.
 */
import type {
  FrameHandle,
  FrameResult,
  IEventBus,
  ObjectDetection,
  PipelineInferenceResultPayload,
} from '@dominevo/types'
import { createEvent, EventCategory } from '@dominevo/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONFIRMATION_CONTEXT_FACTOR,
  CONFIRMATION_CROP_MAX_WIDTH,
  confirmationCropWindow,
} from '../birth/birth-redetect.js'
import { type Booted, bootAnalytics } from './boot-analytics.js'
import { FAKE_SESSION_ROOT, makeFakePipelineExecutor } from './test-helpers.js'

const DEVICE_ID = 1441
const HANDLE: FrameHandle = {
  shmId: 'ring-1441',
  slot: 0,
  seq: 2,
  width: 640,
  height: 480,
  format: 'rgb',
  pts: 1,
  byteLength: 640 * 480 * 3,
  nodeId: 'hub',
  slotCount: 8,
}
const CROP_JPEG_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')

/** A walker: 30×90 in a 640×480 analysis frame. */
const PERSON: ObjectDetection = {
  id: 'p0',
  kind: 'first-level',
  macroClass: 'person',
  score: 0.9,
  labels: [],
  bbox: { x: 400, y: 150, width: 30, height: 90 },
}

function buildFrame(timestamp: number, detections: readonly ObjectDetection[]): FrameResult {
  return {
    kind: 'frame',
    ...FAKE_SESSION_ROOT,
    frameId: `f-${timestamp}`,
    deviceId: DEVICE_ID,
    timestamp,
    width: 640,
    height: 480,
    detections,
  }
}

function emitInference(bus: IEventBus, frame: FrameResult): void {
  const payload: PipelineInferenceResultPayload = {
    deviceId: DEVICE_ID,
    frame,
    nodeId: 'hub',
    frameHandle: HANDLE,
  }
  bus.emit(
    createEvent(
      EventCategory.PipelineInferenceResult,
      { type: 'addon', id: 'pipeline-runner' },
      payload,
    ),
  )
}

async function flush(stepMs: number): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs))
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

describe('the confirmation crop shows the subject with context', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    await flush(1)
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('asks the runner for a square window 4× the long side, centred on the subject', async () => {
    const { executor } = makeFakePipelineExecutor(() => ({
      width: 320,
      height: 320,
      detections: [
        { macroClass: 'person', score: 0.7, bbox: { x: 140, y: 120, width: 30, height: 80 } },
      ],
    }))
    booted = await bootAnalytics(
      DEVICE_ID,
      async (request) =>
        request.maxWidth === CONFIRMATION_CROP_MAX_WIDTH
          ? { jpeg: CROP_JPEG_BASE64, width: 320, height: 320, tier: 'native' }
          : null,
      { pipelineExecutor: executor },
    )
    for (let i = 0; i < 4; i += 1) {
      emitInference(booted.bus.bus, buildFrame(1_000 + i * 100, [{ ...PERSON, id: `p${i}` }]))
      await flush(5)
    }
    await flush(20)

    const confirmations = booted.requests.filter((r) => r.maxWidth === CONFIRMATION_CROP_MAX_WIDTH)
    expect(confirmations.length, 'the gate asked for a crop').toBeGreaterThan(0)
    const { bbox } = confirmations[0]!
    // Long side 90 → a 360 px square centred on (415, 195): x 235..595, y 15..375.
    expect(bbox.x * 640).toBeCloseTo(235, 3)
    expect(bbox.y * 480).toBeCloseTo(15, 3)
    expect(bbox.w * 640).toBeCloseTo(360, 3)
    expect(bbox.h * 480).toBeCloseTo(360, 3)
    // The subject is at most a quarter of the window's long side.
    expect(90 / (bbox.h * 480)).toBeLessThanOrEqual(1 / CONFIRMATION_CONTEXT_FACTOR + 1e-9)
  }, 30_000)
})

describe('a CARRIED crop is placed where the runner cut it — box + 15%, not the window', () => {
  let booted: Booted | undefined

  afterEach(async () => {
    await flush(1)
    if (booted) await booted.addon.shutdown()
    booted = undefined
  })

  it('puts a box the detector found in the carried crop back through the tight rectangle', async () => {
    // The runner's carried crop (D379): the person padded 15% — frame 395.5,
    // 136.5, 39×117 — here a 78×234 JPEG (×2). On it the detector sees the
    // person and a car at the crop's lower right.
    const { executor } = makeFakePipelineExecutor(() => ({
      width: 78,
      height: 234,
      detections: [
        { macroClass: 'person', score: 0.9, bbox: { x: 9, y: 27, width: 60, height: 180 } },
        { macroClass: 'vehicle', score: 0.9, bbox: { x: 60, y: 180, width: 18, height: 54 } },
      ],
    }))
    // No native crop at all: the carried crop is the only measurement.
    booted = await bootAnalytics(DEVICE_ID, async () => null, { pipelineExecutor: executor })
    const carried: ObjectDetection = {
      ...PERSON,
      birthEvidence: {
        jpegBase64: CROP_JPEG_BASE64,
        rect: { x: 395.5, y: 136.5, width: 39, height: 117 },
        tier: 'analysis',
      },
    }
    for (let i = 0; i < 4; i += 1) {
      emitInference(booted.bus.bus, buildFrame(1_000 + i * 100, [{ ...carried, id: `p${i}` }]))
      await flush(5)
    }
    await flush(20)

    const promoted = booted.logs.find(
      (line) => line.message === 'confirmation gate: secondary subject promoted from the crop',
    )
    expect(promoted, 'the car beside the carried person was promoted').toBeDefined()
    // Through the TIGHT rectangle: 395.5 + (60/78)·39, 136.5 + (180/234)·117.
    // Through the 360 px window it would land at x ≈ 512 — outside the tight
    // crop, and not promoted at all.
    expect(promoted?.extras).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: {
        cropSource: 'carried',
        secondaryBbox: {
          x: expect.closeTo(425.5, 3),
          y: expect.closeTo(226.5, 3),
          w: expect.closeTo(9, 3),
          h: expect.closeTo(27, 3),
        },
      },
    })
  }, 30_000)
})

describe('confirmationCropWindow', () => {
  it('slides a window that overflows an edge back inside, keeping its size', () => {
    // Subject against the right border: the 360 px square would end at 760.
    expect(confirmationCropWindow({ x: 600, y: 150, w: 30, h: 90 }, 640, 480)).toEqual({
      x: 280,
      y: 15,
      w: 360,
      h: 360,
    })
  })

  it('caps each side at the frame — a large subject is judged on the whole frame', () => {
    expect(confirmationCropWindow({ x: 200, y: 100, w: 120, h: 240 }, 640, 480)).toEqual({
      x: 0,
      y: 0,
      w: 640,
      h: 480,
    })
  })

  it('always contains the subject', () => {
    const box = { x: 10, y: 400, w: 50, h: 70 }
    const win = confirmationCropWindow(box, 640, 480)
    expect(win.x).toBeLessThanOrEqual(box.x)
    expect(win.y).toBeLessThanOrEqual(box.y)
    expect(win.x + win.w).toBeGreaterThanOrEqual(box.x + box.w)
    expect(win.y + win.h).toBeGreaterThanOrEqual(box.y + box.h)
  })
})
