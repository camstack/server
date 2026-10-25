/**
 * The gate that the native-crop path must not be able to talk its way past.
 *
 * SCRFD regresses the 5 landmarks in the DETECTION frame. The alignment warp
 * consumes those landmarks, so the landmark precision — and therefore whether
 * the 112×112 crop handed to ArcFace is a face at all — is bounded by the
 * face's size in THAT space. Cutting the crop from the native surface hands the
 * embedder more pixels, which is a real win, but it cannot make a landmark
 * regressed on a 12 px face any more accurate.
 *
 * `executor.ts` had exactly one size gate and it did
 * `gateShortSide = aligned.nativeFaceShortSidePx ?? detShortSide` — the native
 * measurement REPLACES the detection one the moment the native path succeeds.
 * Measured 2026-08-19 over the 60 most recent live crops, that is why the
 * existing 48 px floor never caught any of this: every outcome cleared it, and
 * the native size did not separate the outcomes at all (aligned 113 px vs
 * no-face-at-all 83 px), while the detection size separated them monotonically
 * (28.2 px vs 16.5 px).
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LANDMARK_PRECISION_FLOOR_PX,
  landmarkPrecisionVerdict,
} from '../landmark-precision-gate.js'
import { getStep } from '../../registry/step-definitions.js'

describe('landmarkPrecisionVerdict', () => {
  it('refuses a 20px detection face even when the native crop is 100px', () => {
    // THE case the shipped code passes today: native rescues it, landmarks do not.
    const v = landmarkPrecisionVerdict({
      detectionShortSidePx: 20,
      nativeShortSidePx: 100,
      floorPx: DEFAULT_LANDMARK_PRECISION_FLOOR_PX,
    })
    expect(v).not.toBeNull()
    expect(v?.detectionShortSidePx).toBe(20)
    expect(v?.floorPx).toBe(24)
  })

  it('admits a 25px detection face', () => {
    expect(
      landmarkPrecisionVerdict({
        detectionShortSidePx: 25,
        nativeShortSidePx: 100,
        floorPx: DEFAULT_LANDMARK_PRECISION_FLOOR_PX,
      }),
    ).toBeNull()
  })

  it('admits exactly at the floor', () => {
    expect(landmarkPrecisionVerdict({ detectionShortSidePx: 24, floorPx: 24 })).toBeNull()
  })

  it('ignores the native size entirely — it is not an input to the decision', () => {
    const withNative = landmarkPrecisionVerdict({
      detectionShortSidePx: 20,
      nativeShortSidePx: 4000,
      floorPx: 24,
    })
    const withoutNative = landmarkPrecisionVerdict({ detectionShortSidePx: 20, floorPx: 24 })
    expect(withNative).toEqual(withoutNative)
  })

  it('is disabled by a floor of 0 — an operator can turn it off entirely', () => {
    expect(landmarkPrecisionVerdict({ detectionShortSidePx: 1, floorPx: 0 })).toBeNull()
  })

  it('defaults to the operator-chosen 24px', () => {
    expect(DEFAULT_LANDMARK_PRECISION_FLOOR_PX).toBe(24)
  })

  it('separates the measured aligned and no-face medians', () => {
    // 28.2px = median of the crops that came out aligned; 16.5px = median of the
    // crops containing no detectable face at all.
    expect(landmarkPrecisionVerdict({ detectionShortSidePx: 28.2, floorPx: 24 })).toBeNull()
    expect(landmarkPrecisionVerdict({ detectionShortSidePx: 16.5, floorPx: 24 })).not.toBeNull()
  })
})

/**
 * The wiring pin. The gate is only real if the floor actually reaches
 * `child.settings` — a knob that renders a slider nobody reads is exactly the
 * failure mode this repo has shipped before (`trackTtlMs`, `mediaAttachPolicy`).
 */
describe('the floor reaches the executor through the step schema', () => {
  it('face-embedding declares minLandmarkFaceSize with the shared default', () => {
    const field = getStep('face-embedding')
      .getConfigSchema()
      .find((f) => 'key' in f && f.key === 'minLandmarkFaceSize')
    expect(field, 'face-embedding must expose the floor as an operator knob').toBeDefined()
    expect(field && 'default' in field ? field.default : undefined).toBe(
      DEFAULT_LANDMARK_PRECISION_FLOOR_PX,
    )
  })
})
