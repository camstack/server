/**
 * The best FACE a track keeps used to be chosen on DETECTION CONFIDENCE alone.
 * SCRFD saturates its confidence on surveillance footage — a 12 px face scores
 * 0.9 as readily as a 40 px one — so the crop that reached ArcFace was
 * routinely not the most informative one the track ever offered.
 *
 * What actually bounds the quality of that crop is the face's size **in the
 * detection frame**, because that is the space the 5 landmarks were regressed
 * in, and the landmark precision is what the alignment warp consumes. Native
 * resolution gives the embedder more pixels but does NOT make a landmark
 * regressed on a 12 px face any more accurate.
 *
 * Measured 2026-08-19 on 60 live crops pulled from the hub: crops that came out
 * correctly aligned had a median detection-frame face of 28.2 px; the ones with
 * no detectable face at all had 16.5 px. `nativeFaceShortSidePx` — the number
 * the existing gate uses — did NOT separate them (113 px vs 83 px, both far
 * above the 48 px floor).
 */
import { describe, expect, it } from 'vitest'
import { BestDetectionTracker } from '../best-detection-tracker.js'
import { BEST_FACE_POLICY } from '../best-selection-policies.js'
import { faceSizeScore, FACE_SIZE_SCORE_REFERENCE_PX } from '../face-size-score.js'

describe('faceSizeScore', () => {
  it('saturates at the reference size and above', () => {
    expect(faceSizeScore(FACE_SIZE_SCORE_REFERENCE_PX)).toBe(1)
    expect(faceSizeScore(FACE_SIZE_SCORE_REFERENCE_PX * 4)).toBe(1)
  })

  it('is proportional below the reference', () => {
    expect(faceSizeScore(FACE_SIZE_SCORE_REFERENCE_PX / 2)).toBeCloseTo(0.5, 6)
  })

  it('floors at 0 for a degenerate or missing measurement', () => {
    expect(faceSizeScore(0)).toBe(0)
    expect(faceSizeScore(-5)).toBe(0)
    expect(faceSizeScore(Number.NaN)).toBe(0)
  })

  it('ranks the measured aligned/unaligned medians apart', () => {
    // 28.2 px (aligned median) must score meaningfully above 16.5 px (no-face median).
    expect(faceSizeScore(28.2) - faceSizeScore(16.5)).toBeGreaterThan(0.3)
  })
})

describe('BEST_FACE_POLICY', () => {
  it('is size-aware, so the held best face is not chosen on saturated confidence alone', () => {
    expect(BEST_FACE_POLICY.sizeAware).toBe(true)
  })

  it('keeps hysteresis and the rate limit off — buffering a crop is cheap', () => {
    expect(BEST_FACE_POLICY.hysteresis).toBe(0)
    expect(BEST_FACE_POLICY.minGapMs).toBe(0)
  })
})

/**
 * The composed pin: with the real policy, a BIG face must be able to displace a
 * held small face that scored higher on SCRFD's saturated confidence. Remove
 * `sizeAware: true` (or stop passing the score at the call site) and this fails
 * — which is what makes it a test of the fix rather than of the constant.
 */
describe('best-face ranking with the real policy', () => {
  const TRACK = 't1'

  it('a 32px face at 0.80 displaces a held 12px face at 0.95', () => {
    const tracker = new BestDetectionTracker(BEST_FACE_POLICY)
    expect(
      tracker.observe(TRACK, 0.95, 1_000, undefined, undefined, undefined, faceSizeScore(12)),
    ).toBe(true)
    // effective: held 0.95×(0.5+0.5×0.375)=0.653 ; cand 0.80×1.0=0.800 → wins
    expect(
      tracker.observe(TRACK, 0.8, 2_000, undefined, undefined, undefined, faceSizeScore(32)),
    ).toBe(true)
  })

  it('a tiny face does NOT displace a held big one on confidence alone', () => {
    const tracker = new BestDetectionTracker(BEST_FACE_POLICY)
    tracker.observe(TRACK, 0.8, 1_000, undefined, undefined, undefined, faceSizeScore(32))
    // effective: held 0.800 ; cand 0.95×(0.5+0.5×0.375)=0.653 → loses
    expect(
      tracker.observe(TRACK, 0.95, 2_000, undefined, undefined, undefined, faceSizeScore(12)),
    ).toBe(false)
  })

  it('an unmeasurable face (no faceBbox ⇒ score 0) never displaces a measured one', () => {
    const tracker = new BestDetectionTracker(BEST_FACE_POLICY)
    tracker.observe(TRACK, 0.6, 1_000, undefined, undefined, undefined, faceSizeScore(32))
    expect(
      tracker.observe(TRACK, 0.99, 2_000, undefined, undefined, undefined, faceSizeScore(0)),
    ).toBe(false)
  })
})
