/**
 * D400 — the two picture complaints from the 2026-09-07 operator debug-track
 * audit, pinned with the audit's own tracks and numbers as fixtures.
 *
 * `docs/benchmarks/2026-09-08-operator-debug-track-audit.md`, Theme 4:
 *  - `5f5f0f6e` (device 3829): "il best shot è a bordo. C'è però una posizione
 *    più avanzata che non ci costringe a usare il bordo specchiato" [the best shot is on the edge. But there is a more advanced position that does not force us to use the mirrored edge] — the
 *    delivered 16:9 canvas needed 246 px of lateral fill while two later
 *    positions needed none, and NO ranking tier measured the delivered canvas.
 *  - `841f9b8e` (device 3829): "questi tagli hanno uno score troppo alto, non
 *    si vedono il dorso e testa" [these crops have too high a score, the back and head are not visible] — a person clipped at the top border lost
 *    5.2% of its score, because the penalty was scaled by the box's span across
 *    the FRAME rather than by the subject's own geometry.
 */

import { describe, expect, it } from 'vitest'
import {
  canvasFillFraction,
  centralSquareContainmentFraction,
  MAX_LETTERBOX_FRACTION,
} from '../../../shared/frame/wide-central-square-crop.js'
import {
  type BestFrameCandidate,
  CANVAS_FILL_MAX_PENALTY,
  CANVAS_FILL_TIE_BREAK_MARGIN,
  CLIP_ASPECT_FULL_PENALTY,
  CLIP_ASPECT_NO_PENALTY,
  CONTAINMENT_MAX_SIDE_PENALTY,
  bboxContainment,
  bboxSizeScore,
  clipPenaltyScale,
  compareBestFrame,
  isEdgeAwareNewBest,
} from '../edge-clear.js'

/** Every frame in the audit is 3840×2160 (`ObjectEvent.frameWidth/Height`). */
const FRAME_4K = { W: 3840, H: 2160 }
const W = FRAME_4K.W
const H = FRAME_4K.H

// ── Track 5f5f0f6e, device 3829 — the positions the audit measured ───────
/** The SHIPPED best shot: the birth frame, 9.6 px from the left border. */
const SHIPPED_5F5F0F6E = { x: 9.6, y: 404.4, w: 357.6, h: 633.6 }
/** +1534 ms — one of the two later positions the operator pointed at: the
 *  audit measured ZERO lateral fill for it, and it is edge-clear. */
const LATER_5F5F0F6E = { x: 1600, y: 380, w: 383, h: 679.2 }

// ── Track 841f9b8e, device 3829 — the shipped best shot ──────────────────
/** +233 ms, confidence 0.832, y = 0 on every one of the track's three
 *  positions: an upright person with the head cut off by the top border. */
const CLIPPED_841F9B8E = { x: 1244.4, y: 0, w: 399.6, h: 424.8 }

describe('D400 — clipPenaltyScale re-bases the clipping penalty on the subject', () => {
  it('a remnant square-or-squatter against the cut axis is fully penalised', () => {
    expect(clipPenaltyScale(100, 100)).toBe(1)
    expect(clipPenaltyScale(40, 100)).toBe(1)
    expect(clipPenaltyScale(CLIP_ASPECT_FULL_PENALTY * 100, 100)).toBe(1)
  })

  it('a remnant well elongated along the cut axis is not penalised at all', () => {
    expect(clipPenaltyScale(CLIP_ASPECT_NO_PENALTY * 100, 100)).toBe(0)
    expect(clipPenaltyScale(1000, 100)).toBe(0)
  })

  it('ramps linearly between the two aspects', () => {
    const mid = (CLIP_ASPECT_FULL_PENALTY + CLIP_ASPECT_NO_PENALTY) / 2
    expect(clipPenaltyScale(mid * 100, 100)).toBeCloseTo(0.5, 6)
  })

  it('a degenerate (zero-extent) box reads as fully truncated, never as intact', () => {
    expect(clipPenaltyScale(100, 0)).toBe(1)
  })

  it('is scale- and frame-invariant: only the aspect matters', () => {
    expect(clipPenaltyScale(424.8, 399.6)).toBeCloseTo(clipPenaltyScale(42.48, 39.96), 12)
  })
})

