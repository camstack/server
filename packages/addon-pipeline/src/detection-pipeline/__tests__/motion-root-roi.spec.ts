import type { RootInputSource, StepDefinition } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  MAX_SUBJECT_INPUT_PX,
  MotionRootRoiGovernor,
  motionRoiModelInput,
  planMotionRootRoi,
  ROI_FORCED_FULL_INTERVAL_MS,
  ROI_IDLE_FORGET_MS,
  ROI_LIVE_BOX_MAX_AGE_MS,
  ROI_MAX_FRAME_FRACTION,
  ROI_MIN_FRAME_FRACTION,
  withRootSource,
} from '../motion-root-roi.js'
import type { ExecutableStep } from '../pipeline/tree-builder.js'

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
    gov.noteRootRun(4, { source: 'full', shed: false, boxes: [PERSON] }, 0)
    expect(decide(1_500)).toMatchObject({ reason: 'forced-full' })
    expect(decide(1_600)).toMatchObject({ source: 'roi', reason: 'motion' })
    expect(decide(ROI_LIVE_BOX_MAX_AGE_MS + 100)).toMatchObject({
      source: 'full',
      reason: 'no-motion',
    })
  })
})

// A person near the camera: ~400x1000 native px — about 330 px tall once the
// 1915-px crop is scaled into the 640 input, the scale the int8 model fails at.
const NEAR_PERSON = { x: 2000 / 4256, y: 600 / 1888, w: 400 / 4256, h: 1000 / 1888 }

describe('planMotionRootRoi — subject-scale bound', () => {
  it('a large recent box runs the full frame instead of being magnified', () => {
    expect(MAX_SUBJECT_INPUT_PX).toBe(150)
    expect(
      planMotionRootRoi({ motion: [], liveBoxes: [NEAR_PERSON], frame: FRAME, modelInput: MODEL }),
    ).toEqual({ source: 'full', reason: 'subject-too-large' })
  })

  it('a ~100x290 box stays under the bound and is cropped', () => {
    const plan = planMotionRootRoi({
      motion: [],
      liveBoxes: [PERSON],
      frame: FRAME,
      modelInput: MODEL,
    })
    expect(plan.source).toBe('roi')
  })

  it('the bound reads the root boxes, not the motion subjects', () => {
    // A large motion blob alone is not a subject the model sized.
    const plan = planMotionRootRoi({
      motion: [NEAR_PERSON],
      liveBoxes: [],
      frame: FRAME,
      modelInput: MODEL,
    })
    expect(plan.source).toBe('roi')
  })
})

describe('MotionRootRoiGovernor — what a frame leaves behind', () => {
  const decideAt = (gov: MotionRootRoiGovernor, deviceId: number, now: number) =>
    gov.decide({ deviceId, now, motion: [PERSON], frame: FRAME, modelInput: MODEL })

  it('a large subject seen on a full frame keeps getting the full frame', () => {
    const gov = new MotionRootRoiGovernor()
    expect(decideAt(gov, 5, 0)).toMatchObject({ reason: 'forced-full' })
    gov.noteRootRun(5, { source: 'full', shed: false, boxes: [NEAR_PERSON] }, 0)
    expect(decideAt(gov, 5, 100)).toMatchObject({ source: 'full', reason: 'subject-too-large' })
    gov.noteRootRun(5, { source: 'full', shed: false, boxes: [NEAR_PERSON] }, 100)
    expect(decideAt(gov, 5, 200)).toMatchObject({ source: 'full', reason: 'subject-too-large' })
  })

  it('a crop that found nothing keeps the boxes and the next frame runs full', () => {
    const gov = new MotionRootRoiGovernor()
    decideAt(gov, 6, 0)
    gov.noteRootRun(6, { source: 'full', shed: false, boxes: [PERSON] }, 0)
    expect(decideAt(gov, 6, 100)).toMatchObject({ source: 'roi' })
    // The subject grew past what the crop can score and the crop missed it.
    gov.noteRootRun(6, { source: 'roi', shed: false, boxes: [] }, 100)
    expect(decideAt(gov, 6, 200)).toMatchObject({ source: 'full', reason: 'roi-missed' })
    // The full frame sees it large: the bound holds it on the full frame.
    gov.noteRootRun(6, { source: 'full', shed: false, boxes: [NEAR_PERSON] }, 200)
    expect(decideAt(gov, 6, 300)).toMatchObject({ source: 'full', reason: 'subject-too-large' })
  })

  it('a crop miss does not wipe the boxes that place a still subject', () => {
    const gov = new MotionRootRoiGovernor()
    const still = (now: number) =>
      gov.decide({ deviceId: 8, now, motion: [], frame: FRAME, modelInput: MODEL })
    still(0)
    gov.noteRootRun(8, { source: 'full', shed: false, boxes: [PERSON] }, 0)
    gov.noteRootRun(8, { source: 'roi', shed: false, boxes: [] }, 100)
    expect(still(150)).toMatchObject({ reason: 'roi-missed' })
    // Still in the crop on the frame after, not 'no-motion'.
    expect(still(250)).toMatchObject({ source: 'roi', reason: 'motion' })
  })

  it('an empty FULL frame clears the boxes', () => {
    const gov = new MotionRootRoiGovernor()
    const still = (now: number) =>
      gov.decide({ deviceId: 9, now, motion: [], frame: FRAME, modelInput: MODEL })
    still(0)
    gov.noteRootRun(9, { source: 'full', shed: false, boxes: [PERSON] }, 0)
    gov.noteRootRun(9, { source: 'full', shed: false, boxes: [] }, 100)
    expect(still(200)).toMatchObject({ source: 'full', reason: 'no-motion' })
  })

  it('a shed root frame (no inference ran) leaves the boxes alone', () => {
    const gov = new MotionRootRoiGovernor()
    const still = (now: number) =>
      gov.decide({ deviceId: 10, now, motion: [], frame: FRAME, modelInput: MODEL })
    still(0)
    gov.noteRootRun(10, { source: 'full', shed: false, boxes: [PERSON] }, 0)
    gov.noteRootRun(10, { source: 'full', shed: true, boxes: [] }, 100)
    expect(still(200)).toMatchObject({ source: 'roi', reason: 'motion' })
    gov.noteRootRun(10, { source: 'roi', shed: true, boxes: [] }, 300)
    // A shed crop is not a miss either.
    expect(still(400)).toMatchObject({ source: 'roi', reason: 'motion' })
  })

  it('a camera that stops sending frames is forgotten after the idle window', () => {
    const gov = new MotionRootRoiGovernor()
    decideAt(gov, 11, 0)
    gov.noteRootRun(11, { source: 'full', shed: false, boxes: [PERSON] }, 0)
    expect(gov.trackedCameraCount()).toBe(1)
    // Another camera's frame long after sweeps the idle one.
    decideAt(gov, 12, ROI_IDLE_FORGET_MS + 1)
    expect(gov.trackedCameraCount()).toBe(1)
    expect(decideAt(gov, 11, ROI_IDLE_FORGET_MS + 2)).toMatchObject({ reason: 'forced-full' })
  })
})

