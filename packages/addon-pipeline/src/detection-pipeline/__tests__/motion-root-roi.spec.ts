import { describe, expect, it } from 'vitest'
import {
  MotionRootRoiGovernor,
  ROI_FORCED_FULL_INTERVAL_MS,
  ROI_LIVE_BOX_MAX_AGE_MS,
  ROI_MAX_FRAME_FRACTION,
  ROI_MIN_FRAME_FRACTION,
  planMotionRootRoi,
} from '../motion-root-roi.js'

// Camera 1441 "Retro": 4256x1888 main stream, a 640x640 root model.
const FRAME = { width: 4256, height: 1888 }
const MODEL = { width: 640, height: 640 }
// A person at the conservatory door: ~100x290 native px.
const PERSON = { x: 2000 / 4256, y: 1000 / 1888, w: 100 / 4256, h: 290 / 1888 }

describe('planMotionRootRoi — geometry', () => {
  it('grows a small subject to the minimum side, never a native 1:1 crop', () => {
    const plan = planMotionRootRoi({
      motion: [PERSON],
      liveBoxes: [],
      frame: FRAME,
      modelInput: MODEL,
    })
    expect(plan.source).toBe('roi')
    if (plan.source !== 'roi') return
    const minLong = ROI_MIN_FRAME_FRACTION * FRAME.width // 1915.2
    expect(plan.crop.width).toBeGreaterThanOrEqual(Math.floor(minLong))
    // Downscaled at least 2x into the 640 input.
    expect(plan.crop.width / MODEL.width).toBeGreaterThanOrEqual(2)
    // Centred on the subject.
    expect(plan.crop.left + plan.crop.width / 2).toBeCloseTo(2050, -1)
  })

  it('takes the model aspect when the frame allows it', () => {
    const wideModel = { width: 640, height: 320 }
    const plan = planMotionRootRoi({
      motion: [PERSON],
      liveBoxes: [],
      frame: FRAME,
      modelInput: wideModel,
    })
    expect(plan.source).toBe('roi')
    if (plan.source !== 'roi') return
    expect(plan.crop.width / plan.crop.height).toBeCloseTo(2, 1)
  })

  it('clamps at the frame edge by shifting, not cutting', () => {
    const corner = { x: 0, y: 0, w: 50 / 4256, h: 120 / 1888 }
    const plan = planMotionRootRoi({
      motion: [corner],
      liveBoxes: [],
      frame: FRAME,
      modelInput: MODEL,
    })
    expect(plan.source).toBe('roi')
    if (plan.source !== 'roi') return
    expect(plan.crop.left).toBe(0)
    expect(plan.crop.top).toBe(0)
    // The square is clipped only where the frame is shorter than the side.
    expect(plan.crop.height).toBe(FRAME.height)
    expect(plan.crop.width).toBeGreaterThanOrEqual(1915)
  })

  it('falls back to the full frame when the union is above the ceiling', () => {
    const farApart = [
      PERSON,
      { x: 0.02, y: 0.1, w: 0.02, h: 0.1 },
      { x: 0.95, y: 0.1, w: 0.02, h: 0.1 },
    ]
    const plan = planMotionRootRoi({
      motion: farApart,
      liveBoxes: [],
      frame: FRAME,
      modelInput: MODEL,
    })
    expect(plan).toEqual({ source: 'full', reason: 'roi-too-large' })
    expect(ROI_MAX_FRAME_FRACTION).toBe(0.6)
  })

  it('a low-resolution frame never crops: the 2x floor exceeds the ceiling', () => {
    const plan = planMotionRootRoi({
      motion: [{ x: 0.5, y: 0.5, w: 0.02, h: 0.05 }],
      liveBoxes: [],
      frame: { width: 1920, height: 1080 },
      modelInput: MODEL,
    })
    expect(plan).toEqual({ source: 'full', reason: 'roi-too-large' })
  })

  it('no motion and no live box: full frame', () => {
    expect(
      planMotionRootRoi({ motion: [], liveBoxes: [], frame: FRAME, modelInput: MODEL }),
    ).toEqual({
      source: 'full',
      reason: 'no-motion',
    })
  })

  it('a live box alone keeps a still subject in the crop', () => {
    const plan = planMotionRootRoi({
      motion: [],
      liveBoxes: [PERSON],
      frame: FRAME,
      modelInput: MODEL,
    })
    expect(plan.source).toBe('roi')
  })
})

describe('MotionRootRoiGovernor — cadence', () => {
  it('forces a full frame first and then about once per interval', () => {
    const gov = new MotionRootRoiGovernor()
    const decide = (now: number) =>
      gov.decide({ deviceId: 7, now, motion: [PERSON], frame: FRAME, modelInput: MODEL })
    expect(decide(0)).toMatchObject({ source: 'full', reason: 'forced-full' })
    expect(decide(200)).toMatchObject({ source: 'roi', reason: 'motion' })
    expect(decide(ROI_FORCED_FULL_INTERVAL_MS - 1)).toMatchObject({ source: 'roi' })
    expect(decide(ROI_FORCED_FULL_INTERVAL_MS)).toMatchObject({
      source: 'full',
      reason: 'forced-full',
    })
    expect(decide(ROI_FORCED_FULL_INTERVAL_MS + 200)).toMatchObject({ source: 'roi' })
  })

  it('cadence is per camera', () => {
    const gov = new MotionRootRoiGovernor()
    gov.decide({ deviceId: 1, now: 0, motion: [PERSON], frame: FRAME, modelInput: MODEL })
    expect(
      gov.decide({ deviceId: 2, now: 100, motion: [PERSON], frame: FRAME, modelInput: MODEL }),
    ).toMatchObject({ reason: 'forced-full' })
  })

  it('a natural full frame restarts the cadence', () => {
    const gov = new MotionRootRoiGovernor()
    gov.decide({ deviceId: 3, now: 0, motion: [], frame: FRAME, modelInput: MODEL })
    expect(
      gov.decide({ deviceId: 3, now: 900, motion: [], frame: FRAME, modelInput: MODEL }),
    ).toMatchObject({
      reason: 'no-motion',
    })
    // 900 ms after the last full frame, not 1500 ms after the forced one.
    expect(
      gov.decide({ deviceId: 3, now: 1500, motion: [PERSON], frame: FRAME, modelInput: MODEL }),
    ).toMatchObject({ source: 'roi' })
  })

  it('recent root boxes feed the ROI until they age out', () => {
    const gov = new MotionRootRoiGovernor()
    const decide = (now: number) =>
      gov.decide({ deviceId: 4, now, motion: [], frame: FRAME, modelInput: MODEL })
    gov.noteBoxes(4, [PERSON], 0)
    expect(decide(1_500)).toMatchObject({ reason: 'forced-full' })
    expect(decide(1_600)).toMatchObject({ source: 'roi', reason: 'motion' })
    expect(decide(ROI_LIVE_BOX_MAX_AGE_MS + 100)).toMatchObject({
      source: 'full',
      reason: 'no-motion',
    })
  })
})