describe('D400 — bboxContainment on track 841f9b8e (the operator complaint)', () => {
  it('a decapitated person now loses far more than the 5.2% the audit measured', () => {
    const containment = bboxContainment(CLIPPED_841F9B8E, W, H)
    // The audit's number for the OLD shape: 1 - 0.5 * (399.6/3840) = 0.948.
    expect(containment).toBeLessThan(0.6)
    // Ramp: aspect = 424.8/399.6 = 1.063 → scale ≈ 0.958 → 1 - 0.5*0.958.
    expect(containment).toBeCloseTo(
      1 - CONTAINMENT_MAX_SIDE_PENALTY * clipPenaltyScale(424.8, 399.6),
      6,
    )
  })

  it('drops the composite score the operator called too high, on the audit numbers', () => {
    const confidence = 0.832
    const sizeScore = bboxSizeScore(CLIPPED_841F9B8E, W, H)
    const composite = confidence * bboxContainment(CLIPPED_841F9B8E, W, H) * (0.5 + 0.5 * sizeScore)
    // The audit computed 0.573 for the shipped shape.
    expect(composite).toBeLessThan(0.4)
  })

  it('KEEPS the case the old shape was built for: a wide subject cut off at the bottom', () => {
    // The old docblock's own rationale — "a wide bbox flush to the top/bottom
    // … is heavily penalised" — which the old arithmetic did not actually
    // deliver: 900/3840 span meant it only lost 11.7%.
    const wideVehicle = { x: 1000, y: 1760, w: 900, h: 400 }
    const containment = bboxContainment(wideVehicle, W, H)
    expect(containment).toBeLessThan(1 - CONTAINMENT_MAX_SIDE_PENALTY * 0.9)
    expect(containment).toBeLessThanOrEqual(0.883) // strictly heavier than before
  })

  it('KEEPS a whole upright person standing on the bottom border unpenalised', () => {
    const standing = { x: 1800, y: 1360, w: 320, h: 800 }
    expect(bboxContainment(standing, W, H)).toBe(1)
  })

  it('a tall subject half out the SIDE is heavily penalised (the roles swap)', () => {
    const halfOutTheSide = { x: 0, y: 600, w: 180, h: 900 }
    expect(bboxContainment(halfOutTheSide, W, H)).toBeLessThan(0.6)
  })
})

describe('D400 — canvasFillFraction measures the DELIVERED 16:9 canvas', () => {
  it('the shipped 5f5f0f6e best shot still needs a synthesized band — a capped one now', () => {
    const fill = canvasFillFraction(SHIPPED_5F5F0F6E, FRAME_4K)
    // The audit reported 246.4 px against a 1126.4 px canvas ≈ 21.9%, and this
    // test asserted that fifth until 2026-09-08. `MAX_LETTERBOX_FRACTION`
    // narrows the canvas rather than pay it, so the same frame now composes at
    // ~8.8%: the fill is REAL and it is smaller, which is the change working.
    //
    // What the test still pins is the SIGNAL — this frame costs canvas where a
    // clean one costs none — because that is what the best-shot term reads.
    // Its dynamic range is bounded by the cap now, so a future widening of the
    // cap must be seen here rather than absorbed silently.
    expect(fill).toBeGreaterThan(0.05)
    expect(fill).toBeLessThanOrEqual(MAX_LETTERBOX_FRACTION)
    expect(fill).toBeGreaterThan(canvasFillFraction(LATER_5F5F0F6E, FRAME_4K))
  })

  it('the later position the operator pointed at needs no fill at all', () => {
    expect(canvasFillFraction(LATER_5F5F0F6E, FRAME_4K)).toBe(0)
  })

  it('the shipped frame is ALSO square-evicted — the audit fixture, both facts', () => {
    // Recorded so a future change that "fixes" the fill cannot quietly break
    // the square-containment tier's own reading of this same frame.
    expect(centralSquareContainmentFraction(SHIPPED_5F5F0F6E, FRAME_4K)).toBeLessThan(0.5)
  })

  it('a small central subject never needs fill — which is why fill is not a tier', () => {
    const tinyDistant = { x: 1900, y: 1000, w: 40, h: 100 }
    expect(canvasFillFraction(tinyDistant, FRAME_4K)).toBe(0)
    const bigClose = { x: 60, y: 200, w: 700, h: 1400 }
    // The close subject's canvas is far likelier to overflow: a hard "no fill
    // beats fill" tier would hand the best shot to the distant speck.
    expect(canvasFillFraction(bigClose, FRAME_4K)).toBeGreaterThan(0)
  })

  it('never exceeds the 1 - 9/16 ceiling', () => {
    for (const bbox of [SHIPPED_5F5F0F6E, CLIPPED_841F9B8E, { x: 0, y: 0, w: 300, h: 2160 }]) {
      expect(canvasFillFraction(bbox, FRAME_4K)).toBeLessThanOrEqual(1 - 9 / 16)
    }
  })
})