function odStep(
  extractMode: StepDefinition['extractMode'],
  stepId = 'object-detection',
): ExecutableStep {
  const def: StepDefinition = {
    id: stepId,
    name: stepId,
    slot: 'detector',
    postprocessor: 'yolo',
    extractMode,
    inputClasses: null,
    outputClasses: ['person'],
    models: [
      {
        id: 'm',
        name: 'm',
        description: '',
        formats: {},
        inputSize: { width: 640, height: 640 },
        preprocessMode: 'letterbox',
        labels: [{ id: '0', name: 'person' }],
      },
    ],
    defaultModelId: 'm',
    defaultConfidence: 0.1,
  }
  return {
    stepId,
    definition: def,
    engine: {
      runtime: 'onnx',
      device: 'cpu',
      infer: async () => ({ inferenceMs: 0 }),
      dispose: async () => {},
    },
    modelId: 'm',
    inputClasses: [],
    enabled: true,
    children: [],
  }
}

describe('motionRoiModelInput — which runs the provider lets the motion ROI decide', () => {
  const live = {
    hasFrameRef: true,
    plane: 'frame' as const,
    replay: false,
    hasSuppliedRoot: false,
    deviceId: 1441,
    roots: [odStep('full-frame')],
  }

  it('a live frame-plane run with a frameRef gets the root model input', () => {
    expect(motionRoiModelInput(live)).toEqual({ width: 640, height: 640 })
  })

  it('a replay keeps the full frame', () => {
    expect(motionRoiModelInput({ ...live, replay: true })).toBeUndefined()
  })

  it('a supplied root keeps the full frame', () => {
    expect(motionRoiModelInput({ ...live, hasSuppliedRoot: true })).toBeUndefined()
  })

  it('no frameRef, the full (benchmark) plane, or no device: full frame', () => {
    expect(motionRoiModelInput({ ...live, hasFrameRef: false })).toBeUndefined()
    expect(motionRoiModelInput({ ...live, plane: 'full' })).toBeUndefined()
    expect(motionRoiModelInput({ ...live, deviceId: 0 })).toBeUndefined()
  })

  it('a crop-zone object-detection root is never driven', () => {
    expect(motionRoiModelInput({ ...live, roots: [odStep('crop-zone')] })).toBeUndefined()
  })
})

describe('withRootSource — the trace names which pixels the root ran on', () => {
  const decision: RootInputSource = {
    stepId: 'object-detection',
    source: 'full',
    reason: 'forced-full',
  }
  it('stamps the decision on the trace', () => {
    expect(withRootSource({ deviceId: 1 }, decision)).toEqual({ deviceId: 1, rootSource: decision })
  })
  it('no decision, no stamp; no trace, nothing', () => {
    expect(withRootSource({ deviceId: 1 }, undefined)).toEqual({ deviceId: 1 })
    expect(withRootSource(undefined, decision)).toBeUndefined()
  })
})
