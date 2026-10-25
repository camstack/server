/**
 * Which root detector runs for a camera, and how the camera's own boxes are
 * paired with a decoded frame.
 *
 * The property that matters: an onboard detection is a statement about an
 * INSTANT, and giving it pixels means pairing it with a frame that is not
 * exactly that instant. The pairing is bounded and the expiry is reported —
 * a stale box painted onto a fresh frame is a lie the tracker cannot detect.
 */
import { describe, expect, it } from 'vitest'
import {
  ONBOARD_PAIRING_MAX_AGE_MS,
  onboardRootDetections,
  planDetectionSources,
  type OnboardDetectionSlot,
} from '../detection-source-plan.js'

describe('planDetectionSources', () => {
  it('an absent list is the pipeline — a runner older than the field behaves as it always did', () => {
    expect(planDetectionSources(undefined)).toEqual({ runsPipeline: true, runsOnboard: false })
  })

  it('an EMPTY list is not "everything": it is a camera with no root detector', () => {
    expect(planDetectionSources([])).toEqual({ runsPipeline: false, runsOnboard: false })
  })

  it('onboard alone replaces the root step — the accelerator is not asked', () => {
    expect(planDetectionSources(['onboard'])).toEqual({ runsPipeline: false, runsOnboard: true })
  })

  it('both run, and they meet on ONE frame result', () => {
    expect(planDetectionSources(['pipeline', 'onboard'])).toEqual({
      runsPipeline: true,
      runsOnboard: true,
    })
  })
})

const slot = (atMs: number): OnboardDetectionSlot => ({
  at: atMs,
  frameWidth: 1920,
  frameHeight: 1080,
  detections: [{ class: 'person', timestamp: atMs, bbox: [0.25, 0.5, 0.1, 0.2] }],
})

describe('onboardRootDetections', () => {
  it('denormalises against the DECODED frame, not a nominal size', () => {
    const out = onboardRootDetections(slot(1_000), { timestamp: 1_050, width: 640, height: 360 })
    expect(out.kind).toBe('paired')
    if (out.kind !== 'paired') return
    expect(out.detections[0]?.bbox).toEqual({ x: 160, y: 180, width: 64, height: 72 })
  })

  it('refuses a box older than the pairing window and says so', () => {
    const out = onboardRootDetections(slot(1_000), {
      timestamp: 1_000 + ONBOARD_PAIRING_MAX_AGE_MS + 1,
      width: 640,
      height: 360,
    })
    expect(out).toEqual({ kind: 'expired', ageMs: ONBOARD_PAIRING_MAX_AGE_MS + 1 })
  })

  it('pairs a box the camera reported slightly AFTER the frame — clock skew cuts both ways', () => {
    const out = onboardRootDetections(slot(1_100), { timestamp: 1_000, width: 640, height: 360 })
    expect(out.kind).toBe('paired')
  })

  it('an empty slot is nothing to pair, not an expiry', () => {
    expect(onboardRootDetections(null, { timestamp: 1, width: 8, height: 8 })).toEqual({
      kind: 'none',
    })
  })

  it('drops a flag-only push: a root step with no geometry has nothing to track', () => {
    const flagOnly: OnboardDetectionSlot = {
      at: 1_000,
      detections: [{ class: 'person', timestamp: 1_000 }],
    }
    expect(onboardRootDetections(flagOnly, { timestamp: 1_010, width: 8, height: 8 })).toEqual({
      kind: 'no-geometry',
      classes: ['person'],
    })
  })

  it('clamps a box the firmware reported past the frame edge', () => {
    const over: OnboardDetectionSlot = {
      at: 1_000,
      detections: [{ class: 'vehicle', timestamp: 1_000, bbox: [0.9, 0.9, 0.5, 0.5] }],
    }
    const out = onboardRootDetections(over, { timestamp: 1_000, width: 100, height: 100 })
    expect(out.kind).toBe('paired')
    if (out.kind !== 'paired') return
    const b = out.detections[0]!.bbox
    expect(b.x + b.width).toBeLessThanOrEqual(100)
    expect(b.y + b.height).toBeLessThanOrEqual(100)
  })
})