const base: BestFrameCandidate = { confidence: 0.6, edgeClear: false }

describe('D400 — where the canvas-fill term sits in the preference order', () => {
  it('never overturns a SQUARE-containment tier: a delivered subject beats a clean canvas', () => {
    const evictedButUnfilled: BestFrameCandidate = {
      ...base,
      squareFraction: 0.1,
      canvasFill: 0,
    }
    const containedButFilled: BestFrameCandidate = {
      ...base,
      squareFraction: 1,
      canvasFill: 0.4,
    }
    expect(isEdgeAwareNewBest(containedButFilled, evictedButUnfilled, 0.05)).toBe(false)
    expect(compareBestFrame(containedButFilled, evictedButUnfilled, 0.05).decidedBy).toBe(
      'square-containment',
    )
  })

  it('never overturns the SEMANTIC tier', () => {
    const semanticFilled: BestFrameCandidate = { ...base, semantic: true, canvasFill: 0.4 }
    const plainUnfilled: BestFrameCandidate = { ...base, semantic: false, canvasFill: 0 }
    expect(isEdgeAwareNewBest(semanticFilled, plainUnfilled, 0.05)).toBe(false)
    expect(compareBestFrame(semanticFilled, plainUnfilled, 0.05).decidedBy).toBe('semantic')
  })

  it('never overturns the EDGE-CLEAR tier', () => {
    const clearFilled: BestFrameCandidate = { ...base, edgeClear: true, canvasFill: 0.4 }
    const touchingUnfilled: BestFrameCandidate = { ...base, edgeClear: false, canvasFill: 0 }
    expect(isEdgeAwareNewBest(clearFilled, touchingUnfilled, 0.05)).toBe(false)
    expect(compareBestFrame(clearFilled, touchingUnfilled, 0.05).decidedBy).toBe('edge-clear')
  })

  it('DOES break a within-tier near-equal tie — the fix the complaint asked for', () => {
    const held: BestFrameCandidate = { ...base, canvasFill: 0.22, centerScore: 0.9 }
    const cleaner: BestFrameCandidate = { ...base, canvasFill: 0, centerScore: 0.9 }
    const verdict = compareBestFrame(held, cleaner, 0.05)
    expect(verdict.accepted).toBe(true)
    // Note the term: this is the number that says whether the new term has
    // started DOMINATING rather than tie-breaking.
    expect(verdict.decidedBy).toBe('canvas-fill')
  })

  it('is ranked ABOVE centeredness — a measurement of the canvas beats a proxy for it', () => {
    const held: BestFrameCandidate = { ...base, canvasFill: 0.3, centerScore: 0.2 }
    const betterCentredButFilled: BestFrameCandidate = {
      ...base,
      canvasFill: 0.3,
      centerScore: 0.9,
    }
    expect(compareBestFrame(held, betterCentredButFilled, 0.05).decidedBy).toBe('centeredness')
    const cleanerCanvasWorseCentred: BestFrameCandidate = {
      ...base,
      canvasFill: 0,
      centerScore: 0.2,
    }
    expect(compareBestFrame(held, cleanerCanvasWorseCentred, 0.05).decidedBy).toBe('canvas-fill')
  })

  it('needs a real fill improvement, not rounding, to fire the tie-break', () => {
    const held: BestFrameCandidate = { ...base, canvasFill: 0.1, centerScore: 0.5 }
    const barely: BestFrameCandidate = {
      ...base,
      canvasFill: 0.1 - CANVAS_FILL_TIE_BREAK_MARGIN / 2,
      centerScore: 0.5,
    }
    expect(compareBestFrame(held, barely, 0.05).accepted).toBe(false)
  })

  it('is INERT for callers that do not measure it (face / object-embedding paths)', () => {
    const a: BestFrameCandidate = { confidence: 0.6, edgeClear: true }
    const b: BestFrameCandidate = { confidence: 0.6, edgeClear: true }
    expect(isEdgeAwareNewBest(a, b, 0.05)).toBe(false)
    expect(compareBestFrame(a, b, 0.05).currentScore).toBe(0.6)
  })

  it('is BOUNDED: it can never move an effective score by more than 6.6%', () => {
    // The real fill ceiling is 1 - 9/16; anything above that is unreachable
    // while the central square is in frame.
    const worst = CANVAS_FILL_MAX_PENALTY * (1 - 9 / 16)
    expect(worst).toBeLessThan(0.07)
    const filled: BestFrameCandidate = { ...base, canvasFill: 1 - 9 / 16, centerScore: 0.5 }
    const clean: BestFrameCandidate = { ...base, canvasFill: 0, centerScore: 0.5 }
    const verdict = compareBestFrame(filled, clean, 0)
    expect(verdict.candidateScore - verdict.currentScore).toBeCloseTo(0.6 * worst, 6)
  })

  it('cannot overturn a decisive lead: a 10% better candidate wins even fully filled', () => {
    const held: BestFrameCandidate = { ...base, confidence: 0.6, canvasFill: 0, centerScore: 0.5 }
    const better: BestFrameCandidate = {
      ...base,
      confidence: 0.66,
      canvasFill: 1 - 9 / 16,
      centerScore: 0.5,
    }
    expect(compareBestFrame(held, better, 0).accepted).toBe(true)
    expect(compareBestFrame(held, better, 0).decidedBy).toBe('effective-score')
  })
})

describe('D400 — compareBestFrame names the term that decided', () => {
  it('isEdgeAwareNewBest is exactly compareBestFrame().accepted (one ordering, no copy)', () => {
    const candidates: readonly BestFrameCandidate[] = [
      { confidence: 0.3, edgeClear: false },
      { confidence: 0.9, edgeClear: true, semantic: true },
      { confidence: 0.5, edgeClear: true, squareFraction: 0.2 },
      { confidence: 0.7, edgeClear: false, canvasFill: 0.3, centerScore: 0.4 },
      { confidence: 0.7, edgeClear: false, canvasFill: 0, centerScore: 0.4 },
    ]
    for (const a of candidates)
      for (const b of candidates)
        expect(isEdgeAwareNewBest(a, b, 0.05)).toBe(compareBestFrame(a, b, 0.05).accepted)
  })

  it('carries both effective scores so a log line holds the numbers, not just a name', () => {
    const held: BestFrameCandidate = { confidence: 0.4, edgeClear: true }
    const cand: BestFrameCandidate = { confidence: 0.8, edgeClear: true }
    const verdict = compareBestFrame(held, cand, 0.05)
    expect(verdict.currentScore).toBeCloseTo(0.4, 6)
    expect(verdict.candidateScore).toBeCloseTo(0.8, 6)
  })
})
